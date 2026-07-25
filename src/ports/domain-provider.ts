import type { DomainProviderResult } from "../core/types.js";

export interface DomainProvider {
  create(name: string): Promise<DomainProviderResult>;
  get(name: string): Promise<DomainProviderResult>;
  delete(name: string): Promise<void>;
}
