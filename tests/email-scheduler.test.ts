import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { describe, expect, it, vi } from "vitest";
import { AwsEmailScheduler } from "../src/adapters/email-scheduler.js";
import { CapturingJobQueue } from "../src/adapters/sqs-job-queue.js";

const options = {
  groupName: "hayasend-emails",
  queueArn: "arn:aws:sqs:ap-northeast-1:123456789012:jobs",
  roleArn: "arn:aws:iam::123456789012:role/scheduler",
  schedulerDeadLetterQueueArn:
    "arn:aws:sqs:ap-northeast-1:123456789012:scheduler-dead",
};
const now = new Date("2026-07-26T00:00:00.000Z");

function fixture(
  send = vi.fn(async (_command: unknown) => ({})),
) {
  const queue = new CapturingJobQueue();
  const scheduler = new AwsEmailScheduler(queue, options, { send });
  return { queue, scheduler, send };
}

describe("AwsEmailScheduler", () => {
  it("uses SQS directly for delays up to 15 minutes", async () => {
    const { queue, scheduler, send } = fixture();

    await scheduler.schedule(
      "email_short",
      "2026-07-26T00:15:00.000Z",
      now,
    );

    expect(queue.jobs).toEqual([
      {
        job: { type: "reconcile_outbox" },
        delaySeconds: 900,
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("creates a self-deleting one-time schedule for longer delays", async () => {
    const { queue, scheduler, send } = fixture();

    await scheduler.schedule(
      "email_long",
      "2026-07-27T01:02:03.456Z",
      now,
    );

    expect(queue.jobs).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect((command as CreateScheduleCommand).input).toMatchObject({
      Name: "hayasend-email_long",
      GroupName: "hayasend-emails",
      ScheduleExpression: "at(2026-07-27T01:02:03)",
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      Target: {
        Arn: options.queueArn,
        RoleArn: options.roleArn,
        Input: JSON.stringify({
          type: "reconcile_outbox",
        }),
        DeadLetterConfig: {
          Arn: options.schedulerDeadLetterQueueArn,
        },
      },
    });
  });

  it("updates the deterministic schedule when it already exists", async () => {
    const conflict = new Error("already exists");
    conflict.name = "ConflictException";
    const send = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({});
    const { scheduler } = fixture(send);

    await scheduler.reschedule(
      "email_replace",
      "2026-07-28T00:00:00.000Z",
      now,
    );

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CreateScheduleCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(UpdateScheduleCommand);
  });

  it("deletes a long schedule before moving it into the SQS window", async () => {
    const { queue, scheduler, send } = fixture();

    await scheduler.reschedule(
      "email_near",
      "2026-07-26T00:10:00.000Z",
      now,
    );

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteScheduleCommand);
    expect(queue.jobs[0]).toEqual({
      job: { type: "reconcile_outbox" },
      delaySeconds: 600,
    });
  });

  it("uses a direct send job only to repair an already-dispatched early job", async () => {
    const { queue, scheduler } = fixture();

    await scheduler.rescheduleDelivery(
      "email_early",
      "2026-07-26T00:10:00.000Z",
      now,
    );

    expect(queue.jobs).toEqual([
      {
        job: { type: "send_email", email_id: "email_early" },
        delaySeconds: 600,
      },
    ]);
  });

  it("treats cancellation of a missing schedule as idempotent", async () => {
    const missing = new Error("not found");
    missing.name = "ResourceNotFoundException";
    const send = vi.fn().mockRejectedValue(missing);
    const { scheduler } = fixture(send);

    await expect(scheduler.cancel("email_missing")).resolves.toBeUndefined();
  });
});
