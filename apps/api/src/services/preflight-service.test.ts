import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the service
vi.mock("./secret-service.js", () => ({
  listSecrets: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import { listSecrets } from "./secret-service.js";
import { runPreflightChecks } from "./preflight-service.js";
import type { AgentAdapter } from "@optio/agent-adapters";
import type { AgentContainerConfig } from "@optio/shared";

function makeAdapter(required: string[]): AgentAdapter {
  return {
    type: "test",
    displayName: "Test Adapter",
    validateSecrets(available: string[]) {
      const missing = required.filter((s) => !available.includes(s));
      return { valid: missing.length === 0, missing };
    },
    buildContainerConfig: vi.fn(),
    parseResult: vi.fn(),
  };
}

function makeConfig(requiredSecrets: string[]): AgentContainerConfig {
  return {
    command: ["echo", "test"],
    env: {},
    requiredSecrets,
  };
}

describe("preflight-service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("passes when all required secrets are available globally", async () => {
    vi.mocked(listSecrets)
      .mockResolvedValueOnce([
        {
          id: "1",
          name: "GITHUB_TOKEN",
          scope: "global",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "2",
          name: "ANTHROPIC_API_KEY",
          scope: "global",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([]);

    const adapter = makeAdapter(["GITHUB_TOKEN"]);
    const config = makeConfig(["GITHUB_TOKEN"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(true);
    expect(result.checks.secrets.passed).toBe(true);
    expect(result.checks.secrets.missing).toEqual([]);
    expect(result.checks.secrets.available).toContain("GITHUB_TOKEN");
    expect(result.checkedAt).toBeTruthy();
  });

  it("fails when a required secret is missing", async () => {
    vi.mocked(listSecrets)
      .mockResolvedValueOnce([]) // no global secrets
      .mockResolvedValueOnce([]); // no repo secrets

    const adapter = makeAdapter(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
    const config = makeConfig(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(false);
    expect(result.checks.secrets.passed).toBe(false);
    expect(result.checks.secrets.missing).toContain("GITHUB_TOKEN");
    expect(result.checks.secrets.missing).toContain("ANTHROPIC_API_KEY");
  });

  it("resolves GITHUB_TOKEN from environment when present", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    vi.mocked(listSecrets)
      .mockResolvedValueOnce([]) // no global secrets in DB
      .mockResolvedValueOnce([]);

    const adapter = makeAdapter(["GITHUB_TOKEN"]);
    const config = makeConfig(["GITHUB_TOKEN"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(true);
    expect(result.checks.secrets.available).toContain("GITHUB_TOKEN");
  });

  it("does not count blank env vars as available", async () => {
    process.env.GITHUB_TOKEN = "   ";
    vi.mocked(listSecrets).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const adapter = makeAdapter(["GITHUB_TOKEN"]);
    const config = makeConfig(["GITHUB_TOKEN"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(false);
    expect(result.checks.secrets.missing).toContain("GITHUB_TOKEN");
  });

  it("combines repo-scoped and global secrets", async () => {
    vi.mocked(listSecrets)
      .mockResolvedValueOnce([
        {
          id: "1",
          name: "GITHUB_TOKEN",
          scope: "global",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "2",
          name: "ANTHROPIC_API_KEY",
          scope: "https://github.com/o/r",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

    const adapter = makeAdapter(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
    const config = makeConfig(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(true);
    expect(result.checks.secrets.available).toContain("GITHUB_TOKEN");
    expect(result.checks.secrets.available).toContain("ANTHROPIC_API_KEY");
  });

  it("handles listSecrets failure gracefully", async () => {
    vi.mocked(listSecrets)
      .mockRejectedValueOnce(new Error("DB connection failed"))
      .mockRejectedValueOnce(new Error("DB connection failed"));

    // Adapter with no required secrets should still pass
    const adapter = makeAdapter([]);
    const config = makeConfig([]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(true);
  });

  it("handles listSecrets failure with required secrets", async () => {
    vi.mocked(listSecrets)
      .mockRejectedValueOnce(new Error("DB connection failed"))
      .mockRejectedValueOnce(new Error("DB connection failed"));

    const adapter = makeAdapter(["GITHUB_TOKEN"]);
    const config = makeConfig(["GITHUB_TOKEN"]);
    // GITHUB_TOKEN not in env either
    delete process.env.GITHUB_TOKEN;
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(result.passed).toBe(false);
    expect(result.checks.secrets.missing).toContain("GITHUB_TOKEN");
  });

  it("does not fetch or expose secret values", async () => {
    vi.mocked(listSecrets)
      .mockResolvedValueOnce([
        {
          id: "1",
          name: "GITHUB_TOKEN",
          scope: "global",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([]);

    const adapter = makeAdapter(["GITHUB_TOKEN"]);
    const config = makeConfig(["GITHUB_TOKEN"]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    // Result should contain only names, never values
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("encryptedValue");
    expect(serialized).not.toContain("authTag");

    // listSecrets only returns refs (name, scope, id), not values
    expect(listSecrets).toHaveBeenCalledWith("global", null);
  });

  it("skips repo-scoped list when repoUrl is 'global'", async () => {
    vi.mocked(listSecrets).mockResolvedValueOnce([]);

    const adapter = makeAdapter([]);
    const config = makeConfig([]);
    const result = await runPreflightChecks(adapter, config, "global", null);

    expect(result.passed).toBe(true);
    // Should only call listSecrets once (global), not twice
    expect(listSecrets).toHaveBeenCalledTimes(1);
  });

  it("returns a valid ISO timestamp in checkedAt", async () => {
    vi.mocked(listSecrets).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const adapter = makeAdapter([]);
    const config = makeConfig([]);
    const result = await runPreflightChecks(adapter, config, "https://github.com/o/r", null);

    expect(() => new Date(result.checkedAt)).not.toThrow();
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });
});
