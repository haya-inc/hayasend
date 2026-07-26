# Hosted templates

HayaSend stores transactional email templates in the same AWS account as the
rest of the deployment. The API is compatible with the official Resend Node
SDK's create, get, list, update, publish, duplicate, delete, and template-send
operations.

## Draft and published versions

Creating or updating a template changes only its draft. Sending always resolves
the immutable published snapshot, so an incomplete edit cannot leak into
production traffic. Publishing atomically promotes the current draft. The get
response reports `current_version_id` and `has_unpublished_versions`.

Each template version is limited to 128 KiB. A DynamoDB record retains the
current draft and published snapshot, leaving headroom below DynamoDB's 400 KiB
item limit. Full historical rollback beyond those two snapshots is planned
before v1.

After variable expansion, combined HTML and text are limited to 1 MiB.
HTML-to-text conversion also caps DOM depth and child-node processing, so a
small but adversarial template cannot create unbounded CPU or memory work.

Aliases are optional, unique, and can be used everywhere an ID is accepted.
Alias creation, replacement, and deletion share the same DynamoDB transaction
as the template revision. Concurrent writes are rejected instead of silently
overwriting one another. Aliases use lowercase letters, numbers, `_`, and `-`;
the `tmpl_` prefix is reserved for generated IDs.

Template lists are newest-first and accept the official SDK's `after` or
`before` template-ID cursor. The two cursor directions cannot be combined.

## Create, publish, and send

The official SDK renders React Email locally and uploads the resulting HTML.
Install React Email in the application that owns the template source:

```bash
npm install resend react react-dom @react-email/render
```

```tsx
import { createElement } from "react";
import { Resend } from "resend";

const email = new Resend(process.env.HAYASEND_API_KEY, {
  baseUrl: process.env.HAYASEND_BASE_URL,
});

const published = await email.templates
  .create({
    name: "Order confirmation",
    alias: "order-confirmation",
    from: "Store <orders@example.com>",
    subject: "Order {{{ORDER_ID}}}",
    react: createElement("p", null, "Thanks for buying {{{PRODUCT}}}."),
    variables: [
      { key: "ORDER_ID", type: "number" },
      { key: "PRODUCT", type: "string", fallbackValue: "an item" },
    ],
  })
  .publish();

if (published.error) throw published.error;

await email.emails.send({
  to: "customer@example.net",
  template: {
    id: "order-confirmation",
    variables: { ORDER_ID: 42, PRODUCT: "Laptop" },
  },
});
```

The send request's `from`, `subject`, and `replyTo` override template defaults.
If neither side provides `from` or `subject`, the request is rejected. A
template cannot be combined with `html`, `text`, or `react`.

When `text` is omitted, HayaSend derives a plain-text body from the rendered
HTML at send time. Set `text` to an empty string to opt out. Explicit text
templates receive variable substitution without HTML escaping.

## Variables and safety

Use triple-brace placeholders such as `{{{PRODUCT}}}` in HTML, text, subject,
sender, and reply-to fields. Keys contain at most 50 ASCII letters, numbers, or
underscores. A template may declare at most 50 variables. Values must match the
declared `string` or `number` type; strings are limited to 2,000 characters.

A missing value uses its declared fallback. If neither exists, sending fails
before an email is queued. Unknown values, duplicate declarations, undeclared
placeholders, and reserved names are rejected.

HayaSend HTML-escapes variable values while leaving the trusted template markup
intact. Text and header fields receive the literal value, followed by the same
line-break validation used for ordinary sends. This prevents a recipient value
from adding markup or injecting a mail header.

## API key scopes

- `templates:read`: get and list templates.
- `templates:write`: create, update, publish, duplicate, and delete templates.
- `emails:send`: send a published template.

For least privilege, a deployment pipeline normally receives
`templates:read` and `templates:write`, while an application runtime receives
`emails:send` only.
