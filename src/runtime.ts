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
import { AWS_SES_CAPABILITIES } from "./adapters/aws-ses-capabilities.js";
import { MemoryStore } from "./adapters/memory-store.js";
import {
  assertPublicWebhookEndpoint,
  createSafeWebhookFetch,
} from "./adapters/node-network-safety.js";
import {
  LocalDomainProvider,
  SesDomainProvider,
} from "./adapters/ses-domain-provider.js";
import {
  ConsoleMailTransport,
  SesMailTransport,
} from "./adapters/ses-transport.js";
import { LocalJobQueue, SqsJobQueue } from "./adapters/sqs-job-queue.js";
import { loadConfig, type Config } from "./config.js";
import { createId } from "./core/crypto.js";
import type { Job } from "./core/types.js";
import type { OutboxMetrics } from "./ports/delivery-outbox-store.js";
import { HAYASEND_VERSION } from "./version.js";
import {
  ApiKeyService,
  type BootstrapKeyProvider,
} from "./services/api-key-service.js";
import { AttachmentService } from "./services/attachment-service.js";
import { DomainService } from "./services/domain-service.js";
import { EmailService } from "./services/email-service.js";
import {
  OutboxReconciler,
  type OutboxSweepResult,
} from "./services/outbox-reconciler.js";
import { ReceivedEmailService } from "./services/received-email-service.js";
import { RecoveryDiagnosticsService } from "./services/recovery-diagnostics-service.js";
import { SuppressionService } from "./services/suppression-service.js";
import { WebhookService } from "./services/webhook-service.js";
import { TemplateService } from "./services/template-service.js";

export interface Runtime extends AppServices {
  processJob(job: Job, attempt?: number): Promise<void>;
  dispatchOutbox(now?: Date): Promise<OutboxSweepResult>;
  getOutboxMetrics(now?: Date): Promise<OutboxMetrics>;
}

export function createLocalRuntime(config = loadConfig()): Runtime {
  const store = new MemoryStore();
  const queue = new LocalJobQueue();
  const webhooks = new WebhookService(store, queue, {
    httpFetch: fetch,
    validateEndpoint: async () => undefined,
    deliveryRetentionDays: config.webhookDeliveryRetentionDays,
  });
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
  const apiKeys = new ApiKeyService(store, config.apiKey ?? "re_hayasend_dev");
  const templateService = new TemplateService(store, {
    retentionDays: config.templateHistoryRetentionDays,
    limit: config.templateHistoryLimit,
  });
  const emailService = new EmailService(
    store,
    scheduler,
    new ConsoleMailTransport(),
    webhooks,
    suppressions,
    attachmentService,
    templateService,
    {
      provider: {
        name: "local-console",
        adapter_version: HAYASEND_VERSION,
        capability_version: "1.0.0",
      },
    },
  );
  const domainService = new DomainService(
    store,
    new LocalDomainProvider(),
    config.region,
  );
  const recoveryDiagnosticsService = new RecoveryDiagnosticsService(
    store,
    queue,
    {
      provider: "local-console",
      adapter_version: HAYASEND_VERSION,
      capability_version: "1.0.0",
      checked_at: null,
      document: {
        provider: "local-console",
        adapter_version: HAYASEND_VERSION,
        capability_version: "1.0.0",
      },
    },
  );

  const processJob = async (job: Job, attempt = 1) => {
    if (job.type === "send_email") {
      await emailService.processSend(job.email_id, attempt);
      return;
    }
    if (job.type === "reconcile_outbox") {
      await outbox.sweep();
      return;
    }
    if (job.type === "publish_received_email") {
      await receivedEmails.publishWebhook(job.email_id);
      return;
    }
    await webhooks.deliver(job.webhook_id, job.event, job.delivery_id, attempt);
  };
  queue.setHandler(processJob);
  const outbox = new OutboxReconciler(store, queue, {
    owner: createId("dispatcher"),
  });

  return {
    apiKeyService: apiKeys,
    attachmentService,
    domainService,
    emailService,
    templateService,
    receivedEmailService: receivedEmails,
    recoveryDiagnosticsService,
    suppressionService: suppressions,
    webhookService: webhooks,
    processJob,
    dispatchOutbox: (now) => outbox.sweep(now),
    getOutboxMetrics: (now) => outbox.metrics(now),
  };
}

export function createAwsRuntime(
  config: Config = loadConfig(),
  bootstrapKey: string | BootstrapKeyProvider = async () => {
    throw new Error("Bootstrap authentication is unavailable in this runtime.");
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
  const queue = new SqsJobQueue(config.queueUrl, undefined, {
    deliveryDeadLetterQueueUrl: config.deliveryDeadLetterQueueUrl,
    schedulerDeadLetterQueueUrl: config.schedulerDeadLetterQueueUrl,
    inboundDeadLetterQueueUrl: config.inboundDeadLetterQueueUrl,
  });
  const webhooks = new WebhookService(store, queue, {
    httpFetch: createSafeWebhookFetch(),
    validateEndpoint: assertPublicWebhookEndpoint,
    deliveryRetentionDays: config.webhookDeliveryRetentionDays,
  });
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
    schedulerDeadLetterQueueArn: config.schedulerDeadLetterQueueArn,
  });
  const apiKeys = new ApiKeyService(store, bootstrapKey);
  const templateService = new TemplateService(store, {
    retentionDays: config.templateHistoryRetentionDays,
    limit: config.templateHistoryLimit,
  });
  const emailService = new EmailService(
    store,
    scheduler,
    new SesMailTransport(config.configurationSet),
    webhooks,
    suppressions,
    attachmentService,
    templateService,
    {
      provider: {
        name: AWS_SES_CAPABILITIES.provider,
        adapter_version: AWS_SES_CAPABILITIES.adapter_version,
        capability_version: AWS_SES_CAPABILITIES.schema_version,
      },
    },
  );
  const domainService = new DomainService(
    store,
    new SesDomainProvider(),
    config.region,
  );
  const recoveryDiagnosticsService = new RecoveryDiagnosticsService(
    store,
    queue,
    {
      provider: AWS_SES_CAPABILITIES.provider,
      adapter_version: AWS_SES_CAPABILITIES.adapter_version,
      capability_version: AWS_SES_CAPABILITIES.schema_version,
      checked_at: AWS_SES_CAPABILITIES.checked_at,
      document: AWS_SES_CAPABILITIES,
    },
  );
  const outbox = new OutboxReconciler(store, queue, {
    owner: createId("dispatcher"),
  });

  return {
    apiKeyService: apiKeys,
    attachmentService,
    domainService,
    emailService,
    templateService,
    receivedEmailService: receivedEmails,
    recoveryDiagnosticsService,
    suppressionService: suppressions,
    webhookService: webhooks,
    dispatchOutbox: (now) => outbox.sweep(now),
    getOutboxMetrics: (now) => outbox.metrics(now),
    async processJob(job: Job, attempt = 1) {
      if (job.type === "send_email") {
        await emailService.processSend(job.email_id, attempt);
        return;
      }
      if (job.type === "reconcile_outbox") {
        await outbox.sweep();
        return;
      }
      if (job.type === "publish_received_email") {
        await receivedEmails.publishWebhook(job.email_id);
        return;
      }
      await webhooks.deliver(
        job.webhook_id,
        job.event,
        job.delivery_id,
        attempt,
      );
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
