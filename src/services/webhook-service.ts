import { createId, createWebhookSecret, signWebhook } from "../core/crypto.js";
import { safeFailureMessage } from "../core/error-telemetry.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import {
  assertPublicWebhookEndpoint,
  assertWebhookEndpointShape,
  createSafeWebhookFetch,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../core/network-safety.js";
import type {
  EmailRecord,
  Page,
  PublicWebhookEndpoint,
  WebhookDeliveryRecord,
  WebhookDeliverySummary,
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
  deliveryRetentionDays?: number;
  now?: () => Date;
}

export function publicWebhook(
  webhook: WebhookEndpoint,
): PublicWebhookEndpoint {
  const { signing_secret: _secret, ...result } = webhook;
  return result;
}

function deliverySummary(
  delivery: WebhookDeliveryRecord,
): WebhookDeliverySummary {
  const { event: _event, ...summary } = delivery;
  return { object: "webhook_delivery", ...summary };
}

export class WebhookService {
  private readonly httpFetch: WebhookHttpClient;
  private readonly validateEndpoint: (
    endpoint: URL,
  ) => Promise<void>;
  private readonly deliveryRetentionDays: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly queue: JobQueue,
    options: WebhookServiceOptions = {},
  ) {
    this.httpFetch = options.httpFetch ?? createSafeWebhookFetch();
    this.validateEndpoint =
      options.validateEndpoint ?? assertPublicWebhookEndpoint;
    this.deliveryRetentionDays = options.deliveryRetentionDays ?? 7;
    this.now = options.now ?? (() => new Date());
    if (
      !Number.isInteger(this.deliveryRetentionDays) ||
      this.deliveryRetentionDays < 1 ||
      this.deliveryRetentionDays > 30
    ) {
      throw new ValidationError(
        "Webhook delivery retention must be between 1 and 30 days.",
      );
    }
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

  async update(
    id: string,
    input: {
      endpoint?: string | undefined;
      events?: WebhookEventType[] | undefined;
      status?: WebhookEndpoint["status"] | undefined;
    },
  ): Promise<PublicWebhookEndpoint> {
    const current = await this.store.getWebhook(id);
    if (!current) {
      throw new NotFoundError("Webhook");
    }
    if (
      input.endpoint === undefined &&
      input.events === undefined &&
      input.status === undefined
    ) {
      throw new ValidationError("At least one webhook field is required.");
    }

    const updates: Partial<
      Pick<WebhookEndpoint, "endpoint" | "events" | "status">
    > = {};
    if (input.events !== undefined) {
      if (input.events.length === 0) {
        throw new ValidationError(
          "At least one webhook event is required.",
        );
      }
      const invalidEvent = input.events.find(
        (event) => !SUPPORTED_EVENTS.has(event),
      );
      if (invalidEvent) {
        throw new ValidationError(
          `Unsupported webhook event: ${invalidEvent}`,
        );
      }
      updates.events = [...new Set(input.events)];
    }
    if (input.endpoint !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(input.endpoint);
      } catch {
        throw new ValidationError("endpoint must be a valid URL.");
      }
      assertWebhookEndpointShape(parsed);
      await this.validateEndpoint(parsed);
      updates.endpoint = parsed.toString();
    }
    if (input.status !== undefined) {
      updates.status = input.status;
    }

    const updated = await this.store.updateWebhook(id, updates);
    if (!updated) {
      throw new NotFoundError("Webhook");
    }
    return publicWebhook(updated);
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
      ...(email.provider_id ? { message_id: email.provider_id } : {}),
    });
  }

  async publishData(
    type: WebhookEventType,
    data: WebhookEvent["data"],
  ): Promise<void> {
    const event: WebhookEvent = {
      type,
      created_at: this.now().toISOString(),
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
            this.enqueueDelivery(webhook.id, event),
          ),
      );
      cursor = webhooks.next_cursor;
    } while (cursor);
  }

  async listDeliveries(
    webhookId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<WebhookDeliverySummary>> {
    await this.get(webhookId);
    const page = await this.store.listWebhookDeliveries(
      webhookId,
      limit,
      cursor,
    );
    return { ...page, data: page.data.map(deliverySummary) };
  }

  async getDelivery(
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryRecord> {
    await this.get(webhookId);
    const delivery = await this.store.getWebhookDelivery(deliveryId);
    if (!delivery || delivery.webhook_id !== webhookId) {
      throw new NotFoundError("Webhook delivery");
    }
    return delivery;
  }

  async replay(
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliverySummary> {
    const webhook = await this.store.getWebhook(webhookId);
    if (!webhook) {
      throw new NotFoundError("Webhook");
    }
    if (webhook.status !== "enabled") {
      throw new ValidationError(
        "Enable the webhook before replaying a delivery.",
      );
    }
    const source = await this.store.getWebhookDelivery(deliveryId);
    if (!source || source.webhook_id !== webhookId) {
      throw new NotFoundError("Webhook delivery");
    }
    return deliverySummary(
      await this.enqueueDelivery(webhookId, source.event, source.id),
    );
  }

  async deliver(
    webhookId: string,
    event: WebhookEvent,
    deliveryId = createId("msg"),
    attempt = 1,
  ): Promise<void> {
    let delivery = await this.store.getWebhookDelivery(deliveryId);
    if (!delivery) {
      delivery = this.newDelivery(deliveryId, webhookId, event);
      await this.store.createWebhookDelivery(delivery);
    } else if (delivery.webhook_id !== webhookId) {
      throw new Error(
        "Webhook delivery does not belong to the queued endpoint.",
      );
    }
    const webhook = await this.store.getWebhook(webhookId);
    if (!webhook || webhook.status !== "enabled") {
      await this.store.updateWebhookDelivery(deliveryId, {
        status: "cancelled",
        updated_at: this.now().toISOString(),
      });
      return;
    }
    const attemptedAt = this.now().toISOString();
    const attempts = Math.max(attempt, delivery.attempts + 1);
    await this.store.updateWebhookDelivery(deliveryId, {
      status: "delivering",
      attempts,
      last_attempt_at: attemptedAt,
      updated_at: attemptedAt,
      response_status: undefined,
      last_error: undefined,
    });
    const payload = JSON.stringify(delivery.event);
    const timestamp = String(Math.floor(Date.parse(attemptedAt) / 1_000));
    let response: WebhookHttpResponse;
    try {
      response = await this.httpFetch(webhook.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "HayaSend-Webhooks/0.1.0",
          "svix-id": deliveryId,
          "svix-timestamp": timestamp,
          "svix-signature": signWebhook(
            webhook.signing_secret,
            deliveryId,
            timestamp,
            payload,
          ),
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch (error) {
      await this.store.updateWebhookDelivery(deliveryId, {
        status: "failed",
        attempts,
        last_error: safeFailureMessage("Webhook delivery failed", error),
        last_attempt_at: attemptedAt,
        updated_at: this.now().toISOString(),
        response_status: undefined,
      });
      throw error;
    }
    if (!response.ok) {
      await this.store.updateWebhookDelivery(deliveryId, {
        status: "failed",
        attempts,
        response_status: response.status,
        last_error: `HTTP ${response.status}`,
        last_attempt_at: attemptedAt,
        updated_at: this.now().toISOString(),
      });
      throw new Error(
        `Webhook ${webhook.id} returned HTTP ${response.status}.`,
      );
    }
    await this.store.updateWebhookDelivery(deliveryId, {
      status: "succeeded",
      attempts,
      response_status: response.status,
      last_error: undefined,
      last_attempt_at: attemptedAt,
      updated_at: this.now().toISOString(),
    });
  }

  private newDelivery(
    id: string,
    webhookId: string,
    event: WebhookEvent,
    replayedFrom?: string,
  ): WebhookDeliveryRecord {
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.deliveryRetentionDays * 86_400_000,
    );
    return {
      id,
      webhook_id: webhookId,
      event_type: event.type,
      event: structuredClone(event),
      status: "pending",
      attempts: 0,
      ...(replayedFrom ? { replayed_from: replayedFrom } : {}),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
  }

  private async enqueueDelivery(
    webhookId: string,
    event: WebhookEvent,
    replayedFrom?: string,
  ): Promise<WebhookDeliveryRecord> {
    const delivery = this.newDelivery(
      createId("msg"),
      webhookId,
      event,
      replayedFrom,
    );
    if (!(await this.store.createWebhookDelivery(delivery))) {
      throw new Error("Webhook delivery identifier collision.");
    }
    try {
      await this.queue.enqueue({
        type: "deliver_webhook",
        webhook_id: webhookId,
        delivery_id: delivery.id,
        event,
      });
    } catch (error) {
      const updatedAt = this.now().toISOString();
      await this.store.updateWebhookDelivery(delivery.id, {
        status: "failed",
        last_error: safeFailureMessage("Webhook enqueue failed", error),
        updated_at: updatedAt,
      });
      throw error;
    }
    return delivery;
  }
}
