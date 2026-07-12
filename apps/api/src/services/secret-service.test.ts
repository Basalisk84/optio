import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the database module before importing the service
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock the schema to return simple column references
vi.mock("../db/schema.js", () => ({
  secrets: {
    id: "secrets.id",
    name: "secrets.name",
    scope: "secrets.scope",
    encryptedValue: "secrets.encrypted_value",
    iv: "secrets.iv",
    authTag: "secrets.auth_tag",
    createdAt: "secrets.created_at",
    updatedAt: "secrets.updated_at",
  },
}));

import { db } from "../db/client.js";

// Set encryption key before importing the service (it caches on first access)
const TEST_KEY = "a".repeat(64); // 64-char hex string
process.env.OPTIO_ENCRYPTION_KEY = TEST_KEY;

describe("secret-service", () => {
  let storeSecret: typeof import("./secret-service.js").storeSecret;
  let retrieveSecret: typeof import("./secret-service.js").retrieveSecret;
  let listSecrets: typeof import("./secret-service.js").listSecrets;
  let deleteSecret: typeof import("./secret-service.js").deleteSecret;
  let resolveSecretsForTask: typeof import("./secret-service.js").resolveSecretsForTask;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./secret-service.js");
    storeSecret = mod.storeSecret;
    retrieveSecret = mod.retrieveSecret;
    listSecrets = mod.listSecrets;
    deleteSecret = mod.deleteSecret;
    resolveSecretsForTask = mod.resolveSecretsForTask;
  });

  describe("encryption round-trip", () => {
    it("stores and retrieves a secret with correct decryption", async () => {
      const secretValue = "my-super-secret-api-key-12345";
      let capturedEncrypted: Buffer;
      let capturedIv: Buffer;
      let capturedAuthTag: Buffer;

      const selectMock = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (db.select as any) = selectMock;

      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedEncrypted = vals.encryptedValue;
          capturedIv = vals.iv;
          capturedAuthTag = vals.authTag;
          return Promise.resolve();
        }),
      });
      (db.insert as any) = insertMock;

      await storeSecret("API_KEY", secretValue);

      expect(capturedEncrypted!).toBeInstanceOf(Buffer);
      expect(capturedIv!).toBeInstanceOf(Buffer);
      expect(capturedAuthTag!).toBeInstanceOf(Buffer);
      expect(capturedEncrypted!.toString("utf8")).not.toBe(secretValue);

      const selectForRetrieve = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "test-id",
              name: "API_KEY",
              scope: "global",
              encryptedValue: capturedEncrypted!,
              iv: capturedIv!,
              authTag: capturedAuthTag!,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        }),
      });
      (db.select as any) = selectForRetrieve;

      const result = await retrieveSecret("API_KEY");
      expect(result).toBe(secretValue);
    });

    it("handles multi-line secret values", async () => {
      const multiLine = "line1\nline2\nline3\nspecial chars: !@#$%^&*()";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("MULTI", multiLine);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("MULTI");
      expect(result).toBe(multiLine);
    });

    it("handles unicode secret values", async () => {
      const unicode = "秘密のキー 🔑 пароль";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("UNICODE", unicode);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("UNICODE");
      expect(result).toBe(unicode);
    });
  });

  describe("storeSecret", () => {
    it("updates existing secret when one already exists", async () => {
      const updateSetMock = vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "existing-id" }]),
        }),
      });
      (db.update as any) = vi.fn().mockReturnValue({ set: updateSetMock });

      await storeSecret("EXISTING_KEY", "new-value");
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new secret when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await storeSecret("NEW_KEY", "value");
      expect(db.insert).toHaveBeenCalled();
    });

    it("uses custom scope when provided", async () => {
      let capturedScope: string;

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedScope = vals.scope;
          return Promise.resolve();
        }),
      });

      await storeSecret("KEY", "val", "https://github.com/owner/repo");
      expect(capturedScope!).toBe("https://github.com/owner/repo");
    });
  });

  describe("retrieveSecret", () => {
    it("throws when secret is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("MISSING")).rejects.toThrow("Secret not found: MISSING");
    });

    it("includes scope in error message", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("KEY", "my-repo")).rejects.toThrow(
        "Secret not found: KEY (scope: my-repo)",
      );
    });
  });

  describe("listSecrets", () => {
    it("returns secrets without values", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY_A",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-02"),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(mockRows) }),
      });

      const result = await listSecrets("global");
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("encryptedValue");
      expect(result[0].name).toBe("KEY_A");
    });

    it("returns all secrets when no scope filter", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listSecrets();
      expect(result).toHaveLength(1);
    });
  });

  describe("deleteSecret", () => {
    it("calls delete with correct name and scope", async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      (db.delete as any) = vi.fn().mockReturnValue({ where: whereMock });

      await deleteSecret("MY_KEY", "my-scope");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("resolveSecretsForTask", () => {
    it("uses environment values before encrypted DB secrets", async () => {
      const previous = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "env-gh-token";
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("DB should not be touched for env secret")),
        }),
      });

      try {
        const result = await resolveSecretsForTask(
          ["GITHUB_TOKEN"],
          "https://github.com/owner/repo",
        );
        expect(result.GITHUB_TOKEN).toBe("env-gh-token");
        expect(db.select).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previous;
      }
    });

    it("ignores blank allowed environment secret values", async () => {
      const previous = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "   ";
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      try {
        await expect(resolveSecretsForTask(["GITHUB_TOKEN"], "global")).rejects.toThrow(
          "Secret not found: GITHUB_TOKEN",
        );
        expect(db.select).toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previous;
      }
    });

    it("does not use unapproved environment variables as task secrets", async () => {
      const previous = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "env-anthropic-token";
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      try {
        await expect(resolveSecretsForTask(["ANTHROPIC_API_KEY"], "global")).rejects.toThrow(
          "Secret not found: ANTHROPIC_API_KEY",
        );
        expect(db.select).toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previous;
      }
    });

    it("falls back to global when repo-scoped secret is not found", async () => {
      let capturedGlobal: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedGlobal = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("API_KEY", "global-key-value");

      let resolveCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            resolveCallCount++;
            if (resolveCallCount === 1) return Promise.resolve([]);
            return Promise.resolve([
              {
                encryptedValue: capturedGlobal!.encrypted,
                iv: capturedGlobal!.iv,
                authTag: capturedGlobal!.authTag,
              },
            ]);
          }),
        }),
      }));

      const result = await resolveSecretsForTask(["API_KEY"], "https://github.com/owner/repo");
      expect(result.API_KEY).toBe("global-key-value");
    });

    it("uses repo-scoped secret when available", async () => {
      let capturedRepo: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedRepo = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("TOKEN", "repo-specific-token", "https://github.com/owner/repo");

      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              encryptedValue: capturedRepo!.encrypted,
              iv: capturedRepo!.iv,
              authTag: capturedRepo!.authTag,
            },
          ]),
        }),
      }));

      const result = await resolveSecretsForTask(["TOKEN"], "https://github.com/owner/repo");
      expect(result.TOKEN).toBe("repo-specific-token");
    });
  });
});
