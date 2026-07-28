import { describe, expect, it } from "vitest";
import {
  GooglePubSubWakeupPublisher,
  GooglePubSubWakeupWaiter,
  type GoogleJsonRequester,
} from "../src/adapters/google-pubsub-wakeup.js";

interface RequestRecord {
  url: string;
  data: unknown;
  timeout?: number | undefined;
}

class FakeRequester implements GoogleJsonRequester {
  readonly requests: RequestRecord[] = [];
  readonly responses: unknown[] = [];
  readonly failures: unknown[] = [];

  async request<T>(options: {
    url: string;
    method: "POST";
    data: unknown;
    timeout?: number | undefined;
  }): Promise<{ data: T }> {
    this.requests.push({
      url: options.url,
      data: structuredClone(options.data),
      ...(options.timeout === undefined
        ? {}
        : { timeout: options.timeout }),
    });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return { data: this.responses.shift() as T };
  }
}

const topic = "projects/hayasend-test/topics/hayasend-wakeup";
const subscription =
  "projects/hayasend-test/subscriptions/hayasend-wakeup";

describe("Google Pub/Sub wake-up accelerator", () => {
  it("publishes a fixed content-free hint and requires confirmation", async () => {
    const requester = new FakeRequester();
    requester.responses.push({ messageIds: ["provider-generated-id"] });
    const publisher = new GooglePubSubWakeupPublisher(topic, {
      requester,
    });

    await publisher.publish();

    expect(requester.requests).toEqual([
      {
        url:
          "https://pubsub.googleapis.com/v1/" +
          "projects/hayasend-test/topics/hayasend-wakeup:publish",
        data: {
          messages: [
            {
              attributes: {
                hayasend_wakeup: "1",
              },
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(requester.requests)).not.toContain("email_");
    expect(JSON.stringify(requester.requests)).not.toContain("@");

    requester.responses.push({});
    await expect(publisher.publish()).rejects.toThrow(
      "did not confirm",
    );
  });

  it("pulls one hint, acknowledges it, and never interprets payload data", async () => {
    const requester = new FakeRequester();
    requester.responses.push(
      {
        receivedMessages: [
          {
            ackId: "opaque-ack-id",
            message: {
              data: "dW50cnVzdGVkLXByaXZhdGUtY29udGVudA==",
            },
          },
        ],
      },
      {},
    );
    const waiter = new GooglePubSubWakeupWaiter(subscription, {
      requester,
    });

    await waiter.wait(5_000, new AbortController().signal);

    expect(requester.requests).toEqual([
      {
        url:
          "https://pubsub.googleapis.com/v1/" +
          "projects/hayasend-test/subscriptions/" +
          "hayasend-wakeup:pull",
        data: { maxMessages: 1 },
        timeout: 5_000,
      },
      {
        url:
          "https://pubsub.googleapis.com/v1/" +
          "projects/hayasend-test/subscriptions/" +
          "hayasend-wakeup:acknowledge",
        data: { ackIds: ["opaque-ack-id"] },
        timeout: 5_000,
      },
    ]);
  });

  it("falls back silently on poll timeout and logs only safe categories on outage", async () => {
    const requester = new FakeRequester();
    requester.failures.push(
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      new Error("private subscription payload"),
    );
    const logs: Array<Record<string, string | number | boolean>> = [];
    const waiter = new GooglePubSubWakeupWaiter(subscription, {
      requester,
      log: (entry) => logs.push(entry),
    });

    await waiter.wait(500, new AbortController().signal);
    await waiter.wait(500, new AbortController().signal);

    expect(logs).toEqual([
      {
        level: "warn",
        message:
          "Pub/Sub wake-up unavailable; PostgreSQL polling remains active",
        error_type: "application_error",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("private subscription");
  });

  it("validates exact resource names and stops cleanly", async () => {
    expect(
      () =>
        new GooglePubSubWakeupPublisher(
          "projects/hayasend-test/topics/../private",
        ),
    ).toThrow("fully qualified");
    expect(
      () =>
        new GooglePubSubWakeupWaiter(
          "https://attacker.example/subscriptions/private",
        ),
    ).toThrow("fully qualified");

    const requester = new FakeRequester();
    const waiter = new GooglePubSubWakeupWaiter(subscription, {
      requester,
    });
    await waiter.close();
    await waiter.wait(500, new AbortController().signal);
    expect(requester.requests).toEqual([]);
  });

  it("aborts an active pull when the waiter closes", async () => {
    let observedSignal: AbortSignal | undefined;
    const requester: GoogleJsonRequester = {
      request: async <T>(options: {
        signal?: AbortSignal | undefined;
      }): Promise<{ data: T }> => {
        observedSignal = options.signal;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(
              Object.assign(new Error("closed"), {
                name: "AbortError",
              }),
            ),
            { once: true },
          );
        });
        return { data: {} as T };
      },
    };
    const waiter = new GooglePubSubWakeupWaiter(subscription, {
      requester,
    });
    const waiting = waiter.wait(
      5_000,
      new AbortController().signal,
    );

    await waiter.close();

    await expect(waiting).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});
