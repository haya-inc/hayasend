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

interface RuntimeCapabilityDiagnosticsDocument {
  runtime: string;
  adapter_version: string;
  schema_version: string;
  checked_at: string;
}

interface DeploymentCapabilityDiagnosticsDocument {
  deployment: string;
  adapter_version: string;
  schema_version: string;
  checked_at: string;
  runtime: {
    profile: string;
  };
  transport: {
    provider: string;
  };
  maturity: {
    combination: "experimental" | "beta" | "production";
  };
  production_ready: boolean;
}

export interface CapabilityDiagnosticsEvidence {
  runtime?: RuntimeCapabilityDiagnosticsDocument;
  deployment?: DeploymentCapabilityDiagnosticsDocument;
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
  runtime_capability?: {
    runtime: string;
    adapter_version: string;
    capability_version: string;
    checked_at: string;
    document_sha256: string;
  };
  deployment_capability?: {
    deployment: string;
    adapter_version: string;
    capability_version: string;
    checked_at: string;
    runtime: string;
    provider: string;
    maturity: "experimental" | "beta" | "production";
    production_ready: boolean;
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
    private readonly capabilities: CapabilityDiagnosticsEvidence = {},
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
      ...(this.capabilities.runtime
        ? {
            runtime_capability: {
              runtime: this.capabilities.runtime.runtime,
              adapter_version: this.capabilities.runtime.adapter_version,
              capability_version: this.capabilities.runtime.schema_version,
              checked_at: this.capabilities.runtime.checked_at,
              document_sha256: documentDigest(this.capabilities.runtime),
            },
          }
        : {}),
      ...(this.capabilities.deployment
        ? {
            deployment_capability: {
              deployment: this.capabilities.deployment.deployment,
              adapter_version:
                this.capabilities.deployment.adapter_version,
              capability_version:
                this.capabilities.deployment.schema_version,
              checked_at: this.capabilities.deployment.checked_at,
              runtime: this.capabilities.deployment.runtime.profile,
              provider: this.capabilities.deployment.transport.provider,
              maturity: this.capabilities.deployment.maturity.combination,
              production_ready:
                this.capabilities.deployment.production_ready,
              document_sha256: documentDigest(
                this.capabilities.deployment,
              ),
            },
          }
        : {}),
    };
  }
}
