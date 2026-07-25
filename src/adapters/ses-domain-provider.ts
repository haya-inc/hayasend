import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { sha256 } from "../core/crypto.js";
import type {
  DomainDnsRecord,
  DomainProviderResult,
} from "../core/types.js";
import type { DomainProvider } from "../ports/domain-provider.js";

function dmarcRecord(name: string): DomainDnsRecord {
  return {
    record: "DMARC",
    name: `_dmarc.${name}`,
    type: "TXT",
    value: "v=DMARC1; p=none;",
    status: "pending",
  };
}

export class SesDomainProvider implements DomainProvider {
  constructor(private readonly client = new SESv2Client({})) {}

  async create(name: string): Promise<DomainProviderResult> {
    const result = await this.client.send(
      new CreateEmailIdentityCommand({ EmailIdentity: name }),
    );
    const tokens = result.DkimAttributes?.Tokens ?? [];
    return {
      status: result.VerifiedForSendingStatus ? "verified" : "pending",
      records: [
        ...tokens.map<DomainDnsRecord>((token) => ({
          record: "DKIM",
          name: `${token}._domainkey.${name}`,
          type: "CNAME",
          value: `${token}.dkim.amazonses.com`,
          status: "pending",
        })),
        dmarcRecord(name),
      ],
    };
  }

  async get(name: string): Promise<DomainProviderResult> {
    const result = await this.client.send(
      new GetEmailIdentityCommand({ EmailIdentity: name }),
    );
    const dkimVerified = result.DkimAttributes?.Status === "SUCCESS";
    const status =
      result.VerifiedForSendingStatus && dkimVerified ? "verified" : "pending";
    return {
      status,
      records: [
        ...(result.DkimAttributes?.Tokens ?? []).map<DomainDnsRecord>(
          (token) => ({
            record: "DKIM",
            name: `${token}._domainkey.${name}`,
            type: "CNAME",
            value: `${token}.dkim.amazonses.com`,
            status: dkimVerified ? "verified" : "pending",
          }),
        ),
        dmarcRecord(name),
      ],
    };
  }

  async delete(name: string): Promise<void> {
    await this.client.send(
      new DeleteEmailIdentityCommand({ EmailIdentity: name }),
    );
  }
}

export class LocalDomainProvider implements DomainProvider {
  async create(name: string): Promise<DomainProviderResult> {
    return this.result(name);
  }

  async get(name: string): Promise<DomainProviderResult> {
    return this.result(name);
  }

  async delete(_name: string): Promise<void> {}

  private result(name: string): DomainProviderResult {
    const token = sha256(name).slice(0, 32);
    return {
      status: "verified",
      records: [
        {
          record: "DKIM",
          name: `${token}._domainkey.${name}`,
          type: "CNAME",
          value: `${token}.dkim.local.hayasend.dev`,
          status: "verified",
        },
        {
          ...dmarcRecord(name),
          status: "verified",
        },
      ],
    };
  }
}
