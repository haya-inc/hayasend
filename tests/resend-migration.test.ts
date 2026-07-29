import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessResendInventory,
  buildResendMigrationReport,
  resendEvidenceSchema,
  resendInventorySchema,
  resendMigrationCommand,
  type ResendEvidence,
  type ResendInventory,
} from "../src/cli-resend-migration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function inventory(
  overrides: Partial<ResendInventory["features"]> = {},
  extraStreamFeatures: string[] = [],
): ResendInventory {
  return resendInventorySchema.parse({
    schema_version: 1,
    workload: {
      name: "account notifications",
      environment: "production",
      estimated_daily_volume: 100,
    },
    sdks: [
      {
        language: "TypeScript",
        package: "resend",
        version: "6.18.1",
      },
    ],
    features: {
      send_fields: [
        "from",
        "to",
        "subject",
        "html",
        "text",
        "headers",
        "tags",
        "idempotency_key",
      ],
      templates: { used: true, count: 2 },
      webhooks: {
        events: [
          "email.sent",
          "email.delivered",
          "email.bounced",
          "email.complained",
        ],
        verifies_signatures: true,
      },
      suppressions: { used: true, estimated_count: 3 },
      schedules: { used: false, maximum_horizon_days: 0 },
      inbound: { used: false },
      marketing: { used: false, apis: [] },
      ...overrides,
    },
    streams: [
      {
        name: "password-reset",
        criticality: "critical",
        daily_volume: 20,
        required_canary_messages: 10,
        features: [
          "from",
          "to",
          "subject",
          "html",
          "text",
          "headers",
          "tags",
          "idempotency_key",
          "templates",
          "webhooks",
          "suppressions",
          ...extraStreamFeatures,
        ],
      },
    ],
  });
}

function evidence(overrides: Partial<ResendEvidence> = {}): ResendEvidence {
  return resendEvidenceSchema.parse({
    schema_version: 1,
    observed_at: "2026-07-29T00:00:00.000Z",
    ses: { production_access: true, sending_enabled: true },
    dogfood: { calendar_days: 14, controlled_notifications: 1_000 },
    references: {
      ses: "https://github.com/haya-inc/hayasend/issues/126",
      dogfood: "https://github.com/haya-inc/hayasend/issues/105",
      reconciliation: "https://github.com/haya-inc/hayasend/issues/174",
    },
    reconciliation: {
      sdk_contract_verified: true,
      source_templates: 2,
      target_templates: 2,
      source_suppressions: 3,
      target_suppressions: 3,
      webhooks_verified: true,
      inbound_verified: false,
    },
    streams: [
      {
        name: "password-reset",
        comparison_messages: 10,
        terminal_event_matches: 10,
        mailbox_receipts: 10,
        rollback_rehearsed: true,
        verified_features: [
          "from",
          "to",
          "subject",
          "html",
          "text",
          "headers",
          "tags",
          "idempotency_key",
          "templates",
          "webhooks",
          "suppressions",
        ],
        evidence_url: "https://github.com/haya-inc/hayasend/issues/174",
      },
    ],
    ...overrides,
  });
}

describe("Resend migration inventory and report", () => {
  it("accepts a supported workload for controlled canary only", () => {
    const result = assessResendInventory(inventory());
    expect(result.disposition).toBe("CANARY_ELIGIBLE");
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContain(
      "Suppression migration requires a reviewed export/import and exact count reconciliation.",
    );
  });

  it("blocks unsupported marketing APIs and schedules beyond 30 days", () => {
    const result = assessResendInventory(
      inventory({
        schedules: { used: true, maximum_horizon_days: 45 },
        marketing: { used: true, apis: ["broadcasts", "audiences"] },
      }, ["schedules"]),
    );
    expect(result.disposition).toBe("BLOCKED");
    expect(result.blockers).toContain(
      "HayaSend schedules are limited to 30 days.",
    );
    expect(result.blockers).toContain(
      "Resend marketing, contact, audience, and broadcast APIs do not have HayaSend parity.",
    );
  });

  it("reports GO only when production, dogfood, reconciliation, canary, mailbox, and rollback gates pass", () => {
    const result = buildResendMigrationReport(
      inventory(),
      evidence(),
      new Date("2026-07-29T00:05:00.000Z"),
    );
    expect(result.decision).toBe("GO");
    expect(result.production_ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("fails closed while SES and dogfood evidence are incomplete", () => {
    const result = buildResendMigrationReport(
      inventory(),
      evidence({
        ses: { production_access: false, sending_enabled: true },
        dogfood: { calendar_days: 3, controlled_notifications: 80 },
      }),
      new Date("2026-07-29T00:05:00.000Z"),
    );
    expect(result.decision).toBe("NO_GO");
    expect(result.production_ready).toBe(false);
    expect(result.critical_mail_disposition).toContain("Keep");
  });
});

describe("Resend migration canary", () => {
  it("plans without network writes and does not print the recipient", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hayasend-resend-plan-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "recipient.txt"), "canary@example.com\n");
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();

    await resendMigrationCommand(
      [
        "resend",
        "canary",
        "--comparison-id",
        "proof-001",
        "--from",
        "Sender <sender@example.com>",
        "--to-file",
        "recipient.txt",
        "--hayasend-endpoint",
        "https://mail.example.com",
      ],
      {
        cwd: directory,
        env: {},
        fetch: fetcher,
        log: (message) => output.push(message),
        sleep: async () => undefined,
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("canary@example.com");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      object: "resend_migration_canary_plan",
      mutating: false,
      sends: 2,
    });
  });

  it("uses environment-only keys and compares terminal events after explicit hash confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hayasend-resend-apply-"));
    temporaryDirectories.push(directory);
    const recipient = "canary@example.com";
    await writeFile(join(directory, "recipient.txt"), `${recipient}\n`);
    const confirmation = createHash("sha256")
      .update(recipient)
      .digest("hex");
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const requestUrl = new URL(String(input));
      if (init?.method === "POST") {
        return Response.json({
          id: requestUrl.hostname === "mail.example.com"
            ? "email_0123456789abcdef0123456789abcdef"
            : "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
        });
      }
      return Response.json({ last_event: "delivered" });
    });

    await resendMigrationCommand(
      [
        "resend",
        "canary",
        "--comparison-id",
        "proof-002",
        "--from",
        "Sender <sender@example.com>",
        "--to-file",
        "recipient.txt",
        "--hayasend-endpoint",
        "https://mail.example.com",
        "--apply",
        "--confirm-hayasend-origin",
        "https://mail.example.com",
        "--confirm-recipient-sha256",
        confirmation,
      ],
      {
        cwd: directory,
        env: {
          HAYASEND_API_KEY: "hayasend-secret",
          RESEND_API_KEY: "resend-secret",
        },
        fetch: fetcher,
        log: (message) => output.push(message),
        sleep: async () => undefined,
      },
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(output.join("\n")).not.toContain(recipient);
    expect(output.join("\n")).not.toContain("hayasend-secret");
    expect(output.join("\n")).not.toContain("resend-secret");
    expect(JSON.parse(output[1] ?? "{}")).toMatchObject({
      object: "resend_migration_canary_result",
      ok: true,
      terminal_event_match: true,
      mailbox_receipt_verified: false,
      rollback_provider: "Resend",
    });
  });
});
