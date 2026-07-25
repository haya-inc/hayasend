import type { AppServices } from "./app.js";
import {
  MemoryAttachmentStorage,
  S3AttachmentStorage,
} from "./adapters/attachment-storage.js";
import {
  DisabledInboundStorage,
  MemoryInboundStorage,
  S3InboundStorage,
} from "./adapters/inbound-storage.js";
import { DynamoStore } from "./adapters/dynamo-store.js";
import {
  AwsEmailScheduler,
  QueueEmailScheduler,
} from "./adapters/email-scheduler.js";
import { MemoryStore } from "./adapters/memory-store.js";
import {
  LocalDomainProvider,
  SesDomainProvider,
} from "./adapters/ses-domain-provider.js";
import {
  ConsoleMailTransport,
  SesMailTransport,
} from "./adapters/ses-transport.js";
import {
  LocalJobQueue,
  SqsJobQueue,
} from "./adapters/sqs-job-queue.js";
import { loadConfig, type Config } from "./config.js";
import type { Job } from "./core/types.js";
import {
  ApiKeyService,
  type BootstrapKeyProvider,
} from "./services/api-key-service.js";
import { AttachmentService } from "./services/attachment-service.js";
import { DomainService } from "./services/domain-service.js";
import { EmailService } from "./services/email-service.js";
import { ReceivedEmailService } from "./services/received-email-service.js";
import { SuppressionService } from "./services/suppression-service.js";
import { WebhookService } from "./services/webhook-service.js";

export interface Runtime extends AppServices {
  processJob(job: Job, attempt?: number): Promise<void>;
}

export function createLocalRuntime(config = loadConfig()): Runtime {
  const store = new MemoryStore();
  const queue = new LocalJobQueue();
  const webhooks = new WebhookService(store, queue);
  const receivedEmails = new ReceivedEmailService(
    store,
    new MemoryInboundStorage(),
    queue,
    webhooks,
    {
      rawPrefix: config.inboundRawPrefix,
      retentionDays: config.inboundRetentionDays,
      maxMessageBytes: config.inboundMaxMessageBytes,
    },
  );
  const suppressions = new SuppressionService(store);
  const attachmentService = new AttachmentService(
    store,
    new MemoryAttachmentStorage(),
  );
  const scheduler = new QueueEmailScheduler(queue);
  const apiKeys = new ApiKeyService(
    store,
    config.apiKey ?? "re_hayasend_dev",
  );
  const emailService = new EmailService(
    store,
    scheduler,
    new ConsoleMailTransport(),
    webhooks,
    suppressions,
    attachmentService,
  );
  const domainService = new DomainService(
    store,
    new LocalDomainProvider(),
    config.region,
  );

  const processJob = async (job: Job, attempt = 1) => {
    if (job.type === "send_email") {
      await emailService.processSend(job.email_id, attempt);
      return;
    }
    if (job.type === "publish_received_email") {
      await receivedEmails.publishWebhook(job.email_id);
      return;
    }
    await webhooks.deliver(job.webhook_id, job.event);
  };
  queue.setHandler(processJob);

  return {
    apiKeyService: apiKeys,
    attachmentService,
    domainService,
    emailService,
    receivedEmailService: receivedEmails,
    suppressionService: suppressions,
    webhookService: webhooks,
    processJob,
  };
}

export function createAwsRuntime(
  config: Config = loadConfig(),
  bootstrapKey: string | BootstrapKeyProvider = async () => {
    throw new Error(
      "Bootstrap authentication is unavailable in this runtime.",
    );
  },
): Runtime {
  if (
    !config.tableName ||
    !config.queueUrl ||
    !config.queueArn ||
    !config.payloadBucket ||
    !config.schedulerGroupName ||
    !config.schedulerRoleArn ||
    !config.schedulerDeadLetterQueueArn
  ) {
    throw new Error(
      "DynamoDB, SQS, S3, and EventBridge Scheduler settings are required in AWS mode.",
    );
  }
  const store = new DynamoStore(config.tableName, config.payloadBucket);
  const queue = new SqsJobQueue(config.queueUrl);
  const webhooks = new WebhookService(store, queue);
  const receivedEmails = new ReceivedEmailService(
    store,
    config.inboundBucket
      ? new S3InboundStorage(config.inboundBucket)
      : new DisabledInboundStorage(),
    queue,
    webhooks,
    {
      rawPrefix: config.inboundRawPrefix,
      retentionDays: config.inboundRetentionDays,
      maxMessageBytes: config.inboundMaxMessageBytes,
    },
  );
  const suppressions = new SuppressionService(store);
  const attachmentService = new AttachmentService(
    store,
    new S3AttachmentStorage(config.payloadBucket),
  );
  const scheduler = new AwsEmailScheduler(queue, {
    groupName: config.schedulerGroupName,
    queueArn: config.queueArn,
    roleArn: config.schedulerRoleArn,
    schedulerDeadLetterQueueArn:
      config.schedulerDeadLetterQueueArn,
  });
  const apiKeys = new ApiKeyService(store, bootstrapKey);
  const emailService = new EmailService(
    store,
    scheduler,
    new SesMailTransport(config.configurationSet),
    webhooks,
    suppressions,
    attachmentService,
  );
  const domainService = new DomainService(
    store,
    new SesDomainProvider(),
    config.region,
  );

  return {
    apiKeyService: apiKeys,
    attachmentService,
    domainService,
    emailService,
    receivedEmailService: receivedEmails,
    suppressionService: suppressions,
    webhookService: webhooks,
    async processJob(job: Job, attempt = 1) {
      if (job.type === "send_email") {
        await emailService.processSend(job.email_id, attempt);
        return;
      }
      if (job.type === "publish_received_email") {
        await receivedEmails.publishWebhook(job.email_id);
        return;
      }
      await webhooks.deliver(job.webhook_id, job.event);
    },
  };
}

export function createRuntime(
  config = loadConfig(),
  bootstrapKey?: string | BootstrapKeyProvider,
): Runtime {
  if (config.mode === "local") {
    return createLocalRuntime(config);
  }
  if (!bootstrapKey) {
    throw new Error("AWS API runtime requires a bootstrap key provider.");
  }
  return createAwsRuntime(config, bootstrapKey);
}
