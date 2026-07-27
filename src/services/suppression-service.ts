import { sha256 } from "../core/crypto.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type {
  Page,
  SuppressionReason,
  SuppressionRecord,
} from "../core/types.js";
import type { Store } from "../ports/store.js";

type SuppressionStore = Pick<
  Store,
  | "putSuppression"
  | "getSuppression"
  | "deleteSuppression"
  | "listSuppressions"
>;

export function normalizeMailbox(value: string): string {
  const trimmed = value.trim();
  const angleAddress = /<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed)?.[1];
  const normalized = (angleAddress ?? trimmed).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ValidationError(`Invalid email address: ${value}`);
  }
  return normalized;
}

export class SuppressionService {
  constructor(private readonly store: SuppressionStore) {}

  async put(input: {
    email: string;
    reason: SuppressionReason;
    source_email_id?: string | undefined;
    detail?: string | undefined;
  }): Promise<SuppressionRecord> {
    const email = normalizeMailbox(input.email);
    const id = sha256(email);
    const existing = await this.store.getSuppression(id);
    const now = new Date().toISOString();
    const record: SuppressionRecord = {
      id,
      email,
      reason: input.reason,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      ...(input.source_email_id
        ? { source_email_id: input.source_email_id }
        : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    await this.store.putSuppression(record);
    return record;
  }

  async get(email: string): Promise<SuppressionRecord> {
    const normalized = normalizeMailbox(email);
    const record = await this.store.getSuppression(sha256(normalized));
    if (!record) {
      throw new NotFoundError("Suppression");
    }
    return record;
  }

  async findSuppressed(addresses: string[]): Promise<SuppressionRecord[]> {
    const normalized = [...new Set(addresses.map(normalizeMailbox))];
    const records = await Promise.all(
      normalized.map((email) => this.store.getSuppression(sha256(email))),
    );
    return records.filter(
      (record): record is SuppressionRecord => record !== undefined,
    );
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<SuppressionRecord>> {
    return this.store.listSuppressions(limit, cursor);
  }

  async delete(email: string): Promise<void> {
    const normalized = normalizeMailbox(email);
    if (!(await this.store.deleteSuppression(sha256(normalized)))) {
      throw new NotFoundError("Suppression");
    }
  }
}
