import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

describe("AWS SES dogfood campaign report", () => {
  it("requires 56 complete slots and 1,008 unique messages", async () => {
    const start = new Date("2026-08-02T00:00:00.000Z");
    let ordinal = 0;
    const campaignEvidence = [];
    for (let day = 0; day < 14; day += 1) {
      const date = new Date(start.getTime() + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (let slot = 0; slot < 4; slot += 1) {
        const hashes = Array.from({ length: 18 }, () =>
          (ordinal++).toString(16).padStart(64, "0"),
        );
        const latency = {
          count: 18,
          min_ms: 1,
          p50_ms: 2,
          p95_ms: 3,
          max_ms: 4,
        };
        const evidence = {
          object: "aws_ses_dogfood_evidence",
          generated_at: `${date}T${String(slot * 6).padStart(2, "0")}:30:00.000Z`,
          source: {
            commit: "a".repeat(40),
            workflow_run_id: `${day}-${slot}`,
          },
          campaign: {
            start_date: "2026-08-02",
            end_date: "2026-08-15",
            run_date: date,
            slot,
            active: true,
            batch_size: 18,
            expected_total: 1_008,
          },
          delivery: {
            submitted: 18,
            delivered: 18,
            unique_email_ids: 18,
            email_id_sha256: hashes,
            scoped_api_key_revoked: true,
            operator_runtime_ms: 1_000,
            terminal: true,
          },
          ledger: {
            submitted: 18,
            delivered: 18,
            unexplained_loss: 0,
            duplicate_email_ids: 0,
            duplicate_terminal_events: 0,
            total_attempts: 18,
            retryable_failures: 0,
            provider_id_correlated: true,
            exact_recipient_correlated: true,
            terminal: true,
            latency: {
              queue_to_provider: latency,
              provider_terminal: latency,
              provider_event_ingest: latency,
              end_to_end: latency,
            },
          },
          status_before: {
            operational: true,
            send_ready: true,
            alarms: { alarm: 0, insufficient_data: 0 },
          },
          status_after: {
            operational: true,
            send_ready: true,
            alarms: { alarm: 0, insufficient_data: 0 },
          },
        };
        campaignEvidence.push(evidence);
      }
    }

    const child = spawn(
      process.execPath,
      [new URL("../scripts/aws-dogfood-report.mjs", import.meta.url).pathname],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(JSON.stringify(campaignEvidence));
    const [exitCode] = (await once(child, "exit")) as [number];

    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({
      object: "aws_ses_dogfood_campaign_report",
      campaign: {
        consecutive_days: 14,
        slots: 56,
        submitted: 1_008,
        delivered: 1_008,
      },
      unique_email_ids: 1_008,
      unexplained_loss: 0,
      duplicate_email_ids: 0,
      duplicate_terminal_events: 0,
      credential_cleanup_verified: true,
      terminal: true,
    });
  });
});
