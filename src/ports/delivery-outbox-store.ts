import type {
  DeliveryDiagnosticCategory,
  DeliveryMessageRecord,
  OutboxItemRecord,
  RecipientRecord,
} from "../core/delivery-model.js";
import type { EmailRecord, IdempotencyClaim } from "../core/types.js";

export interface DeliveryCommit {
  email: EmailRecord;
  message: DeliveryMessageRecord;
  recipients: RecipientRecord[];
  outbox: OutboxItemRecord;
  idempotency?: IdempotencyClaim | undefined;
}

export interface DeliveryCommitResult extends DeliveryCommit {
  replayed: boolean;
}

export interface LeaseDueOutboxInput {
  owner: string;
  now: Date;
  lease_seconds: number;
  limit: number;
}

export interface OutboxMetrics {
  due: number;
  leased: number;
  undispatched: number;
  oldest_due_age_seconds: number;
  publish_failures_total: number;
}

export interface DeliveryOutboxStore {
  commitDelivery(
    input: DeliveryCommit,
    nowEpochSeconds: number,
  ): Promise<DeliveryCommitResult>;
  getDelivery(messageId: string): Promise<DeliveryCommitResult | undefined>;
  getOutboxItem(id: string): Promise<OutboxItemRecord | undefined>;
  leaseDueOutbox(
    input: LeaseDueOutboxInput,
  ): Promise<OutboxItemRecord[]>;
  acknowledgeOutbox(
    id: string,
    owner: string,
    now: Date,
  ): Promise<boolean>;
  recordOutboxFailure(
    id: string,
    owner: string,
    category: DeliveryDiagnosticCategory,
    now: Date,
  ): Promise<boolean>;
  getOutboxMetrics(now: Date): Promise<OutboxMetrics>;
}
