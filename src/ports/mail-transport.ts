import type { EmailRecord } from "../core/types.js";

export interface MailTransportResult {
  provider_id: string;
}

export interface MailTransport {
  send(email: EmailRecord): Promise<MailTransportResult>;
}
