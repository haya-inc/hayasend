import type { DomainProviderResult } from "../core/types.js";

/**
 * Provider-owned sending-domain lifecycle.
 *
 * This port is intentionally independent of the runtime substrate: an Azure
 * Communication Services transport can run on the portable PostgreSQL
 * runtime, while SES can continue to run on the AWS-native runtime.
 */
export interface TransportDomainProvider {
  create(name: string): Promise<DomainProviderResult>;
  get(name: string): Promise<DomainProviderResult>;
  delete(name: string): Promise<void>;
}
