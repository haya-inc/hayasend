import type {
  DeliveryAttemptRecord,
  ProviderEventRecord,
  RecipientRecord,
  DeliveryMessageRecord,
} from "../core/delivery-model.js";
import type { AttemptCompletion } from "../core/recipient-ledger.js";
import type { EmailRecord } from "../core/types.js";

export interface DeliveryLedgerSnapshot {
  email: EmailRecord;
  message: DeliveryMessageRecord;
  recipients: RecipientRecord[];
  attempts: DeliveryAttemptRecord[];
  events: ProviderEventRecord[];
}

export interface DeliveryLedgerMutationResult
  extends DeliveryLedgerSnapshot {
  replayed: boolean;
  changed_recipient_ids: string[];
  attempt?: DeliveryAttemptRecord | undefined;
  event?: ProviderEventRecord | undefined;
}

export interface DeliveryLedgerStore {
  getDeliveryLedger(
    messageId: string,
  ): Promise<DeliveryLedgerSnapshot | undefined>;
  beginDeliveryAttempt(
    attempt: DeliveryAttemptRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined>;
  completeDeliveryAttempt(
    input: AttemptCompletion,
  ): Promise<DeliveryLedgerMutationResult | undefined>;
  appendProviderEvent(
    event: ProviderEventRecord,
  ): Promise<DeliveryLedgerMutationResult | undefined>;
  applyLocalDeliveryState(
    messageId: string,
    status: "canceled" | "suppressed",
    updatedAt: string,
  ): Promise<DeliveryLedgerMutationResult | undefined>;
  getProviderEvent(id: string): Promise<ProviderEventRecord | undefined>;
}
