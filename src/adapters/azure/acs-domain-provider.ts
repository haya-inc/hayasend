import type {
  CommunicationServiceResource,
  DomainResource,
  DnsRecord,
  DomainPropertiesVerificationStates,
} from "@azure/arm-communication";
import { PreconditionFailedError } from "../../core/errors.js";
import type {
  DomainDnsRecord,
  DomainProviderResult,
} from "../../core/types.js";
import type { TransportDomainProvider } from "../../ports/transport-domain-provider.js";

export interface AcsDomainManagementClient {
  domains: {
    get(
      resourceGroupName: string,
      emailServiceName: string,
      domainName: string,
    ): Promise<DomainResource>;
  };
  communicationServices: {
    get(
      resourceGroupName: string,
      communicationServiceName: string,
    ): Promise<CommunicationServiceResource>;
  };
}

export interface AcsDomainProviderOptions {
  resource_group: string;
  email_service_name: string;
  communication_service_name: string;
  domain_resource_name: string;
}

function verificationStatus(
  value: string | undefined,
): DomainDnsRecord["status"] {
  if (value === "Verified") {
    return "verified";
  }
  if (value === "VerificationFailed") {
    return "failed";
  }
  return "pending";
}

function dnsRecord(
  record: DomainDnsRecord["record"],
  value: DnsRecord | undefined,
  status: string | undefined,
): DomainDnsRecord | undefined {
  if (
    !value?.name ||
    !value.value ||
    !["TXT", "CNAME", "MX"].includes(value.type ?? "")
  ) {
    return undefined;
  }
  return {
    record,
    name: value.name,
    type: value.type as DomainDnsRecord["type"],
    value: value.value,
    status: verificationStatus(status),
  };
}

function providerResult(resource: DomainResource): DomainProviderResult {
  const states = resource.verificationStates ?? {};
  const records = resource.verificationRecords ?? {};
  const mappedRecords = [
    dnsRecord("SPF", records.spf, states.spf?.status),
    dnsRecord("DKIM", records.dkim, states.dkim?.status),
    dnsRecord("DKIM", records.dkim2, states.dkim2?.status),
    dnsRecord("DMARC", records.dmarc, states.dmarc?.status),
  ].filter(
    (record): record is DomainDnsRecord => record !== undefined,
  );
  const requiredStates: Array<
    keyof DomainPropertiesVerificationStates
  > = ["domain", "spf", "dkim", "dkim2"];
  const statuses = requiredStates.map(
    (key) => states[key]?.status ?? "NotStarted",
  );
  const failed =
    resource.provisioningState === "Failed" ||
    statuses.includes("VerificationFailed");
  const verified =
    resource.provisioningState === "Succeeded" &&
    statuses.every((status) => status === "Verified");
  return {
    status: failed ? "failed" : verified ? "verified" : "pending",
    records: mappedRecords,
  };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export class AcsDomainProvider implements TransportDomainProvider {
  constructor(
    private readonly options: AcsDomainProviderOptions,
    private readonly client: AcsDomainManagementClient,
  ) {}

  async create(name: string): Promise<DomainProviderResult> {
    return this.inspect(name);
  }

  async get(name: string): Promise<DomainProviderResult> {
    return this.inspect(name);
  }

  async delete(_name: string): Promise<void> {
    // The API unregisters the local domain record only. Azure resources and
    // DNS ownership remain operator-managed to avoid destructive surprises.
  }

  private async inspect(name: string): Promise<DomainProviderResult> {
    const [domain, communicationService] = await Promise.all([
      this.client.domains.get(
        this.options.resource_group,
        this.options.email_service_name,
        this.options.domain_resource_name,
      ),
      this.client.communicationServices.get(
        this.options.resource_group,
        this.options.communication_service_name,
      ),
    ]);
    if (
      !domain.id ||
      normalizeDomain(domain.fromSenderDomain ?? "") !==
        normalizeDomain(name) ||
      !(communicationService.linkedDomains ?? []).some(
        (linked) => linked.toLowerCase() === domain.id!.toLowerCase(),
      )
    ) {
      throw new PreconditionFailedError(
        "The Azure email domain is not the configured, linked sending identity.",
      );
    }
    return providerResult(domain);
  }
}
