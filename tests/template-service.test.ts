import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { TemplateService } from "../src/services/template-service.js";

function fixture() {
  const store = new MemoryStore();
  const service = new TemplateService(store);
  return { service, store };
}

describe("TemplateService", () => {
  it("keeps the published version stable while a new draft is edited", async () => {
    const { service } = fixture();
    const created = await service.create(
      {
        name: "Order confirmation",
        alias: "order-confirmation",
        from: "Store <orders@example.com>",
        subject: "Order {{{ORDER_ID}}}",
        html: "<strong>{{{PRODUCT}}}</strong>",
        text: "{{{PRODUCT}}}",
        reply_to: ["Support <support@example.com>"],
        variables: [
          { key: "ORDER_ID", type: "number" },
          { key: "PRODUCT", type: "string", fallback_value: "item" },
        ],
      },
      new Date("2030-01-01T00:00:00.000Z"),
    );

    await expect(
      service.resolveForSend({
        to: ["customer@example.net"],
        template: {
          id: "order-confirmation",
          variables: { ORDER_ID: 42 },
        },
      }),
    ).rejects.toThrow("is not published");

    await service.publish(created.id, new Date("2030-01-01T00:01:00.000Z"));
    await service.update(
      "order-confirmation",
      {
        subject: "New order {{{ORDER_ID}}}",
        html: "<strong>New {{{PRODUCT}}}</strong>",
      },
      new Date("2030-01-01T00:02:00.000Z"),
    );

    await expect(
      service.resolveForSend({
        to: ["customer@example.net"],
        template: {
          id: "order-confirmation",
          variables: { ORDER_ID: 42 },
        },
      }),
    ).resolves.toMatchObject({
      from: "Store <orders@example.com>",
      subject: "Order 42",
      html: "<strong>item</strong>",
      text: "item",
      reply_to: ["Support <support@example.com>"],
    });

    const edited = await service.get(created.id);
    expect(edited).toMatchObject({
      object: "template",
      alias: "order-confirmation",
      status: "published",
      subject: "New order {{{ORDER_ID}}}",
      has_unpublished_versions: true,
    });

    await service.publish(
      "order-confirmation",
      new Date("2030-01-01T00:03:00.000Z"),
    );
    await expect(
      service.resolveForSend({
        from: "Override <sender@example.com>",
        subject: "Override",
        reply_to: ["override@example.com"],
        to: ["customer@example.net"],
        template: {
          id: created.id,
          variables: { ORDER_ID: 43, PRODUCT: "Laptop" },
        },
      }),
    ).resolves.toMatchObject({
      from: "Override <sender@example.com>",
      subject: "Override",
      html: "<strong>New Laptop</strong>",
      reply_to: ["override@example.com"],
    });
    await expect(
      service.resolveForSend({
        to: ["customer@example.net"],
        template: {
          id: created.id,
          variables: {
            ORDER_ID: 44,
            PRODUCT: '<a href="https://evil.example">click</a>',
          },
        },
      }),
    ).resolves.toMatchObject({
      html: "<strong>New &lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;</strong>",
      text: '<a href="https://evil.example">click</a>',
    });
  });

  it("validates declarations, reserved names, values, and aliases", async () => {
    const { service } = fixture();
    await expect(
      service.create({
        name: "Undeclared",
        html: "<p>{{{MISSING}}}</p>",
      }),
    ).rejects.toThrow("used but not declared");
    await expect(
      service.create({
        name: "Reserved",
        html: "<p>Hello</p>",
        variables: [{ key: "EMAIL", type: "string" }],
      }),
    ).rejects.toThrow("is reserved");

    const first = await service.create({
      name: "First",
      alias: "shared-alias",
      from: "sender@example.com",
      subject: "Hello",
      html: "<p>{{{NAME}}}</p>",
      variables: [{ key: "NAME", type: "string" }],
    });
    await service.publish(first.id);
    await expect(
      service.create({
        name: "Second",
        alias: "shared-alias",
        html: "<p>Hello</p>",
      }),
    ).rejects.toThrow("alias is already in use");
    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: { id: first.id, variables: { NAME: 7 } },
      }),
    ).rejects.toThrow("must be a string");
    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: { id: first.id },
      }),
    ).rejects.toThrow("requires a value");

    const expansion = await service.create({
      name: "Bounded expansion",
      from: "sender@example.com",
      subject: "Hello",
      html: "{{{VALUE}}}".repeat(600),
      variables: [{ key: "VALUE", type: "string" }],
    });
    await service.publish(expansion.id);
    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: {
          id: expansion.id,
          variables: { VALUE: "x".repeat(2_000) },
        },
      }),
    ).rejects.toThrow("Rendered template content must not exceed");
  });

  it("duplicates into a fresh unpublished template without copying the alias", async () => {
    const { service } = fixture();
    const source = await service.create({
      name: "Welcome",
      alias: "welcome",
      html: "<p>Welcome</p>",
    });
    await service.publish(source.id);

    const duplicate = await service.duplicate("welcome");
    await expect(service.get(duplicate.id)).resolves.toMatchObject({
      name: "Welcome copy",
      alias: null,
      status: "draft",
      published_at: null,
    });

    await expect(service.delete("welcome")).resolves.toEqual({
      object: "template",
      id: source.id,
      deleted: true,
    });
    await expect(service.get("welcome")).rejects.toThrow("was not found");
  });

  it("derives plain text from HTML unless an empty text body opts out", async () => {
    const { service } = fixture();
    const created = await service.create({
      name: "Text derivation",
      from: "sender@example.com",
      subject: "Hello",
      html: "<h1>Hello {{{NAME}}}</h1><script>not text</script>",
      variables: [{ key: "NAME", type: "string" }],
    });
    await service.publish(created.id);

    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: {
          id: created.id,
          variables: { NAME: "Ada & Lin" },
        },
      }),
    ).resolves.toMatchObject({
      html: "<h1>Hello Ada &amp; Lin</h1><script>not text</script>",
      text: "HELLO ADA & LIN",
    });

    await service.update(created.id, { text: "" });
    await service.publish(created.id);
    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: {
          id: created.id,
          variables: { NAME: "Ada" },
        },
      }),
    ).resolves.toMatchObject({ text: "" });
  });

  it("uses Resend-style template IDs as after cursors", async () => {
    const { service } = fixture();
    const older = await service.create(
      { name: "Older", html: "<p>Older</p>" },
      new Date("2030-01-01T00:00:00.000Z"),
    );
    const newer = await service.create(
      { name: "Newer", html: "<p>Newer</p>" },
      new Date("2030-01-01T00:01:00.000Z"),
    );

    const first = await service.list(1);
    expect(first).toMatchObject({
      data: [{ id: newer.id }],
      has_more: true,
      next_cursor: newer.id,
    });
    await expect(service.list(1, newer.id)).resolves.toMatchObject({
      data: [{ id: older.id }],
      has_more: false,
    });
    await expect(service.list(1, undefined, older.id)).resolves.toMatchObject({
      data: [{ id: newer.id }],
      has_more: false,
    });
  });
});
