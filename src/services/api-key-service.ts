import {
  createId,
  createRandomToken,
  secretsEqual,
  sha256,
} from "../core/crypto.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../core/errors.js";
import type {
  ApiKeyRecord,
  ApiScope,
  AuthenticatedPrincipal,
  Page,
  PublicApiKey,
} from "../core/types.js";
import type { Store } from "../ports/store.js";

const SCOPED_API_KEY_PATTERN =
  /^re_hs_(key_[a-f0-9]{32})\.[A-Za-z0-9_-]{43}$/;

export function publicApiKey(record: ApiKeyRecord): PublicApiKey {
  const { key_hash: _keyHash, ...publicRecord } = record;
  return publicRecord;
}

export type BootstrapKeyProvider = () => Promise<string>;

export class ApiKeyService {
  private readonly bootstrapKeyProvider: BootstrapKeyProvider;

  constructor(
    private readonly store: Store,
    bootstrapKey: string | BootstrapKeyProvider,
  ) {
    this.bootstrapKeyProvider =
      typeof bootstrapKey === "string"
        ? async () => bootstrapKey
        : bootstrapKey;
  }

  async authenticate(token: string): Promise<AuthenticatedPrincipal> {
    const scopedKey = SCOPED_API_KEY_PATTERN.exec(token);
    if (scopedKey?.[1]) {
      const id = scopedKey[1];
      const record = await this.store.getApiKey(id);
      if (
        !record ||
        record.revoked_at ||
        (record.expires_at &&
          new Date(record.expires_at).getTime() <= Date.now()) ||
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
    if (token.startsWith("re_hs_") && token.includes(".")) {
      throw new UnauthorizedError();
    }

    if (secretsEqual(token, await this.bootstrapKeyProvider())) {
      return {
        id: "bootstrap",
        name: "Bootstrap administrator",
        scopes: ["*"],
        bootstrap: true,
      };
    }
    throw new UnauthorizedError();
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
    const secret = createRandomToken();
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
