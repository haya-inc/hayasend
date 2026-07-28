import { z } from "zod";
import {
  PreconditionFailedError,
  RegisteredDomainError,
} from "../../core/errors.js";
import type {
  DomainDnsRecord,
  DomainProviderResult,
} from "../../core/types.js";
import type { TransportDomainProvider } from "../../ports/transport-domain-provider.js";
import type { SendGridApi } from "./sendgrid-api-client.js";

const dnsRecordSchema = z.object({
  valid: z.boolean().optional(),
  type: z.string().optional(),
  host: z.string().optional(),
  data: z.string().optional(),
});

const sendGridDomainSchema = z.object({
  id: z.number().int().positive(),
  domain: z.string().min(1).max(253),
  valid: z.boolean().optional(),
  dns: z
    .object({
      mail_cname: dnsRecordSchema.optional(),
      dkim1: dnsRecordSchema.optional(),
      dkim2: dnsRecordSchema.optional(),
    })
    .optional(),
});

type SendGridDomain = z.infer<typeof sendGridDomainSchema>;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function dnsRecord(
  record: DomainDnsRecord["record"],
  input: z.infer<typeof dnsRecordSchema> | undefined,
): DomainDnsRecord | undefined {
  if (
    !input?.host ||
    !input.data ||
    !["cname", "txt", "mx"].includes(input.type?.toLowerCase() ?? "")
  ) {
    return undefined;
  }
  return {
    record,
    name: input.host,
    type: input.type!.toUpperCase() as DomainDnsRecord["type"],
    value: input.data,
    status: input.valid ? "verified" : "pending",
  };
}

function providerResult(domain: SendGridDomain): DomainProviderResult {
  const records = [
    dnsRecord("SPF", domain.dns?.mail_cname),
    dnsRecord("DKIM", domain.dns?.dkim1),
    dnsRecord("DKIM", domain.dns?.dkim2),
  ].filter((value): value is DomainDnsRecord => value !== undefined);
  return {
    status: domain.valid ? "verified" : "pending",
    records,
  };
}

export class SendGridDomainProvider implements TransportDomainProvider {
  constructor(private readonly client: SendGridApi) {}

  async create(name: string): Promise<DomainProviderResult> {
    const existing = await this.find(name);
    if (existing) {
      throw new RegisteredDomainError(name);
    }
    const response = await this.client.request({
      method: "POST",
      path: "/v3/whitelabel/domains",
      body: {
        domain: normalizeDomain(name),
        automatic_security: true,
      },
      expected_statuses: [201],
    });
    return providerResult(
      sendGridDomainSchema.parse(await response.json()),
    );
  }

  async get(name: string): Promise<DomainProviderResult> {
    const domain = await this.find(name);
    if (!domain) {
      throw new PreconditionFailedError(
        "The SendGrid sending domain is not authenticated in the configured account.",
      );
    }
    return providerResult(domain);
  }

  async delete(name: string): Promise<void> {
    const domain = await this.find(name);
    if (!domain) {
      return;
    }
    await this.client.request({
      method: "DELETE",
      path: `/v3/whitelabel/domains/${domain.id}`,
      expected_statuses: [204],
    });
  }

  private async find(name: string): Promise<SendGridDomain | undefined> {
    const normalized = normalizeDomain(name);
    const exact: SendGridDomain[] = [];
    const pageSize = 200;
    for (let offset = 0; offset < 3_000; offset += pageSize) {
      const query = new URLSearchParams({
        domain: normalized,
        exclude_subusers: "true",
        limit: String(pageSize),
        offset: String(offset),
      });
      const response = await this.client.request({
        method: "GET",
        path: `/v3/whitelabel/domains?${query.toString()}`,
        expected_statuses: [200],
      });
      const page = z
        .array(sendGridDomainSchema)
        .max(pageSize)
        .parse(await response.json());
      exact.push(
        ...page.filter(
          (domain) => normalizeDomain(domain.domain) === normalized,
        ),
      );
      if (page.length < pageSize) {
        break;
      }
    }
    if (exact.length > 1) {
      throw new PreconditionFailedError(
        "The SendGrid account returned more than one exact authenticated domain.",
      );
    }
    return exact[0];
  }
}
