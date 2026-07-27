import { sha256 } from "../core/crypto.js";
import type { ProviderCapabilityDocument } from "../core/provider-capabilities.js";
import type { Store } from "../ports/store.js";
import type {
  QueueDiagnostics,
  QueueDiagnosticsSnapshot,
} from "../ports/queue-diagnostics.js";

export interface ProviderDiagnosticsEvidence {
  provider: string;
  adapter_version: string;
  capability_version: string;
  checked_at: string | null;
  document: ProviderCapabilityDocument | Record<string, unknown>;
}

export interface RecoveryDiagnostics {
  object: "recovery_diagnostics";
  generated_at: string;
  outbox: {
    due: number;
    leased: number;
    stuck_leases: number;
    undispatched: number;
    oldest_due_age_seconds: number;
    publish_failures_total: number;
    truncated: boolean;
  };
  queues: QueueDiagnosticsSnapshot;
  provider_events: {
    latest_received_at: string | null;
    lag_seconds: number | null;
  };
  capability: {
    provider: string;
    adapter_version: string;
    capability_version: string;
    checked_at: string | null;
    document_sha256: string;
  };
}

function documentDigest(document: unknown): string {
  return sha256(JSON.stringify(document));
}

export class RecoveryDiagnosticsService {
  constructor(
    private readonly store: Store,
    private readonly queues: QueueDiagnostics,
    private readonly provider: ProviderDiagnosticsEvidence,
  ) {}

  async get(now = new Date()): Promise<RecoveryDiagnostics> {
    const [outbox, queues, latestProviderEventAt] = await Promise.all([
      this.store.getOutboxMetrics(now),
      this.queues.getQueueDiagnostics(),
      this.store.getLatestProviderEventReceivedAt(),
    ]);
    const latestTimestamp =
      latestProviderEventAt === undefined
        ? null
        : new Date(latestProviderEventAt).toISOString();
    return {
      object: "recovery_diagnostics",
      generated_at: now.toISOString(),
      outbox,
      queues,
      provider_events: {
        latest_received_at: latestTimestamp,
        lag_seconds:
          latestTimestamp === null
            ? null
            : Math.max(
                0,
                Math.floor(
                  (now.getTime() - Date.parse(latestTimestamp)) / 1_000,
                ),
              ),
      },
      capability: {
        provider: this.provider.provider,
        adapter_version: this.provider.adapter_version,
        capability_version: this.provider.capability_version,
        checked_at: this.provider.checked_at,
        document_sha256: documentDigest(this.provider.document),
      },
    };
  }
}
