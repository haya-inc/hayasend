export const PRICING_LAST_VERIFIED: string;

export const PRICING_SOURCES: Readonly<Record<string, string>>;

export const PAID_RATES: Readonly<Record<string, number>>;

export interface CloudflareCostComponent {
  quantity: number;
  included: number;
  billable_quantity: number;
  unit_size: number;
  unit_rate_usd: number;
  monthly_usd: number;
}

export interface CloudflareCostEstimate {
  object: "cloudflare_cost_estimate";
  pricing_last_verified: string;
  provider_maturity: "beta";
  profile: string;
  observed_inputs: Record<string, number>;
  calculated_usage: Record<string, number>;
  components: Record<string, CloudflareCostComponent> & {
    workers_subscription: CloudflareCostComponent;
    workers_requests: CloudflareCostComponent;
    workers_cpu_ms: CloudflareCostComponent;
    d1_rows_read: CloudflareCostComponent;
    d1_rows_written: CloudflareCostComponent;
    d1_storage_gb_month: CloudflareCostComponent;
    r2_storage_gb_month: CloudflareCostComponent;
    r2_class_a: CloudflareCostComponent;
    r2_class_b: CloudflareCostComponent;
    queue_operations: CloudflareCostComponent;
    email_messages: CloudflareCostComponent;
  };
  monthly_usd: number;
}

export function estimateCloudflareCosts(options?: {
  profile?: string;
  observed?: Record<string, number>;
}): CloudflareCostEstimate;
