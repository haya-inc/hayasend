import type { Pool } from "pg";
import { CommunicationServiceManagementClient } from "@azure/arm-communication";
import { EmailClient } from "@azure/communication-email";
import { DefaultAzureCredential } from "@azure/identity";
import type { AppServices } from "./app.js";
import {
  DisabledAttachmentStorage,
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
import { ACS_EMAIL_CAPABILITIES } from "./adapters/azure/acs-email-capabilities.js";
import { AcsDomainProvider } from "./adapters/azure/acs-domain-provider.js";
import {
  AcsEmailEventGridIngress,
  type AcsEmailEventIngressResult,
} from "./adapters/azure/acs-email-events.js";
import {
  AcsEmailTransport,
  assertAcsEmailRecordPreflight,
} from "./adapters/azure/acs-email-transport.js";
import { MemoryStore } from "./adapters/memory-store.js";
import { PostgresJobQueue } from "./adapters/postgres/postgres-job-queue.js";
import {
  assertPostgresReady,
  createPostgresPool,
} from "./adapters/postgres/postgres-pool.js";
import { PostgresStore } from "./adapters/postgres/postgres-store.js";
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
import { SendGridApiClient } from "./adapters/sendgrid/sendgrid-api-client.js";
import { SendGridDomainProvider } from "./adapters/sendgrid/sendgrid-domain-provider.js";
import { SENDGRID_EMAIL_CAPABILITIES } from "./adapters/sendgrid/sendgrid-email-capabilities.js";
import {
  SendGridEmailEventIngress,
  type SendGridEmailEventContext,
} from "./adapters/sendgrid/sendgrid-email-events.js";
import {
  assertSendGridEmailRecordPreflight,
  SendGridMailTransport,
} from "./adapters/sendgrid/sendgrid-email-transport.js";
import { loadConfig, type Config } from "./config.js";
import { createId } from "./core/crypto.js";
import type { Job } from "./core/types.js";
import type { AttachmentStorage } from "./ports/attachment-storage.js";
import type { OutboxMetrics } from "./ports/delivery-outbox-store.js";
import type { TransportEventIngress } from "./ports/transport-event-ingress.js";
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
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
  transportEventIngress?: TransportEventIngress<
    unknown,
    { received_at?: string | undefined },
    AcsEmailEventIngressResult
  >;
  sendGridEventIngress?: TransportEventIngress<
    Uint8Array,
    SendGridEmailEventContext
  >;
}

