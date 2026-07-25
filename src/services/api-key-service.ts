import { randomBytes } from "node:crypto";
import { createId, secretsEqual, sha256 } from "../core/crypto.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../core/errors.js";
import type {
  ApiKeyRecord,
  ApiScope,
  AuthenticatedPrincipal,
  Page,
  PublicApiKey,
} from "../core/types.js";
import type { Store } from "../ports/store.js";

export function publicApiKey(record: ApiKeyRecord): PublicApiKey {
  const { key_hash: _keyHash, ...publicRecord } = record;
  return publicRecord;
}

export class ApiKeyService {
  constructor(
    private readonly store: Store,
    private readonly bootstrapKey: string,
  ) {}

  async authenticate(token: string): Promise<AuthenticatedPrincipal> {
    if (secretsEqual(token, this.bootstrapKey)) {
      return {
        id: "bootstrap",
        name: "Bootstrap administrator",
        scopes: ["*"],
        bootstrap: true,
      };
    }

    const separator = token.indexOf(".");
    if (!token.startsWith("re_hs_") || separator < 0) {
      throw new UnauthorizedError();
    }
    const id = token.slice("re_hs_".length, separator);
    const record = await this.store.getApiKey(id);
    if (
      !record ||
      record.revoked_at ||
      (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) ||
      !secretsEqual(record.key_hash, sha256(token))
    ) {
      throw new UnauthorizedError();
    }
    return {
      id: record.id,
      name: record.name,
      scopes: record.scopes,
      bootstrap: false,
    };
  }

  async create(input: {
    name: string;
    scopes: ApiScope[];
    expires_at?: string | undefined;
  }): Promise<{ api_key: PublicApiKey; token: string }> {
    const expiresAt = input.expires_at
      ? new Date(input.expires_at).toISOString()
      : undefined;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      throw new ValidationError("expires_at must be in the future.");
    }

    const id = createId("key");
    const secret = randomBytes(32).toString("base64url");
    const token = `re_hs_${id}.${secret}`;
    const record: ApiKeyRecord = {
      id,
      name: input.name,
      prefix: `${token.slice(0, 20)}…`,
      key_hash: sha256(token),
      scopes: [...new Set(input.scopes)],
      created_at: new Date().toISOString(),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    };
    await this.store.createApiKey(record);
    return { api_key: publicApiKey(record), token };
  }

  async list(
    limit: number,
    cursor?: string,
  ): Promise<Page<PublicApiKey>> {
    const page = await this.store.listApiKeys(limit, cursor);
    return { ...page, data: page.data.map(publicApiKey) };
  }

  async get(id: string): Promise<PublicApiKey> {
    const record = await this.store.getApiKey(id);
    if (!record) {
      throw new NotFoundError("API key");
    }
    return publicApiKey(record);
  }

  async revoke(id: string): Promise<PublicApiKey> {
    const record = await this.store.updateApiKey(id, {
      revoked_at: new Date().toISOString(),
    });
    if (!record) {
      throw new NotFoundError("API key");
    }
    return publicApiKey(record);
  }
}
