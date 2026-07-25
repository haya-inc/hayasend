import { createId } from "../core/crypto.js";
import { NotFoundError } from "../core/errors.js";
import type { DomainRecord, Page } from "../core/types.js";
import type { DomainProvider } from "../ports/domain-provider.js";
import type { Store } from "../ports/store.js";

export class DomainService {
  constructor(
    private readonly store: Store,
    private readonly provider: DomainProvider,
    private readonly region: string,
  ) {}

  async create(name: string): Promise<DomainRecord> {
    const normalizedName = name.trim().toLowerCase().replace(/\.$/, "");
    const providerResult = await this.provider.create(normalizedName);
    const now = new Date().toISOString();
    const record: DomainRecord = {
      id: createId("dom"),
      name: normalizedName,
      status: providerResult.status,
      region: this.region,
      records: providerResult.records,
      created_at: now,
      updated_at: now,
    };
    await this.store.createDomain(record);
    return record;
  }

  async get(id: string): Promise<DomainRecord> {
    const record = await this.store.getDomain(id);
    if (!record) {
      throw new NotFoundError("Domain");
    }
    return record;
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<DomainRecord>> {
    return this.store.listDomains(limit, cursor);
  }

  async verify(id: string): Promise<DomainRecord> {
    const record = await this.get(id);
    const providerResult = await this.provider.get(record.name);
    const updated = await this.store.updateDomain(id, {
      status: providerResult.status,
      records: providerResult.records,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      throw new NotFoundError("Domain");
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    const record = await this.get(id);
    await this.provider.delete(record.name);
    if (!(await this.store.deleteDomain(id))) {
      throw new NotFoundError("Domain");
    }
  }
}
