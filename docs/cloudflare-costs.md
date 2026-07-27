# Cloudflare cost evidence

HayaSend ships a reproducible Cloudflare cost model for Workers, D1, R2,
Queues, and Email Sending:

```bash
npm run --silent cost:cloudflare -- --profile proof
npm run --silent cost:cloudflare -- --profile dogfood
npm run --silent cost:cloudflare -- --profile representative
```

The JSON output separates workload assumptions, calculated usage, every
metered component, and the monthly USD estimate. Override assumptions with
observed hosted evidence instead of editing model code:

```bash
npm run --silent cost:cloudflare -- \
  --profile dogfood \
  --messages 10000 \
  --average_worker_cpu_ms 12.5 \
  --d1_rows_read_per_message 55 \
  --d1_rows_written_per_message 48
```

Rates were last checked on 2026-07-27 against Cloudflare's official
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[Queues](https://developers.cloudflare.com/queues/platform/pricing/), and
[Email Service](https://developers.cloudflare.com/email-service/platform/pricing/)
pricing pages. The model includes the current $5/month Workers Paid minimum
and applies component overages only after their documented included usage.

This is an estimate, not billing authority or a budget control. Provider rates,
adaptive Email Sending limits, workload shape, retention, retries, and event
volume can change. Recheck every source and update
`PRICING_LAST_VERIFIED` before release or a material purchasing decision.
Record actual Worker CPU, request count, D1 rows, R2 operations/storage, Queue
operations, messages, provider events, and retention beside the workflow
artifact whenever the platform exposes them.
