import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from "@aws-sdk/client-scheduler";
import { delaySecondsUntil, secondsUntil } from "../core/schedule.js";
import type { JobQueue } from "../ports/job-queue.js";
import type { EmailScheduler } from "../ports/email-scheduler.js";

const MAX_SQS_DELAY_SECONDS = 900;

interface SchedulerClientLike {
  send(command: unknown): Promise<unknown>;
}

interface AwsEmailSchedulerOptions {
  groupName: string;
  queueArn: string;
  roleArn: string;
  schedulerDeadLetterQueueArn: string;
}

function scheduleName(emailId: string) {
  return `hayasend-${emailId}`;
}

function atExpression(scheduledAt: string) {
  return `at(${new Date(scheduledAt).toISOString().slice(0, 19)})`;
}

function isAwsError(error: unknown, name: string) {
  return (error as { name?: string }).name === name;
}

export class QueueEmailScheduler implements EmailScheduler {
  constructor(private readonly queue: JobQueue) {}

  async schedule(
    emailId: string,
    scheduledAt?: string,
    now = new Date(),
  ): Promise<void> {
    await this.queue.enqueue(
      { type: "send_email", email_id: emailId },
      delaySecondsUntil(scheduledAt, now),
    );
  }

  async reschedule(
    emailId: string,
    scheduledAt: string,
    now = new Date(),
  ): Promise<void> {
    await this.schedule(emailId, scheduledAt, now);
  }

  async cancel(_emailId: string): Promise<void> {}
}

export class AwsEmailScheduler implements EmailScheduler {
  constructor(
    private readonly queue: JobQueue,
    private readonly options: AwsEmailSchedulerOptions,
    private readonly client: SchedulerClientLike = new SchedulerClient({}),
  ) {}

  async schedule(
    emailId: string,
    scheduledAt?: string,
    now = new Date(),
  ): Promise<void> {
    if (
      !scheduledAt ||
      secondsUntil(scheduledAt, now) <= MAX_SQS_DELAY_SECONDS
    ) {
      await this.queue.enqueue(
        { type: "send_email", email_id: emailId },
        delaySecondsUntil(scheduledAt, now),
      );
      return;
    }
    await this.upsert(emailId, scheduledAt);
  }

  async reschedule(
    emailId: string,
    scheduledAt: string,
    now = new Date(),
  ): Promise<void> {
    if (secondsUntil(scheduledAt, now) <= MAX_SQS_DELAY_SECONDS) {
      await this.cancel(emailId);
      await this.queue.enqueue(
        { type: "send_email", email_id: emailId },
        delaySecondsUntil(scheduledAt, now),
      );
      return;
    }
    await this.upsert(emailId, scheduledAt);
  }

  async cancel(emailId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({
          GroupName: this.options.groupName,
          Name: scheduleName(emailId),
        }),
      );
    } catch (error) {
      if (!isAwsError(error, "ResourceNotFoundException")) {
        throw error;
      }
    }
  }

  private input(
    emailId: string,
    scheduledAt: string,
  ): CreateScheduleCommandInput {
    return {
      Name: scheduleName(emailId),
      GroupName: this.options.groupName,
      Description: `HayaSend delivery for ${emailId}`,
      ScheduleExpression: atExpression(scheduledAt),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      State: "ENABLED",
      Target: {
        Arn: this.options.queueArn,
        RoleArn: this.options.roleArn,
        Input: JSON.stringify({
          type: "send_email",
          email_id: emailId,
        }),
        DeadLetterConfig: {
          Arn: this.options.schedulerDeadLetterQueueArn,
        },
        RetryPolicy: {
          MaximumEventAgeInSeconds: 3_600,
          MaximumRetryAttempts: 3,
        },
      },
    };
  }

  private async upsert(
    emailId: string,
    scheduledAt: string,
  ): Promise<void> {
    const input = this.input(emailId, scheduledAt);
    try {
      await this.client.send(new CreateScheduleCommand(input));
    } catch (error) {
      if (!isAwsError(error, "ConflictException")) {
        throw error;
      }
      await this.client.send(new UpdateScheduleCommand(input));
    }
  }
}
