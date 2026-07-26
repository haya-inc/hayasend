import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.js";
import { createSecretValueProvider } from "../src/adapters/secrets-manager.js";
import { ApiKeyService } from "../src/services/api-key-service.js";

const secret = "a-secure-bootstrap-key-with-more-than-32-characters";

describe("Secrets Manager bootstrap provider", () => {
  it("coalesces concurrent reads and caches the value for a bounded period", async () => {
    let timestamp = 1_000;
    const send = vi.fn(async () => ({
      SecretString: secret,
      $metadata: {},
    }));
    const provider = createSecretValueProvider("secret-arn", {
      cacheTtlMs: 100,
      client: { send },
      now: () => timestamp,
    });

    await expect(Promise.all([provider(), provider()])).resolves.toEqual([
      secret,
      secret,
    ]);
    expect(send).toHaveBeenCalledTimes(1);

    timestamp = 1_099;
    await expect(provider()).resolves.toBe(secret);
    expect(send).toHaveBeenCalledTimes(1);

    timestamp = 1_100;
    await expect(provider()).resolves.toBe(secret);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ SecretString: secret, $metadata: {} });
    const provider = createSecretValueProvider("secret-arn", {
      client: { send },
    });

    await expect(provider()).rejects.toThrow("temporary outage");
    await expect(provider()).resolves.toBe(secret);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects missing or weak secret values", async () => {
    const provider = createSecretValueProvider("secret-arn", {
      client: {
        send: async () => ({ SecretString: "too-short", $metadata: {} }),
      },
    });

    await expect(provider()).rejects.toThrow(
      "bootstrap secret must contain at least 32 characters",
    );
  });

  it("keeps application-key authentication independent of Secrets Manager", async () => {
    const unavailableProvider = vi.fn(async () => {
      throw new Error("Secrets Manager unavailable");
    });
    const service = new ApiKeyService(
      new MemoryStore(),
      unavailableProvider,
    );
    const { token } = await service.create({
      name: "production sender",
      scopes: ["emails:send"],
    });

    await expect(service.authenticate(token)).resolves.toMatchObject({
      name: "production sender",
      scopes: ["emails:send"],
      bootstrap: false,
    });
    expect(unavailableProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed scoped keys before external lookups", async () => {
    const store = new MemoryStore();
    const getApiKey = vi.spyOn(store, "getApiKey");
    const bootstrapProvider = vi.fn(async () => secret);
    const service = new ApiKeyService(store, bootstrapProvider);
    const malformed = [
      `re_hs_key_${"a".repeat(2_048)}.short`,
      `re_hs_key_${"a".repeat(32)}.short`,
      `re_hs_key_${"g".repeat(32)}.${"a".repeat(43)}`,
      `re_hs_key_${"a".repeat(32)}.${"a".repeat(42)}!`,
    ];

    for (const token of malformed) {
      await expect(service.authenticate(token)).rejects.toMatchObject({
        status: 401,
        name: "validation_error",
      });
    }
    expect(getApiKey).not.toHaveBeenCalled();
    expect(bootstrapProvider).not.toHaveBeenCalled();
  });
});
