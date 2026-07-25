import { describe, expect, it, vi } from "vitest";
import {
  normalizeInboundEvent,
  processInboundEvent,
} from "../src/aws/inbound.js";

const ses = {
  mail: {
    timestamp: "2026-07-26T08:00:00.000Z",
    source: "sender@example.com",
    messageId: "aws-message-42",
    destination: ["header-only@example.net"],
  },
  receipt: {
    recipients: ["first@example.net", "second@example.net"],
    spamVerdict: { status: "PASS" },
    virusVerdict: { status: "PASS" },
    spfVerdict: { status: "PASS" },
    dkimVerdict: { status: "PASS" },
    dmarcVerdict: { status: "PASS" },
  },
};

describe("Mail Manager Lambda events", () => {
  it("normalizes SES receipt metadata without duplicating recipients", () => {
    expect(normalizeInboundEvent(ses)).toEqual({
      provider_message_id: "aws-message-42",
      source: "sender@example.com",
      destinations: ["first@example.net", "second@example.net"],
      timestamp: "2026-07-26T08:00:00.000Z",
      verdicts: {
        spam: "PASS",
        virus: "PASS",
        spf: "PASS",
        dkim: "PASS",
        dmarc: "PASS",
      },
    });
  });

  it("accepts both SES Records and direct Mail Manager payloads", async () => {
    const ingest = vi.fn(async () => undefined);
    const services = { receivedEmailService: { ingest } };

    await processInboundEvent(
      {
        Records: [{ eventSource: "aws:ses", ses }],
      },
      services,
    );
    await processInboundEvent(ses, services);

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider_message_id: "aws-message-42",
      }),
    );
  });

  it("rejects unrelated event sources and incomplete records", async () => {
    const services = {
      receivedEmailService: { ingest: vi.fn(async () => undefined) },
    };
    await expect(
      processInboundEvent(
        {
          Records: [{ eventSource: "aws:sns", ses }],
        },
        services,
      ),
    ).rejects.toThrow("not Amazon SES");
    await expect(
      processInboundEvent(
        {
          Records: [{ eventSource: "aws:ses", ses: { mail: {} } }],
        },
        services,
      ),
    ).rejects.toThrow("missing mail.messageId");
    expect(() =>
      normalizeInboundEvent({
        ...ses,
        mail: { ...ses.mail, destination: [] },
        receipt: { ...ses.receipt, recipients: [] },
      }),
    ).toThrow("does not contain any recipients");
  });
});
