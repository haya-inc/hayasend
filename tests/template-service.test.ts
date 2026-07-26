import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { TemplateService } from "../src/services/template-service.js";

function fixture() {
  const store = new MemoryStore();
  const service = new TemplateService(store);
  return { service, store };
}

describe("TemplateService", () => {
  it("renders the current draft without publishing or sending it", async () => {
    const { service } = fixture();
    const created = await service.create({
      name: "Draft preview",
      alias: "draft-preview",
      subject: "Hello {{{NAME}}}",
      html: "<h1>Hello {{{NAME}}}</h1><p>Total: {{{TOTAL}}}</p>",
      variables: [
        { key: "NAME", type: "string" },
        { key: "TOTAL", type: "number", fallback_value: 42 },
      ],
    });

    const before = await service.get(created.id);
    await expect(
      service.renderDraft("draft-preview", {
        from: "Preview <preview@example.com>",
        variables: { NAME: "Ada & Lin" },
      }),
    ).resolves.toEqual({
      object: "template_render",
      template_id: created.id,
      version_id: before.current_version_id,
      from: "Preview <preview@example.com>",
      subject: "Hello Ada & Lin",
      reply_to: null,
      html: "<h1>Hello Ada &amp; Lin</h1><p>Total: 42</p>",
      text: "HELLO ADA & LIN\n\nTotal: 42",
    });
    await expect(service.get(created.id)).resolves.toEqual(before);
    await expect(
      service.resolveForSend({
        to: ["person@example.net"],
        template: { id: created.id, variables: { NAME: "Ada" } },
      }),
    ).rejects.toThrow("is not published");
  });

  it("applies render validation to draft variables and expanded headers", async () => {
    const { service } = fixture();
    const created = await service.create({
      name: "Validated preview",
      subject: "{{{SUBJECT}}}",
      html: "<p>{{{NAME}}}</p>",
      variables: [
        { key: "NAME", type: "string" },
        { key: "SUBJECT", type: "string" },
      ],
    });

    await expect(
      service.renderDraft(created.id, {
        variables: { NAME: "Ada" },
      }),
    ).rejects.toThrow("SUBJECT requires a value");
    await expect(
      service.renderDraft(created.id, {
        variables: {
          NAME: "Ada",
          SUBJECT: "Hello\r\nBcc: victim@example.net",
        },
      }),
    ).rejects.toThrow("must not contain line breaks");
    await expect(
      service.renderDraft(created.id, {
        variables: { NAME: "Ada", SUBJECT: "Hello", UNKNOWN: "value" },
      }),
    ).rejects.toThrow("UNKNOWN is not declared");
  });

  it("conditionally publishes only the draft version that was reviewed", async () => {
    const { service } = fixture();
    const created = await service.create({
      name: "Reviewed draft",
      html: "<p>First</p>",
    });
    const reviewed = await service.get(created.id);
    await service.update(created.id, { html: "<p>Changed</p>" });

    await expect(
      service.publish(
        created.id,
        new Date("2030-01-01T00:00:00.000Z"),
        reviewed.current_version_id,
      ),
    ).rejects.toThrow("changed after it was reviewed");
    await expect(service.get(created.id)).resolves.toMatchObject({
      status: "draft",
      published_at: null,
    });

    const current = await service.get(created.id);
    await expect(
      service.publish(
        created.id,
        new Date("2030-01-01T00:01:00.000Z"),
        current.current_version_id,
      ),
    ).resolves.toEqual({ object: "template", id: created.id });
  });

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

  it("retains immutable publications and restores one only as a new draft", async () => {
    const store = new MemoryStore();
    const service = new TemplateService(store, {
      retentionDays: 30,
      limit: 5,
    });
    const created = await service.create(
      {
        name: "Version one",
        alias: "stable-v1",
        html: "<p>One</p>",
      },
      new Date("2030-01-01T00:00:00.000Z"),
    );
    const firstDraft = await service.get(created.id);
    await service.publish(
      created.id,
      new Date("2030-01-01T00:01:00.000Z"),
      firstDraft.current_version_id,
      {
        actor: { id: "key_release", name: "Release automation" },
        source: "cli",
      },
    );
    await service.update(
      created.id,
      {
        name: "Version two",
        alias: "stable-v2",
        html: "<p>Two</p>",
      },
      new Date("2030-01-01T00:02:00.000Z"),
    );
    const secondDraft = await service.get(created.id);

    await expect(
      service.resolveForSend({
        from: "sender@example.com",
        subject: "Before second publication",
        to: ["recipient@example.net"],
        template: { id: "stable-v1" },
      }),
    ).resolves.toMatchObject({ html: "<p>One</p>" });

    await service.publish(
      created.id,
      new Date("2030-01-01T00:03:00.000Z"),
      secondDraft.current_version_id,
    );
    await service.update(
      created.id,
      { alias: "draft-only", html: "<p>Unpublished</p>" },
      new Date("2030-01-01T00:04:00.000Z"),
    );
    const beforeRestore = await service.get(created.id);
    await expect(
      service.resolveForSend({
        from: "sender@example.com",
        subject: "Published alias",
        to: ["recipient@example.net"],
        template: { id: "stable-v2" },
      }),
    ).resolves.toMatchObject({ html: "<p>Two</p>" });
    await expect(
      service.resolveForSend({
        from: "sender@example.com",
        subject: "Draft alias",
        to: ["recipient@example.net"],
        template: { id: "draft-only" },
      }),
    ).rejects.toThrow("was not found");

    const firstPublication = await service.getVersion(
      created.id,
      firstDraft.current_version_id,
      new Date("2030-01-01T00:05:00.000Z"),
    );
    expect(firstPublication).toMatchObject({
      object: "template_version",
      id: firstDraft.current_version_id,
      template_id: created.id,
      html: "<p>One</p>",
      actor: { id: "key_release", name: "Release automation" },
      source: "cli",
      source_version_id: null,
    });
    await expect(
      service.renderVersion(
        created.id,
        firstDraft.current_version_id,
        {},
        new Date("2030-01-01T00:05:00.000Z"),
      ),
    ).resolves.toMatchObject({
      object: "template_render",
      version_id: firstDraft.current_version_id,
      html: "<p>One</p>",
    });

    const versions = await service.listVersions(
      created.id,
      10,
      undefined,
      new Date("2030-01-01T00:05:00.000Z"),
    );
    expect(versions.data.map((version) => version.id)).toEqual([
      secondDraft.current_version_id,
      firstDraft.current_version_id,
    ]);
    expect(Object.hasOwn(versions.data[0] ?? {}, "html")).toBe(false);

    const restored = await service.restoreVersion(
      created.id,
      firstDraft.current_version_id,
      beforeRestore.current_version_id,
      new Date("2030-01-01T00:06:00.000Z"),
    );
    expect(restored).toMatchObject({
      object: "template_restore",
      template_id: created.id,
      source_version_id: firstDraft.current_version_id,
    });
    expect(restored.current_version_id).not.toBe(firstDraft.current_version_id);
    await expect(service.get(created.id)).resolves.toMatchObject({
      current_version_id: restored.current_version_id,
      alias: "stable-v1",
      html: "<p>One</p>",
      has_unpublished_versions: true,
    });
    await expect(
      service.resolveForSend({
        from: "sender@example.com",
        subject: "Still version two",
        to: ["recipient@example.net"],
        template: { id: "stable-v2" },
      }),
    ).resolves.toMatchObject({ html: "<p>Two</p>" });
    await expect(
      service.publish(
        created.id,
        new Date("2030-01-01T00:07:00.000Z"),
        beforeRestore.current_version_id,
      ),
    ).rejects.toThrow("changed after it was reviewed");

    await service.publish(
      created.id,
      new Date("2030-01-01T00:08:00.000Z"),
      restored.current_version_id,
    );
    const restoredPublication = await service.getVersion(
      created.id,
      restored.current_version_id,
      new Date("2030-01-01T00:09:00.000Z"),
    );
    expect(restoredPublication.source_version_id).toBe(
      firstDraft.current_version_id,
    );
    expect(
      (
        await service.getVersion(
          created.id,
          firstDraft.current_version_id,
          new Date("2030-01-01T00:09:00.000Z"),
        )
      ).html,
    ).toBe("<p>One</p>");
  });

  it("bounds history by count and time while keeping version cursors stable", async () => {
    const store = new MemoryStore();
    const service = new TemplateService(store, {
      retentionDays: 1,
      limit: 3,
    });
    const created = await service.create(
      { name: "V1", html: "<p>1</p>" },
      new Date("2030-01-01T00:00:00.000Z"),
    );
    const versionIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const draft = await service.get(created.id);
      versionIds.push(draft.current_version_id);
      await service.publish(
        created.id,
        new Date(`2030-01-01T00:0${index}:00.000Z`),
        draft.current_version_id,
      );
      if (index < 3) {
        await service.update(
          created.id,
          { name: `V${index + 1}`, html: `<p>${index + 1}</p>` },
          new Date(`2030-01-01T00:0${index}:30.000Z`),
        );
      }
    }

    const firstPage = await service.listVersions(
      created.id,
      1,
      undefined,
      new Date("2030-01-01T00:04:00.000Z"),
    );
    expect(firstPage).toMatchObject({
      data: [{ id: versionIds[2] }],
      has_more: true,
      next_cursor: versionIds[2],
    });
    await service.update(
      created.id,
      { name: "V4", html: "<p>4</p>" },
      new Date("2030-01-01T00:04:30.000Z"),
    );
    const fourth = await service.get(created.id);
    await service.publish(
      created.id,
      new Date("2030-01-01T00:05:00.000Z"),
      fourth.current_version_id,
    );

    await expect(
      service.listVersions(
        created.id,
        1,
        firstPage.next_cursor,
        new Date("2030-01-01T00:06:00.000Z"),
      ),
    ).resolves.toMatchObject({
      data: [{ id: versionIds[1] }],
    });
    await expect(
      service.getVersion(
        created.id,
        versionIds[0] as string,
        new Date("2030-01-01T00:06:00.000Z"),
      ),
    ).rejects.toThrow("Template version was not found");
    await expect(
      service.getVersion(
        created.id,
        fourth.current_version_id,
        new Date("2030-01-03T00:06:00.000Z"),
      ),
    ).rejects.toThrow("Template version was not found");
    await expect(
      service.restoreVersion(
        created.id,
        versionIds[1] as string,
        "tmplv_00000000000000000000000000000000",
        new Date("2030-01-01T00:06:00.000Z"),
      ),
    ).rejects.toThrow("changed after restore was requested");
  });
});
