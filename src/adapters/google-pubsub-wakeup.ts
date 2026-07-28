import { GoogleAuth } from "google-auth-library";
import type { Config } from "../config.js";
import { safeErrorCategory } from "../core/error-telemetry.js";
import type {
  JobWakeupPublisher,
  JobWakeupWaiter,
} from "../ports/job-wakeup.js";

const PUBSUB_ORIGIN = "https://pubsub.googleapis.com";
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
const TOPIC_PATTERN =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/;
const SUBSCRIPTION_PATTERN =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/;

interface GoogleJsonRequest {
  url: string;
  method: "POST";
  data: unknown;
  timeout?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface GoogleJsonRequester {
  request<T>(options: GoogleJsonRequest): Promise<{ data: T }>;
}

interface PublishResponse {
  messageIds?: string[] | undefined;
}

interface PullResponse {
  receivedMessages?:
    | Array<{
        ackId?: string | undefined;
      }>
    | undefined;
}

export interface GooglePubSubWakeupOptions {
  requester?: GoogleJsonRequester | undefined;
  log?:
    | ((entry: Record<string, string | number | boolean>) => void)
    | undefined;
}

function googleRequester(): GoogleJsonRequester {
  const auth = new GoogleAuth({ scopes: [PUBSUB_SCOPE] });
  return {
    async request<T>(options: GoogleJsonRequest) {
      const response = await auth.request<T>({
        url: options.url,
        method: options.method,
        data: options.data as Record<string, unknown>,
        ...(options.timeout === undefined
          ? {}
          : { timeout: options.timeout }),
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal }),
      });
      return { data: response.data };
    },
  };
}

function assertTopicName(topic: string): void {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error(
      "Pub/Sub topic must be a fully qualified Google Cloud resource name.",
    );
  }
}

function assertSubscriptionName(subscription: string): void {
  if (!SUBSCRIPTION_PATTERN.test(subscription)) {
    throw new Error(
      "Pub/Sub subscription must be a fully qualified Google Cloud resource name.",
    );
  }
}

function requestUrl(resource: string, operation: string): string {
  return `${PUBSUB_ORIGIN}/v1/${resource}:${operation}`;
}

function isExpectedWaitEnd(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "ECONNABORTED" ||
    candidate.name === "AbortError"
  );
}

export class GooglePubSubWakeupPublisher
  implements JobWakeupPublisher
{
  private readonly requester: GoogleJsonRequester;

  constructor(
    private readonly topic: string,
    options: GooglePubSubWakeupOptions = {},
  ) {
    assertTopicName(topic);
    this.requester = options.requester ?? googleRequester();
  }

  async publish(): Promise<void> {
    const response = await this.requester.request<PublishResponse>({
      url: requestUrl(this.topic, "publish"),
      method: "POST",
      data: {
        messages: [
          {
            attributes: {
              hayasend_wakeup: "1",
            },
          },
        ],
      },
    });
    if (
      !Array.isArray(response.data.messageIds) ||
      response.data.messageIds.length !== 1 ||
      typeof response.data.messageIds[0] !== "string" ||
      response.data.messageIds[0].length === 0
    ) {
      throw new Error("Pub/Sub did not confirm the wake-up message.");
    }
  }
}

export class GooglePubSubWakeupWaiter implements JobWakeupWaiter {
  private readonly requester: GoogleJsonRequester;
  private readonly log: (
    entry: Record<string, string | number | boolean>,
  ) => void;
  private closed = false;
  private waiting = false;
  private readonly closeController = new AbortController();

  constructor(
    private readonly subscription: string,
    options: GooglePubSubWakeupOptions = {},
  ) {
    assertSubscriptionName(subscription);
    this.requester = options.requester ?? googleRequester();
    this.log =
      options.log ??
      ((entry) => {
        console.info(JSON.stringify(entry));
      });
  }

  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (
      this.closed ||
      signal.aborted ||
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 50 ||
      milliseconds > 60_000
    ) {
      if (!this.closed && !signal.aborted) {
        throw new Error(
          "Pub/Sub wake-up wait must be between 50 and 60000 milliseconds.",
        );
      }
      return;
    }
    if (this.waiting) {
      throw new Error("Pub/Sub wake-up waits must not overlap.");
    }
    this.waiting = true;
    const combinedSignal = AbortSignal.any([
      signal,
      this.closeController.signal,
    ]);
    try {
      const response = await this.requester.request<PullResponse>({
        url: requestUrl(this.subscription, "pull"),
        method: "POST",
        data: {
          maxMessages: 1,
        },
        timeout: milliseconds,
        signal: combinedSignal,
      });
      const ackId = response.data.receivedMessages?.[0]?.ackId;
      if (!ackId) {
        return;
      }
      try {
        await this.requester.request<Record<string, never>>({
          url: requestUrl(this.subscription, "acknowledge"),
          method: "POST",
          data: {
            ackIds: [ackId],
          },
          timeout: milliseconds,
          signal: combinedSignal,
        });
      } catch (error) {
        if (!isExpectedWaitEnd(error, combinedSignal)) {
          this.log({
            level: "warn",
            message:
              "Pub/Sub wake-up acknowledgment failed; duplicate wake-up remains harmless",
            error_type: safeErrorCategory(error),
          });
        }
      }
    } catch (error) {
      if (!isExpectedWaitEnd(error, combinedSignal)) {
        this.log({
          level: "warn",
          message:
            "Pub/Sub wake-up unavailable; PostgreSQL polling remains active",
          error_type: safeErrorCategory(error),
        });
      }
    } finally {
      this.waiting = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeController.abort();
  }
}

export function createGooglePubSubWakeupPublisher(
  config: Config,
): JobWakeupPublisher | undefined {
  if (config.portableQueueWakeup !== "gcp-pubsub") {
    return undefined;
  }
  if (!config.gcpPubSubTopic) {
    throw new Error(
      "The API process requires HAYASEND_GCP_PUBSUB_TOPIC when Pub/Sub wake-up is enabled.",
    );
  }
  return new GooglePubSubWakeupPublisher(config.gcpPubSubTopic);
}

export function createGooglePubSubWakeupWaiter(
  config: Config,
): JobWakeupWaiter | undefined {
  if (config.portableQueueWakeup !== "gcp-pubsub") {
    return undefined;
  }
  if (!config.gcpPubSubSubscription) {
    throw new Error(
      "The worker process requires HAYASEND_GCP_PUBSUB_SUBSCRIPTION when Pub/Sub wake-up is enabled.",
    );
  }
  return new GooglePubSubWakeupWaiter(
    config.gcpPubSubSubscription,
  );
}
