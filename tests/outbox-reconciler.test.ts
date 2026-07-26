import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  type MemoryDeliveryMutation,
} from "../src/adapters/memory-store.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";
import { createOutboxIdentity } from "../src/core/delivery-model.js";
import type { Job } from "../src/core/types.js";
import type { DeliveryCommit } from "../src/ports/delivery-outbox-store.js";
import type { JobQueue } from "../src/ports/job-queue.js";
import { OutboxReconciler } from "../src/services/outbox-reconciler.js";

const NOW = new Date("2026-07-26T02:00:00.000Z");
const PROVIDER = {
  name: "aws-ses",
  adapter_version: "0.1.0",
  capability_version: "1.0.0",
} as const;

function delivery(
  seed = "00000000000000000000000000000001",
  dueAt = NOW.toISOString(),
): DeliveryCommit {
  const messageId = `email_${seed}`;
  const recipientIds = [
    `rcpt_${seed}a`,
    `rcpt_${seed}b`,
  ];
  const attemptDigest = seed.padEnd(64, "0").slice(0, 64);
  const scheduled = dueAt === NOW.toISOString() ? undefined : dueAt;
  return {
    email: {
      id: messageId,
      from: "sender@example.com",
      to: ["first-recipient@example.net"],
      cc: ["second-recipient@example.net"],
      subject: "Private subject",
      text: "Private body",
      status: scheduled ? "scheduled" : "queued",
      last_event: scheduled ? "scheduled" : "queued",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...(scheduled ? { scheduled_at: scheduled } : {}),
      request_hash: attemptDigest,
      attempts: 0,
    },
    message: {
      schema_version: "1.0.0",
      record_type: "message",
      id: messageId,
      provider: PROVIDER,
      intent_digest: attemptDigest,
      recipient_ids: recipientIds,
      status: scheduled ? "scheduled" : "queued",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...(scheduled ? { scheduled_at: scheduled } : {}),
    },
    recipients: [
      {
        schema_version: "1.0.0",
        record_type: "recipient",
        id: recipientIds[0]!,
        message_id: messageId,
        role: "to",
        ordinal: 0,
        address: "first-recipient@example.net",
        status: "queued",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
      {
        schema_version: "1.0.0",
        record_type: "recipient",
        id: recipientIds[1]!,
        message_id: messageId,
        role: "cc",
        ordinal: 0,
        address: "second-recipient@example.net",
        status: "queued",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    ],
    outbox: {
      schema_version: "1.0.0",
      record_type: "outbox_item",
      id: createOutboxIdentity({
        message_id: messageId,
        job_type: "dispatch-message",
        generation: 0,
      }),
      message_id: messageId,
      job_type: "dispatch-message",
      generation: 0,
      due_at: dueAt,
      attempts: 0,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    idempotency: {
      key_hash: `idempotency-${seed}`,
      request_hash: attemptDigest,
      expires_at: Math.floor(NOW.getTime() / 1_000) + 86_400,
    },
  };
}

async function commit(store: MemoryStore, value = delivery()) {
  return store.commitDelivery(value, Math.floor(NOW.getTime() / 1_000));
}

function matches(
  actual: MemoryDeliveryMutation,
  expected: MemoryDeliveryMutation,
): boolean {
  return (
    actual.operation === expected.operation &&
    actual.entity === expected.entity &&
    ("index" in actual ? actual.index : undefined) ===
      ("index" in expected ? expected.index : undefined)
  );
}

class FlakyQueue implements JobQueue {
  readonly jobs: Job[] = [];
  failures = 1;

  async enqueue(job: Job): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("private queue endpoint and recipient@example.net");
    }
    this.jobs.push(structuredClone(job));
  }
}

describe("memory transactional outbox", () => {
  it.each<MemoryDeliveryMutation>([
    { operation: "commit", entity: "email" },
    { operation: "commit", entity: "message" },
    { operation: "commit", entity: "recipient", index: 0 },
    { operation: "commit", entity: "recipient", index: 1 },
    { operation: "commit", entity: "idempotency" },
    { operation: "commit", entity: "outbox" },
  ])("rolls back every staged write when $entity/$index fails", async (point) => {
    const store = new MemoryStore({
      afterDeliveryMutation(mutation) {
        if (matches(mutation, point)) {
          throw new Error("injected commit failure");
        }
      },
    });
    const value = delivery();

    await expect(commit(store, value)).rejects.toThrow(
      "injected commit failure",
    );
    await expect(store.getEmail(value.email.id)).resolves.toBeUndefined();
    await expect(store.getDelivery(value.email.id)).resolves.toBeUndefined();
    await expect(store.getOutboxItem(value.outbox.id)).resolves.toBeUndefined();
    await expect(store.getOutboxMetrics(NOW)).resolves.toEqual({
      due: 0,
      leased: 0,
      stuck_leases: 0,
      undispatched: 0,
      oldest_due_age_seconds: 0,
      publish_failures_total: 0,
      truncated: false,
    });
  });

  it("recovers a committed message without a client replay", async () => {
    let failAfterSwap = true;
    const store = new MemoryStore({
      afterDeliveryMutation(mutation) {
        if (mutation.operation === "commit_swap" && failAfterSwap) {
          failAfterSwap = false;
          throw new Error("process stopped after atomic commit");
        }
      },
    });
    const value = delivery();

    await expect(commit(store, value)).rejects.toThrow(
      "process stopped after atomic commit",
    );
    await expect(store.getEmail(value.email.id)).resolves.toEqual(value.email);
    await expect(store.getDelivery(value.email.id)).resolves.toMatchObject({
      email: { id: value.email.id },
      message: { id: value.email.id },
      recipients: [{ role: "to" }, { role: "cc" }],
      outbox: { id: value.outbox.id },
    });
    await expect(
      store.getOutboxItem(value.outbox.id),
    ).resolves.not.toHaveProperty("dispatched_at");

    const queue = new CapturingJobQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-recovery",
    });
    await expect(reconciler.sweep(NOW)).resolves.toEqual({
      leased: 1,
      dispatched: 1,
      failed: 0,
    });
    expect(queue.jobs).toEqual([
      {
        job: {
          type: "send_email",
          email_id: value.email.id,
          job_id: value.outbox.id,
        },
        delaySeconds: 0,
      },
    ]);
  });

  it("reuses one deterministic job identity after queue acceptance ambiguity", async () => {
    const store = new MemoryStore();
    const value = delivery();
    await commit(store, value);
    const queue = new CapturingJobQueue();
    let stopAfterPublish = true;
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-ambiguous",
      lease_seconds: 30,
      after_publish() {
        if (stopAfterPublish) {
          stopAfterPublish = false;
          throw new Error("process stopped after queue acceptance");
        }
      },
    });

    await expect(reconciler.sweep(NOW)).rejects.toThrow(
      "process stopped after queue acceptance",
    );
    await expect(
      reconciler.sweep(new Date(NOW.getTime() + 29_999)),
    ).resolves.toEqual({ leased: 0, dispatched: 0, failed: 0 });
    await expect(
      reconciler.sweep(new Date(NOW.getTime() + 30_000)),
    ).resolves.toEqual({ leased: 1, dispatched: 1, failed: 0 });

    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobs[0]?.job).toEqual(queue.jobs[1]?.job);
    expect(queue.jobs[0]?.job).toMatchObject({
      job_id: value.outbox.id,
    });
    await expect(store.getOutboxItem(value.outbox.id)).resolves.toMatchObject({
      attempts: 2,
      dispatched_at: new Date(NOW.getTime() + 30_000).toISOString(),
    });
  });

  it("allows only one concurrent reconciler to own an active lease", async () => {
    const store = new MemoryStore();
    await commit(store);
    const queue = new CapturingJobQueue();
    const first = new OutboxReconciler(store, queue, {
      owner: "reconciler-first",
    });
    const second = new OutboxReconciler(store, queue, {
      owner: "reconciler-second",
    });

    const results = await Promise.all([first.sweep(NOW), second.sweep(NOW)]);
    expect(results).toContainEqual({ leased: 1, dispatched: 1, failed: 0 });
    expect(results).toContainEqual({ leased: 0, dispatched: 0, failed: 0 });
    expect(queue.jobs).toHaveLength(1);
  });

  it("recovers when the process stops immediately after writing a lease", async () => {
    let stopAfterLease = true;
    const store = new MemoryStore({
      afterDeliveryMutation(mutation) {
        if (mutation.operation === "lease" && stopAfterLease) {
          stopAfterLease = false;
          throw new Error("process stopped after lease");
        }
      },
    });
    const value = delivery();
    await commit(store, value);
    const queue = new CapturingJobQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-lease",
      lease_seconds: 10,
    });

    await expect(reconciler.sweep(NOW)).rejects.toThrow(
      "process stopped after lease",
    );
    expect(queue.jobs).toHaveLength(0);
    await expect(
      reconciler.sweep(new Date(NOW.getTime() + 9_999)),
    ).resolves.toMatchObject({ leased: 0 });
    await expect(
      reconciler.sweep(new Date(NOW.getTime() + 10_000)),
    ).resolves.toEqual({ leased: 1, dispatched: 1, failed: 0 });
    expect(queue.jobs[0]?.job).toMatchObject({ job_id: value.outbox.id });
  });

  it("retains due work and safe counters when queue publication fails", async () => {
    const store = new MemoryStore();
    const value = delivery();
    await commit(store, value);
    const queue = new FlakyQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-failure",
    });

    await expect(reconciler.sweep(NOW)).resolves.toEqual({
      leased: 1,
      dispatched: 0,
      failed: 1,
    });
    await expect(reconciler.metrics(NOW)).resolves.toEqual({
      due: 1,
      leased: 0,
      stuck_leases: 0,
      undispatched: 1,
      oldest_due_age_seconds: 0,
      publish_failures_total: 1,
      truncated: false,
    });
    await expect(store.getOutboxItem(value.outbox.id)).resolves.toMatchObject({
      attempts: 1,
      last_diagnostic_category: "application_error",
      lease_owner: undefined,
    });

    await expect(reconciler.sweep(NOW)).resolves.toEqual({
      leased: 1,
      dispatched: 1,
      failed: 0,
    });
    expect(queue.jobs).toEqual([
      {
        type: "send_email",
        email_id: value.email.id,
        job_id: value.outbox.id,
      },
    ]);
  });

  it("retains failure state when the process stops after writing it", async () => {
    let stopAfterFailure = true;
    const store = new MemoryStore({
      afterDeliveryMutation(mutation) {
        if (mutation.operation === "failure" && stopAfterFailure) {
          stopAfterFailure = false;
          throw new Error("process stopped after failure record");
        }
      },
    });
    await commit(store);
    const queue = new FlakyQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-failure-write",
    });

    await expect(reconciler.sweep(NOW)).rejects.toThrow(
      "process stopped after failure record",
    );
    await expect(reconciler.metrics(NOW)).resolves.toMatchObject({
      due: 1,
      leased: 0,
      publish_failures_total: 1,
    });
    await expect(reconciler.sweep(NOW)).resolves.toEqual({
      leased: 1,
      dispatched: 1,
      failed: 0,
    });
  });

  it("reports due, active lease, future work, age, and exact expiry", async () => {
    const store = new MemoryStore();
    const future = new Date(NOW.getTime() + 60_000);
    await commit(store, delivery());
    await commit(
      store,
      delivery("00000000000000000000000000000002", future.toISOString()),
    );

    await expect(store.getOutboxMetrics(NOW)).resolves.toEqual({
      due: 1,
      leased: 0,
      stuck_leases: 0,
      undispatched: 2,
      oldest_due_age_seconds: 0,
      publish_failures_total: 0,
      truncated: false,
    });
    await store.leaseDueOutbox({
      owner: "reconciler-metrics",
      now: NOW,
      lease_seconds: 60,
      limit: 1,
    });
    await expect(
      store.getOutboxMetrics(new Date(NOW.getTime() + 59_999)),
    ).resolves.toEqual({
      due: 0,
      leased: 1,
      stuck_leases: 0,
      undispatched: 2,
      oldest_due_age_seconds: 59,
      publish_failures_total: 0,
      truncated: false,
    });
    await expect(store.getOutboxMetrics(future)).resolves.toEqual({
      due: 2,
      leased: 0,
      stuck_leases: 1,
      undispatched: 2,
      oldest_due_age_seconds: 60,
      publish_failures_total: 0,
      truncated: false,
    });
  });

  it("obeys lease boundaries for a range of durations", async () => {
    for (const leaseSeconds of [1, 2, 30, 60, 300]) {
      const store = new MemoryStore();
      await commit(store);
      await expect(
        store.leaseDueOutbox({
          owner: "reconciler-property",
          now: NOW,
          lease_seconds: leaseSeconds,
          limit: 1,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        store.leaseDueOutbox({
          owner: "another-reconciler",
          now: new Date(NOW.getTime() + leaseSeconds * 1_000 - 1),
          lease_seconds: leaseSeconds,
          limit: 1,
        }),
      ).resolves.toHaveLength(0);
      await expect(
        store.leaseDueOutbox({
          owner: "another-reconciler",
          now: new Date(NOW.getTime() + leaseSeconds * 1_000),
          lease_seconds: leaseSeconds,
          limit: 1,
        }),
      ).resolves.toHaveLength(1);
    }
  });

  it("continuously sweeps until its abort signal is set", async () => {
    const store = new MemoryStore();
    const dueAt = new Date(NOW.getTime() + 60_000);
    await commit(
      store,
      delivery("00000000000000000000000000000003", dueAt.toISOString()),
    );
    const queue = new CapturingJobQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-continuous",
    });
    const controller = new AbortController();
    let current = NOW;
    let waits = 0;

    await reconciler.run(controller.signal, {
      interval_ms: 100,
      now: () => current,
      wait: async () => {
        waits += 1;
        current = dueAt;
        if (waits === 2) {
          controller.abort();
        }
      },
    });

    expect(waits).toBe(2);
    expect(queue.jobs).toHaveLength(1);
  });

  it("keeps an acknowledged item dispatched if the process stops after the write", async () => {
    let stopAfterAck = true;
    const store = new MemoryStore({
      afterDeliveryMutation(mutation) {
        if (mutation.operation === "acknowledge" && stopAfterAck) {
          stopAfterAck = false;
          throw new Error("process stopped after dispatch acknowledgement");
        }
      },
    });
    const value = delivery();
    await commit(store, value);
    const queue = new CapturingJobQueue();
    const reconciler = new OutboxReconciler(store, queue, {
      owner: "reconciler-ack",
    });

    await expect(reconciler.sweep(NOW)).rejects.toThrow(
      "process stopped after dispatch acknowledgement",
    );
    await expect(reconciler.sweep(NOW)).resolves.toEqual({
      leased: 0,
      dispatched: 0,
      failed: 0,
    });
    expect(queue.jobs).toHaveLength(1);
    await expect(store.getOutboxItem(value.outbox.id)).resolves.toMatchObject({
      dispatched_at: NOW.toISOString(),
      lease_owner: undefined,
    });
  });

  it("replays the complete atomic delivery for the same idempotency claim", async () => {
    const store = new MemoryStore();
    const value = delivery();
    const first = await commit(store, value);
    const replay = await commit(store, {
      ...value,
      email: {
        ...value.email,
        id: "email_ffffffffffffffffffffffffffffffff",
      },
      message: {
        ...value.message,
        id: "email_ffffffffffffffffffffffffffffffff",
      },
      recipients: value.recipients.map((recipient) => ({
        ...recipient,
        message_id: "email_ffffffffffffffffffffffffffffffff",
      })),
      outbox: {
        ...value.outbox,
        id: createOutboxIdentity({
          message_id: "email_ffffffffffffffffffffffffffffffff",
          job_type: "dispatch-message",
          generation: 0,
        }),
        message_id: "email_ffffffffffffffffffffffffffffffff",
      },
    });

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      email: { id: value.email.id },
      message: { id: value.message.id },
      outbox: { id: value.outbox.id },
    });
    await expect(store.getOutboxMetrics(NOW)).resolves.toMatchObject({
      undispatched: 1,
    });
  });

  it.each([
    {
      label: "recipient address",
      mutate(value: DeliveryCommit): DeliveryCommit {
        return {
          ...value,
          recipients: [
            value.recipients[0]!,
            {
              ...value.recipients[1]!,
              address: value.recipients[0]!.address.toUpperCase(),
            },
          ],
        };
      },
    },
    {
      label: "message schedule",
      mutate(value: DeliveryCommit): DeliveryCommit {
        return {
          ...value,
          message: {
            ...value.message,
            scheduled_at: "2026-07-26T03:00:00.000Z",
          },
        };
      },
    },
    {
      label: "non-pristine outbox",
      mutate(value: DeliveryCommit): DeliveryCommit {
        return {
          ...value,
          outbox: { ...value.outbox, attempts: 1 },
        };
      },
    },
    {
      label: "expired idempotency",
      mutate(value: DeliveryCommit): DeliveryCommit {
        return {
          ...value,
          idempotency: {
            ...value.idempotency!,
            expires_at: Math.floor(NOW.getTime() / 1_000),
          },
        };
      },
    },
  ])("rejects an invalid atomic $label boundary", async ({ mutate }) => {
    const store = new MemoryStore();

    await expect(commit(store, mutate(delivery()))).rejects.toThrow();
    await expect(store.getOutboxMetrics(NOW)).resolves.toMatchObject({
      undispatched: 0,
    });
  });
});
