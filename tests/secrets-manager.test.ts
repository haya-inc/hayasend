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
});
