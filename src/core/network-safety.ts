import { ValidationError } from "./errors.js";

const MAX_WEBHOOK_URL_LENGTH = 2_048;

export interface WebhookHttpResponse {
  ok: boolean;
  status: number;
}

export type WebhookHttpClient = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<WebhookHttpResponse>;

export type WebhookEndpointValidator = (
  endpoint: URL,
) => Promise<void>;

export function assertWebhookEndpointShape(endpoint: URL) {
  if (
    endpoint.toString().length > MAX_WEBHOOK_URL_LENGTH ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new ValidationError(
      "Webhook endpoint must be an HTTP(S) URL of at most 2048 characters without credentials or a fragment.",
    );
  }
}
