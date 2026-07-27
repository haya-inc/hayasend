# Cloudflare Workers runtime

HayaSend includes an experimental Cloudflare Workers runtime skeleton. It
proves that the provider-neutral core and service layer compile without Node
globals, Node built-ins, AWS SDK imports, or the `nodejs_compat` flag.

This is not a usable email service and must not receive production traffic.
Only `/healthz` and `/capabilities` are implemented. The capability response
explicitly reports that the email API, persistence, object storage, queue,
scheduler, outbound mail, and inbound email adapters are unavailable.

Run all portability gates locally:

```bash
npm run check:workers
```

The gate verifies generated Workers types, rejects forbidden dependency paths,
type-checks the core and services against Web Worker APIs, and performs a
Wrangler dry-run bundle. Node-specific webhook DNS pinning remains in the Node
adapter and is still injected into the AWS runtime.

The next roadmap steps will add provider interfaces and Cloudflare-specific
adapters one at a time. Passing this compile gate is architectural evidence,
not a production-readiness claim.
