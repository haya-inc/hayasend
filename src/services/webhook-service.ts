import { createId, createWebhookSecret, signWebhook } from "../core/crypto.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import {
  assertPublicWebhookEndpoint,
  assertWebhookEndpointShape,
  createSafeWebhookFetch,
  type WebhookHttpClient,
} from "../core/network-safety.js";
import type {
  EmailRecord,
  Page,
  PublicWebhookEndpoint,
  WebhookEndpoint,
  WebhookEvent,
  WebhookEventType,
} from "../core/types.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { Store } from "../ports/store.js";

const SUPPORTED_EVENTS = new Set<WebhookEventType>([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
]);

export interface WebhookServiceOptions {
  httpFetch?: WebhookHttpClient;
  validateEndpoint?: (endpoint: URL) => Promise<void>;
}

export function publicWebhook(
  webhook: WebhookEndpoint,
): PublicWebhookEndpoint {
  const { signing_secret: _secret, ...result } = webhook;
  return result;
}

export class WebhookService {
  private readonly httpFetch: WebhookHttpClient;
  private readonly validateEndpoint: (
    endpoint: URL,
  ) => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly queue: JobQueue,
    options: WebhookServiceOptions = {},
  ) {
    this.httpFetch = options.httpFetch ?? createSafeWebhookFetch();
    this.validateEndpoint =
      options.validateEndpoint ?? assertPublicWebhookEndpoint;
  }

  async create(input: {
    endpoint: string;
    events: WebhookEventType[];
  }): Promise<{
    webhook: PublicWebhookEndpoint;
    signing_secret: string;
  }> {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new ValidationError("endpoint must be a valid URL.");
    }
    assertWebhookEndpointShape(endpoint);
    if (input.events.length === 0) {
      throw new ValidationError("At least one webhook event is required.");
    }
    const invalidEvent = input.events.find(
      (event) => !SUPPORTED_EVENTS.has(event),
    );
    if (invalidEvent) {
      throw new ValidationError(`Unsupported webhook event: ${invalidEvent}`);
    }
    await this.validateEndpoint(endpoint);

    const record: WebhookEndpoint = {
      id: createId("wh"),
      endpoint: endpoint.toString(),
      events: [...new Set(input.events)],
      signing_secret: createWebhookSecret(),
      status: "enabled",
      created_at: new Date().toISOString(),
    };
    await this.store.createWebhook(record);
    return {
      webhook: publicWebhook(record),
      signing_secret: record.signing_secret,
    };
  }

  async get(id: string): Promise<PublicWebhookEndpoint> {
    const record = await this.store.getWebhook(id);
    if (!record) {
      throw new NotFoundError("Webhook");
    }
    return publicWebhook(record);
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<PublicWebhookEndpoint>> {
    const page = await this.store.listWebhooks(limit, cursor);
    return { ...page, data: page.data.map(publicWebhook) };
  }

  async delete(id: string): Promise<void> {
    if (!(await this.store.deleteWebhook(id))) {
      throw new NotFoundError("Webhook");
    }
  }

  async publish(
    type: WebhookEventType,
    email: EmailRecord,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.publishData(type, {
      created_at: email.created_at,
      email_id: email.id,
      from: email.from,
      to: email.to,
      subject: email.subject,
      ...extra,
    });
  }

  async publishData(
    type: WebhookEventType,
    data: WebhookEvent["data"],
  ): Promise<void> {
    const event: WebhookEvent = {
      type,
      created_at: new Date().toISOString(),
      data,
    };
    let cursor: string | undefined;
    do {
      const webhooks = await this.store.listWebhooks(100, cursor);
      await Promise.all(
        webhooks.data
          .filter(
            (webhook) =>
              webhook.status === "enabled" && webhook.events.includes(type),
          )
          .map((webhook) =>
            this.queue.enqueue({
              type: "deliver_webhook",
              webhook_id: webhook.id,
              event,
            }),
          ),
      );
      cursor = webhooks.next_cursor;
    } while (cursor);
  }

  async deliver(webhookId: string, event: WebhookEvent): Promise<void> {
    const webhook = await this.store.getWebhook(webhookId);
    if (!webhook || webhook.status !== "enabled") {
      return;
    }
    const payload = JSON.stringify(event);
    const id = createId("msg");
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const response = await this.httpFetch(webhook.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "HayaSend-Webhooks/0.1.0",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signWebhook(
          webhook.signing_secret,
          id,
          timestamp,
          payload,
        ),
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `Webhook ${webhook.id} returned HTTP ${response.status}.`,
      );
    }
  }
}
