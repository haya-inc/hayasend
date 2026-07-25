import type { AppServices } from "./app.js";
import { DynamoStore } from "./adapters/dynamo-store.js";
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
import { DomainService } from "./services/domain-service.js";
import { EmailService } from "./services/email-service.js";
import { WebhookService } from "./services/webhook-service.js";

export interface Runtime extends AppServices {
  processJob(job: Job, attempt?: number): Promise<void>;
}

export function createLocalRuntime(config = loadConfig()): Runtime {
  const store = new MemoryStore();
  const queue = new LocalJobQueue();
  const webhooks = new WebhookService(store, queue);
  const emailService = new EmailService(
    store,
    queue,
    new ConsoleMailTransport(),
    webhooks,
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
    await webhooks.deliver(job.webhook_id, job.event);
  };
  queue.setHandler(processJob);

  return {
    apiKey: config.apiKey,
    domainService,
    emailService,
    webhookService: webhooks,
    processJob,
  };
}

export function createAwsRuntime(config: Config = loadConfig()): Runtime {
  if (!config.tableName || !config.queueUrl || !config.payloadBucket) {
    throw new Error(
      "HAYASEND_TABLE_NAME, HAYASEND_QUEUE_URL, and HAYASEND_PAYLOAD_BUCKET are required in AWS mode.",
    );
  }
  const store = new DynamoStore(config.tableName, config.payloadBucket);
  const queue = new SqsJobQueue(config.queueUrl);
  const webhooks = new WebhookService(store, queue);
  const emailService = new EmailService(
    store,
    queue,
    new SesMailTransport(config.configurationSet),
    webhooks,
  );
  const domainService = new DomainService(
    store,
    new SesDomainProvider(),
    config.region,
  );

  return {
    apiKey: config.apiKey,
    domainService,
    emailService,
    webhookService: webhooks,
    async processJob(job: Job, attempt = 1) {
      if (job.type === "send_email") {
        await emailService.processSend(job.email_id, attempt);
        return;
      }
      await webhooks.deliver(job.webhook_id, job.event);
    },
  };
}

export function createRuntime(config = loadConfig()): Runtime {
  return config.mode === "aws"
    ? createAwsRuntime(config)
    : createLocalRuntime(config);
}
