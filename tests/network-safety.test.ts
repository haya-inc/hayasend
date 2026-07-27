import { describe, expect, it } from "vitest";
import {
  assertPublicWebhookEndpoint,
  createPublicLookup,
  createSafeWebhookFetch,
  isPublicIpAddress,
  type HostResolver,
} from "../src/adapters/node-network-safety.js";

describe("webhook network safety", () => {
  it("classifies public and non-public IPv4 and IPv6 addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.31.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:0:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "100:0:0:1::1",
      "2001:db8::1",
      "5f00::1",
      "fd00:ec2::254",
      "fe80::1",
      "ff02::1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }

    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "2606:4700:4700::1111",
      "2606:4700:4700::1001",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(true);
    }
  });

  it("rejects literals, mixed DNS answers, credentials, and fragments", async () => {
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://2130706433/hooks"),
      ),
    ).rejects.toMatchObject({ name: "validation_error" });
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://0x7f000001/hooks"),
      ),
    ).rejects.toMatchObject({ name: "validation_error" });
    await expect(
      assertPublicWebhookEndpoint(
        new URL("http://1.1.1.1/hooks"),
      ),
    ).rejects.toMatchObject({ name: "validation_error" });
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://user:secret@example.com/hooks"),
      ),
    ).rejects.toMatchObject({ name: "validation_error" });
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://example.com/hooks#private"),
      ),
    ).rejects.toMatchObject({ name: "validation_error" });

    const mixedResolver: HostResolver = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://example.com/hooks"),
        mixedResolver,
      ),
    ).rejects.toMatchObject({ name: "validation_error" });

    const publicResolver: HostResolver = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    await expect(
      assertPublicWebhookEndpoint(
        new URL("https://example.com/hooks"),
        publicResolver,
      ),
    ).resolves.toBeUndefined();
  });

  it("pins only validated DNS results into the connection lookup", async () => {
    const publicResolver: HostResolver = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const safeLookup = createPublicLookup(publicResolver);
    const addresses = await new Promise<unknown>((resolve, reject) => {
      safeLookup(
        "example.com",
        { all: true },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        },
      );
    });
    expect(addresses).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    let resolution = 0;
    const rebindingResolver: HostResolver = async () =>
      ++resolution === 1
        ? [{ address: "1.1.1.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    const safeFetch = createSafeWebhookFetch(rebindingResolver);
    await expect(
      safeFetch("https://example.com/hooks", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toMatchObject({ name: "validation_error" });
    expect(resolution).toBe(2);
  });
});
