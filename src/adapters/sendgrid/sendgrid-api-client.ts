import { AppError } from "../../core/errors.js";

export interface SendGridApiRequest {
  method: "DELETE" | "GET" | "POST";
  path: string;
  body?: unknown;
  expected_statuses: readonly number[];
}

export interface SendGridApi {
  request(input: SendGridApiRequest): Promise<Response>;
}

function classifyStatus(status: number): {
  category:
    | "provider_error"
    | "provider_rejected"
    | "provider_throttled"
    | "provider_unavailable";
  publicStatus: number;
} {
  if (status === 429) {
    return { category: "provider_throttled", publicStatus: 429 };
  }
  if (status === 408 || status >= 500) {
    return { category: "provider_unavailable", publicStatus: 503 };
  }
  if (status >= 400) {
    return { category: "provider_rejected", publicStatus: 422 };
  }
  return { category: "provider_error", publicStatus: 503 };
}

export class SendGridApiError extends AppError {
  readonly provider_status: number;

  constructor(status: number) {
    const classification = classifyStatus(status);
    super(
      classification.publicStatus,
      classification.category,
      `SendGrid request failed (${classification.category}).`,
    );
    this.provider_status = status;
  }
}

export class SendGridApiClient implements SendGridApi {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.sendgrid.com",
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async request(input: SendGridApiRequest): Promise<Response> {
    if (!input.path.startsWith("/v3/")) {
      throw new Error("SendGrid API paths must stay under /v3/.");
    }
    const response = await this.httpFetch(
      new URL(input.path, `${this.baseUrl}/`),
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!input.expected_statuses.includes(response.status)) {
      throw new SendGridApiError(response.status);
    }
    return response;
  }
}
