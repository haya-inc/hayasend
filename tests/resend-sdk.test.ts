import { Resend } from "resend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { LocalDomainProvider } from "../src/adapters/ses-domain-provider.js";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import type {
  MailTransport,
  MailTransportResult,
} from "../src/ports/mail-transport.js";
import { DomainService } from "../src/services/domain-service.js";
import { EmailService } from "../src/services/email-service.js";
import { WebhookService } from "../src/services/webhook-service.js";

const passthroughTransport: MailTransport = {
  async send(): Promise<MailTransportResult> {
    return { provider_id: "provider_id" };
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("official Resend Node SDK compatibility", () => {
  it("sends through a custom baseUrl without an SDK fork", async () => {
    const store = new MemoryStore();
    const queue = new CapturingJobQueue();
    const webhooks = new WebhookService(store, queue);
    const app = createApp({
      apiKey: "re_hayasend_compatible",
      domainService: new DomainService(
        store,
        new LocalDomainProvider(),
        "ap-northeast-1",
      ),
      emailService: new EmailService(
        store,
        queue,
        passthroughTransport,
        webhooks,
      ),
      webhookService: webhooks,
    });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const incoming = new Request(input, init);
        const url = new URL(incoming.url);
        if (url.hostname !== "api.hayasend.test") {
          return nativeFetch(input, init);
        }
        const localUrl = new URL(url.pathname + url.search, "http://local");
        return app.fetch(new Request(localUrl, incoming));
      },
    );

    const resend = new Resend("re_hayasend_compatible", {
      baseUrl: "https://api.hayasend.test",
    });
    const { data, error } = await resend.emails.send({
      from: "HayaSend <sender@example.com>",
      to: "recipient@example.net",
      subject: "Official SDK compatibility",
      text: "No SDK fork required.",
      replyTo: "support@example.com",
      tags: [{ name: "source", value: "resend-sdk-test" }],
    });

    expect(error).toBeNull();
    expect(data?.id).toMatch(/^email_/);
    expect(queue.jobs[0]?.job).toEqual({
      type: "send_email",
      email_id: data?.id,
    });
  });
});
