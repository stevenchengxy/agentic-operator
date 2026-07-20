import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ProviderKeysService = typeof import("../src/services/provider-keys");

describe("provider key vault tenant isolation", () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "agentic-provider-keys-"));
  const vaultPath = join(tempDirectory, "provider-keys.json");
  const previousVaultPath = process.env.AGENTIC_KEY_VAULT_PATH;
  const previousVaultSecret = process.env.AGENTIC_KEY_VAULT_SECRET;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  let service: ProviderKeysService;

  beforeAll(async () => {
    process.env.AGENTIC_KEY_VAULT_PATH = vaultPath;
    process.env.AGENTIC_KEY_VAULT_SECRET = "provider-key-service-test-secret";
    delete process.env.OPENROUTER_API_KEY;
    vi.resetModules();
    service = await import("../src/services/provider-keys");
  });

  beforeEach(() => {
    rmSync(vaultPath, { force: true });
    delete process.env.OPENROUTER_API_KEY;
    service._resetProviderKeyVaultCache();
  });

  afterAll(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
    if (previousVaultPath === undefined) {
      delete process.env.AGENTIC_KEY_VAULT_PATH;
    } else {
      process.env.AGENTIC_KEY_VAULT_PATH = previousVaultPath;
    }
    if (previousVaultSecret === undefined) {
      delete process.env.AGENTIC_KEY_VAULT_SECRET;
    } else {
      process.env.AGENTIC_KEY_VAULT_SECRET = previousVaultSecret;
    }
    if (previousOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
  });

  it("preserves workspace and other-tenant records when a tenant rotates its key", () => {
    const workspace = service.setProviderKey("openrouter", {
      apiKey: "sk-workspace-0000000000000000",
      scope: "workspace",
      setBy: "platform-admin",
    });
    const tenantA = service.setProviderKey("openrouter", {
      apiKey: "sk-tenant-a-1111111111111111",
      scope: "tenant",
      tenantId: "tenant-a",
      setBy: "tenant-a-admin",
    });
    const tenantB = service.setProviderKey("openrouter", {
      apiKey: "sk-tenant-b-2222222222222222",
      scope: "tenant",
      tenantId: "tenant-b",
      setBy: "tenant-b-admin",
    });

    const rotatedTenantA = service.setProviderKey("openrouter", {
      apiKey: "sk-tenant-a-rotated-3333333333",
      scope: "tenant",
      tenantId: "tenant-a",
      setBy: "tenant-a-admin",
    });

    expect(rotatedTenantA.credentialId).toBe(tenantA.credentialId);
    expect(service.getProviderKey("openrouter")).toBe(
      "sk-workspace-0000000000000000",
    );
    expect(service.getProviderKey("openrouter", "tenant-a")).toBe(
      "sk-tenant-a-rotated-3333333333",
    );
    expect(service.getProviderKey("openrouter", "tenant-b")).toBe(
      "sk-tenant-b-2222222222222222",
    );

    const stored = JSON.parse(readFileSync(vaultPath, "utf8")) as {
      records: Array<{ credentialId: string }>;
    };
    expect(stored.records).toHaveLength(3);
    expect(stored.records.map((record) => record.credentialId)).toEqual(
      expect.arrayContaining([
        workspace.credentialId,
        rotatedTenantA.credentialId,
        tenantB.credentialId,
      ]),
    );
  });

  it("resolves tenant, workspace, then environment credentials in precedence order", () => {
    process.env.OPENROUTER_API_KEY = "sk-environment-0000000000000000";
    expect(
      service.getProviderCredential("openrouter", "tenant-a"),
    ).toMatchObject({
      apiKey: "sk-environment-0000000000000000",
      credentialId: "cred-env-openrouter",
      source: "env",
      scope: "workspace",
    });

    const workspace = service.setProviderKey("openrouter", {
      apiKey: "sk-workspace-1111111111111111",
      scope: "workspace",
      setBy: "platform-admin",
    });
    expect(
      service.getProviderCredential("openrouter", "tenant-a"),
    ).toMatchObject({
      apiKey: "sk-workspace-1111111111111111",
      credentialId: workspace.credentialId,
      source: "vault",
      scope: "workspace",
    });

    const tenant = service.setProviderKey("openrouter", {
      apiKey: "sk-tenant-a-2222222222222222",
      scope: "tenant",
      tenantId: "tenant-a",
      setBy: "tenant-a-admin",
    });
    expect(service.getProviderCredential("openrouter", "tenant-a")).toEqual({
      apiKey: "sk-tenant-a-2222222222222222",
      credentialId: tenant.credentialId,
      provider: "openrouter",
      source: "vault",
      scope: "tenant",
      tenantId: "tenant-a",
    });
    expect(
      service.getProviderCredential("openrouter", "tenant-b"),
    ).toMatchObject({
      apiKey: "sk-workspace-1111111111111111",
      credentialId: workspace.credentialId,
      scope: "workspace",
    });
  });

  it("migrates legacy records to a stable credential ID without exposing plaintext", () => {
    const plaintext = "sk-legacy-secret-9999999999999999";
    service.setProviderKey("openrouter", {
      apiKey: plaintext,
      scope: "workspace",
      setBy: "platform-admin",
    });

    const legacyVault = JSON.parse(readFileSync(vaultPath, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    delete legacyVault.records[0]?.credentialId;
    writeFileSync(vaultPath, JSON.stringify(legacyVault, null, 2), {
      mode: 0o600,
    });
    service._resetProviderKeyVaultCache();

    const firstResolution = service.getProviderCredential("openrouter");
    expect(firstResolution?.apiKey).toBe(plaintext);
    expect(firstResolution?.credentialId).toMatch(/^cred-legacy-[a-f0-9]{24}$/);

    const migratedRaw = readFileSync(vaultPath, "utf8");
    const publicMeta = service.getProviderKeyMeta("openrouter");
    expect(migratedRaw).not.toContain(plaintext);
    expect(JSON.stringify(publicMeta)).not.toContain(plaintext);
    expect(publicMeta.credentialId).toBe(firstResolution?.credentialId);

    service._resetProviderKeyVaultCache();
    expect(service.getProviderCredential("openrouter")?.credentialId).toBe(
      firstResolution?.credentialId,
    );
  });

  it("repairs an overly broad vault file mode before reading", () => {
    service.setProviderKey("openrouter", {
      apiKey: "sk-permission-test-0000000000000000",
      scope: "workspace",
      setBy: "platform-admin",
    });
    chmodSync(vaultPath, 0o644);
    service._resetProviderKeyVaultCache();

    expect(service.getProviderKey("openrouter")).toBe(
      "sk-permission-test-0000000000000000",
    );
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);
  });

  it("creates and repairs the vault directory with private permissions", () => {
    chmodSync(tempDirectory, 0o755);

    service.setProviderKey("openrouter", {
      apiKey: "sk-directory-mode-0000000000000000",
      scope: "workspace",
      setBy: "platform-admin",
    });

    expect(statSync(tempDirectory).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink vault before chmod or read", () => {
    const targetPath = join(tempDirectory, "provider-keys-target.json");
    writeFileSync(
      targetPath,
      JSON.stringify({ saltHex: "00".repeat(16), records: [] }),
      { mode: 0o644 },
    );
    symlinkSync(targetPath, vaultPath);
    service._resetProviderKeyVaultCache();

    expect(() => service.getProviderKey("openrouter")).toThrow(
      /regular file, not a symlink/,
    );
    expect(statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it("requires a tenant identity for tenant-scoped credentials", () => {
    expect(() =>
      service.setProviderKey("openrouter", {
        apiKey: "sk-no-tenant-0000000000000000",
        scope: "tenant",
        setBy: "platform-admin",
      }),
    ).toThrow(/tenantId is required/);
  });

  it("fails closed without a vault master secret in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const configuredSecret = process.env.AGENTIC_KEY_VAULT_SECRET;
    process.env.NODE_ENV = "production";
    delete process.env.AGENTIC_KEY_VAULT_SECRET;
    service._resetProviderKeyVaultCache();

    try {
      expect(() =>
        service.setProviderKey("openrouter", {
          apiKey: "sk-must-not-persist-000000000000",
          scope: "workspace",
          setBy: "platform-admin",
        }),
      ).toThrow(/AGENTIC_KEY_VAULT_SECRET is required in production/);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (configuredSecret === undefined) {
        delete process.env.AGENTIC_KEY_VAULT_SECRET;
      } else {
        process.env.AGENTIC_KEY_VAULT_SECRET = configuredSecret;
      }
      service._resetProviderKeyVaultCache();
    }
  });
});