export interface PortableRuntime extends Runtime {
  jobQueue: PostgresJobQueue;
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
    checkReadiness: async () => undefined,
    close: async () => undefined,
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
    checkReadiness: async () => undefined,
    close: async () => undefined,
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

export function createPortableRuntime(
  config: Config,
  pool: Pool = createPostgresPool(config, "hayasend"),
  attachmentStorage: AttachmentStorage = new DisabledAttachmentStorage(),
): PortableRuntime {
  if (
    config.mode !== "portable" ||
    !config.apiKey ||
    !config.portableTransport ||
    config.jobMaxAttempts === undefined
  ) {
    throw new Error("Portable runtime settings are incomplete.");
  }
  const store = new PostgresStore(pool);
  const queue = new PostgresJobQueue(pool, {
    max_attempts: config.jobMaxAttempts,
  });
  const webhooks = new WebhookService(store, queue, {
    httpFetch: createSafeWebhookFetch(),
    validateEndpoint: assertPublicWebhookEndpoint,
    deliveryRetentionDays: config.webhookDeliveryRetentionDays,
  });
  const receivedEmails = new ReceivedEmailService(
    store,
    new DisabledInboundStorage(),
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
    attachmentStorage,
  );
  const scheduler = new QueueEmailScheduler(queue);
  const apiKeys = new ApiKeyService(store, config.apiKey);
  const templateService = new TemplateService(store, {
    retentionDays: config.templateHistoryRetentionDays,
    limit: config.templateHistoryLimit,
  });
  const usesSes = config.portableTransport === "aws-ses";
  const usesAcs =
    config.portableTransport === "azure-communication-services";
  const usesSendGrid = config.portableTransport === "sendgrid";
  if (
    usesAcs &&
    (!config.azureCommunicationEmailEndpoint ||
      !config.azureSubscriptionId ||
      !config.azureResourceGroup ||
      !config.azureCommunicationServiceName ||
      !config.azureEmailServiceName ||
      !config.azureEmailDomainResourceName)
  ) {
    throw new Error(
      "Azure Communication Services runtime settings are incomplete.",
    );
  }
  if (
    usesSendGrid &&
    (!config.sendGridApiKey || !config.sendGridApiBaseUrl)
  ) {
    throw new Error("SendGrid runtime settings are incomplete.");
  }
  const azureCredential = usesAcs
    ? new DefaultAzureCredential()
    : undefined;
  const sendGridClient = usesSendGrid
    ? new SendGridApiClient(
        config.sendGridApiKey!,
        config.sendGridApiBaseUrl!,
      )
    : undefined;
  const provider = usesSes
    ? {
        name: AWS_SES_CAPABILITIES.provider,
        adapter_version: AWS_SES_CAPABILITIES.adapter_version,
        capability_version: AWS_SES_CAPABILITIES.schema_version,
      }
    : usesAcs
      ? {
          name: ACS_EMAIL_CAPABILITIES.provider,
          adapter_version: ACS_EMAIL_CAPABILITIES.adapter_version,
          capability_version: ACS_EMAIL_CAPABILITIES.schema_version,
        }
      : usesSendGrid
        ? {
            name: SENDGRID_EMAIL_CAPABILITIES.provider,
            adapter_version: SENDGRID_EMAIL_CAPABILITIES.adapter_version,
            capability_version: SENDGRID_EMAIL_CAPABILITIES.schema_version,
          }
      : {
          name: "portable-console",
          adapter_version: HAYASEND_VERSION,
          capability_version: "1.0.0",
        };
  const mailTransport = usesSes
    ? new SesMailTransport(config.configurationSet)
    : usesAcs
      ? new AcsEmailTransport(
          new EmailClient(
            config.azureCommunicationEmailEndpoint!,
            azureCredential!,
          ),
        )
      : usesSendGrid
        ? new SendGridMailTransport(sendGridClient!)
      : new ConsoleMailTransport();
  const emailService = new EmailService(
    store,
    scheduler,
    mailTransport,
    webhooks,
    suppressions,
    attachmentService,
    templateService,
    {
      provider,
      ...(usesAcs || usesSendGrid
        ? {
            pre_commit_validator: (record) => {
              if (usesAcs) {
                assertAcsEmailRecordPreflight(record);
              } else {
                assertSendGridEmailRecordPreflight(record);
              }
            },
          }
        : {}),
    },
  );
  const domainProvider = usesSes
    ? new SesDomainProvider()
    : usesAcs
      ? new AcsDomainProvider(
          {
            resource_group: config.azureResourceGroup!,
            email_service_name: config.azureEmailServiceName!,
            communication_service_name:
              config.azureCommunicationServiceName!,
            domain_resource_name: config.azureEmailDomainResourceName!,
          },
          new CommunicationServiceManagementClient(
            azureCredential!,
            config.azureSubscriptionId!,
          ),
        )
      : usesSendGrid
        ? new SendGridDomainProvider(sendGridClient!)
      : new LocalDomainProvider();
  const domainService = new DomainService(
    store,
    domainProvider,
    config.region,
  );
  const providerEvidence = usesSes
    ? {
        provider: AWS_SES_CAPABILITIES.provider,
        adapter_version: AWS_SES_CAPABILITIES.adapter_version,
        capability_version: AWS_SES_CAPABILITIES.schema_version,
        checked_at: AWS_SES_CAPABILITIES.checked_at,
        document: AWS_SES_CAPABILITIES,
      }
    : usesAcs
      ? {
          provider: ACS_EMAIL_CAPABILITIES.provider,
          adapter_version: ACS_EMAIL_CAPABILITIES.adapter_version,
          capability_version: ACS_EMAIL_CAPABILITIES.schema_version,
          checked_at: ACS_EMAIL_CAPABILITIES.checked_at,
          document: ACS_EMAIL_CAPABILITIES,
        }
      : usesSendGrid
        ? {
            provider: SENDGRID_EMAIL_CAPABILITIES.provider,
            adapter_version: SENDGRID_EMAIL_CAPABILITIES.adapter_version,
            capability_version: SENDGRID_EMAIL_CAPABILITIES.schema_version,
            checked_at: SENDGRID_EMAIL_CAPABILITIES.checked_at,
            document: SENDGRID_EMAIL_CAPABILITIES,
          }
      : {
          provider: "portable-console",
          adapter_version: HAYASEND_VERSION,
          capability_version: "1.0.0",
          checked_at: null,
          document: {
            provider: "portable-console",
            adapter_version: HAYASEND_VERSION,
            capability_version: "1.0.0",
            development_only: true,
          },
        };
  const recoveryDiagnosticsService = new RecoveryDiagnosticsService(
    store,
    queue,
    providerEvidence,
  );
  const outbox = new OutboxReconciler(store, queue, {
    owner: createId("dispatcher"),
  });
  const transportEventIngress = usesAcs
    ? new AcsEmailEventGridIngress(
        {
          resolver: {
            findMessageIdByProviderMessageId: (providerMessageId) =>
              store.findMessageIdByProviderMessageId(
                ACS_EMAIL_CAPABILITIES.provider,
                providerMessageId,
              ),
          },
          emailService,
          suppressionService: suppressions,
        },
        {
          expected_topic:
            `/subscriptions/${config.azureSubscriptionId!}` +
            `/resourceGroups/${config.azureResourceGroup!}` +
            "/providers/Microsoft.Communication/communicationServices/" +
            config.azureCommunicationServiceName!,
        },
      )
    : undefined;
  const sendGridEventIngress =
    usesSendGrid && config.sendGridEventWebhookPublicKey
    ? new SendGridEmailEventIngress(
        {
          emailService,
          suppressionService: suppressions,
        },
        config.sendGridEventWebhookPublicKey,
      )
    : undefined;

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
    jobQueue: queue,
    ...(transportEventIngress ? { transportEventIngress } : {}),
    ...(sendGridEventIngress ? { sendGridEventIngress } : {}),
    dispatchOutbox: (now) => outbox.sweep(now),
    getOutboxMetrics: (now) => outbox.metrics(now),
    checkReadiness: async () => {
      await Promise.all([
        assertPostgresReady(pool),
        attachmentStorage.checkReadiness?.(),
      ]);
    },
    close: () => pool.end(),
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
  portableAttachmentStorage?: AttachmentStorage,
): Runtime {
  if (config.mode === "local") {
    return createLocalRuntime(config);
  }
  if (config.mode === "portable") {
    return createPortableRuntime(
      config,
      undefined,
      portableAttachmentStorage,
    );
  }
  if (!bootstrapKey) {
    throw new Error("AWS API runtime requires a bootstrap key provider.");
  }
  return createAwsRuntime(config, bootstrapKey);
}
