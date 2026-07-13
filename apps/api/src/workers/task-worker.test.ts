import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAgentCommand,
  inferExitCode,
  normalizeClaudeAuthMode,
  resolveClaudeAuthMode,
  toAdapterClaudeAuthMode,
} from "./task-worker.js";

describe("resolveClaudeAuthMode", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPTIO_AUTH_MODE;
    delete process.env.CLAUDE_AUTH_MODE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("normalizes supported configured auth modes", () => {
    expect(normalizeClaudeAuthMode("api-key")).toBe("api-key");
    expect(normalizeClaudeAuthMode("max-subscription")).toBe("max-subscription");
    expect(normalizeClaudeAuthMode("oauth-token")).toBe("oauth-token");
    expect(normalizeClaudeAuthMode("host-claude")).toBe("host-claude");
    expect(normalizeClaudeAuthMode("bad-mode")).toBeNull();
  });

  it("maps oauth-token to the adapter OAuth-compatible auth path", () => {
    expect(toAdapterClaudeAuthMode("api-key")).toBe("api-key");
    expect(toAdapterClaudeAuthMode("max-subscription")).toBe("max-subscription");
    expect(toAdapterClaudeAuthMode("oauth-token")).toBe("max-subscription");
    expect(toAdapterClaudeAuthMode("host-claude")).toBe("host-claude");
  });

  it("prefers OPTIO_AUTH_MODE over the secrets table", async () => {
    process.env.OPTIO_AUTH_MODE = "max-subscription";
    const retrieveModeSecret = vi.fn(async () => "api-key");

    await expect(resolveClaudeAuthMode({ warn: vi.fn() }, retrieveModeSecret)).resolves.toBe(
      "max-subscription",
    );
    expect(retrieveModeSecret).not.toHaveBeenCalled();
  });

  it("falls back to api-key when the optional DB auth mode secret cannot decrypt", async () => {
    const warn = vi.fn();
    const retrieveModeSecret = vi.fn(async () => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    await expect(resolveClaudeAuthMode({ warn }, retrieveModeSecret)).resolves.toBe("api-key");
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("buildAgentCommand", () => {
  describe("claude-code agent", () => {
    it("produces a basic claude command with prompt from env", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("claude-code", env);

      expect(cmds.some((c) => c.includes("claude -p"))).toBe(true);
      expect(cmds.some((c) => c.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(cmds.some((c) => c.includes("--output-format stream-json"))).toBe(true);
      expect(cmds.some((c) => c.includes("--verbose"))).toBe(true);
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    it("uses default coding max turns (250)", () => {
      const env = { OPTIO_PROMPT: "Do stuff" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    it("uses default review max turns (10) when isReview is true", () => {
      const env = { OPTIO_PROMPT: "Review PR" };
      const cmds = buildAgentCommand("claude-code", env, { isReview: true });
      expect(cmds.some((c) => c.includes("--max-turns 10"))).toBe(true);
    });

    it("respects custom maxTurnsCoding override", () => {
      const env = { OPTIO_PROMPT: "Build feature" };
      const cmds = buildAgentCommand("claude-code", env, { maxTurnsCoding: 100 });
      expect(cmds.some((c) => c.includes("--max-turns 100"))).toBe(true);
    });

    it("respects custom maxTurnsReview override for reviews", () => {
      const env = { OPTIO_PROMPT: "Review code" };
      const cmds = buildAgentCommand("claude-code", env, {
        isReview: true,
        maxTurnsReview: 25,
      });
      expect(cmds.some((c) => c.includes("--max-turns 25"))).toBe(true);
    });

    it("adds resume flag when resumeSessionId is provided", () => {
      const env = { OPTIO_PROMPT: "Continue work" };
      const cmds = buildAgentCommand("claude-code", env, {
        resumeSessionId: "sess-abc-123",
      });
      expect(cmds.some((c) => c.includes("--resume"))).toBe(true);
      expect(cmds.some((c) => c.includes("sess-abc-123"))).toBe(true);
    });

    it("uses resumePrompt with original prompt as context when provided", () => {
      const env = { OPTIO_PROMPT: "Original prompt" };
      const cmds = buildAgentCommand("claude-code", env, {
        resumePrompt: "Fix the tests now",
      });
      expect(cmds.some((c) => c.includes("Fix the tests now"))).toBe(true);
      expect(cmds.some((c) => c.includes("Original prompt"))).toBe(true);
    });

    it("adds max-subscription auth setup when auth mode is max-subscription", () => {
      const env = {
        OPTIO_PROMPT: "Do work",
        OPTIO_AUTH_MODE: "max-subscription",
        OPTIO_API_URL: "http://localhost:4000",
      };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("Token proxy OK"))).toBe(true);
      expect(cmds.some((c) => c.includes("unset ANTHROPIC_API_KEY"))).toBe(true);
    });

    it("does not add auth setup for api-key mode", () => {
      const env = { OPTIO_PROMPT: "Do work", OPTIO_AUTH_MODE: "api-key" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("Token proxy OK"))).toBe(false);
      expect(cmds.some((c) => c.includes("unset ANTHROPIC_API_KEY"))).toBe(false);
    });

    it("links host-mounted Claude config without token env in host-claude mode", () => {
      const env = {
        OPTIO_PROMPT: "Do work",
        OPTIO_AUTH_MODE: "host-claude",
        HOME: "/tmp/agent",
      };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("/optio-host-claude/.claude"))).toBe(true);
      expect(cmds.some((c) => c.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(true);
      expect(cmds.some((c) => c.includes("Token proxy OK"))).toBe(false);
    });

    it("includes review label in echo when isReview is true", () => {
      const env = { OPTIO_PROMPT: "Review" };
      const cmds = buildAgentCommand("claude-code", env, { isReview: true });
      expect(cmds.some((c) => c.includes("(review)"))).toBe(true);
    });
  });

  describe("codex agent", () => {
    it("produces a codex exec command", () => {
      const env = { OPTIO_PROMPT: "Build feature" };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("codex exec"))).toBe(true);
      expect(cmds.some((c) => c.includes("--full-auto"))).toBe(true);
      expect(cmds.some((c) => c.includes("--json"))).toBe(true);
    });
  });

  describe("unknown agent", () => {
    it("produces an error exit command for unknown agent types", () => {
      const env = { OPTIO_PROMPT: "Do something" };
      const cmds = buildAgentCommand("unknown-agent", env);
      expect(cmds.some((c) => c.includes("Unknown agent type"))).toBe(true);
      expect(cmds.some((c) => c.includes("exit 1"))).toBe(true);
    });
  });
});

describe("inferExitCode", () => {
  describe("claude-code", () => {
    it("returns 0 for clean logs", () => {
      const logs = '{"type":"assistant","content":"All done"}\n';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });

    it("returns 1 when is_error is true in result", () => {
      const logs = '{"type":"result","is_error":true,"error":"Something failed"}\n';
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on fatal git error", () => {
      const logs = "fatal: repository not found\n";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on authentication_failed error", () => {
      const logs = "Error: authentication_failed - token expired\n";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 when exit 1 appears in logs", () => {
      const logs = "some output\nexit 1\nmore output\n";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 0 when logs contain non-fatal content", () => {
      const logs = '{"type":"result","is_error":false}\nCompleted successfully\n';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });
  });

  describe("codex", () => {
    it("returns 0 for clean codex logs", () => {
      const logs = '{"type":"message","content":"Done"}\n';
      expect(inferExitCode("codex", logs)).toBe(0);
    });

    it("returns 1 when error event is present", () => {
      const logs = '{"type":"error","message":"something broke"}\n';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 when error event has spaces in JSON", () => {
      const logs = '{"type": "error", "message": "broke"}\n';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on OPENAI_API_KEY auth error", () => {
      const logs = "Error: OPENAI_API_KEY is not set\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on invalid API key", () => {
      const logs = "invalid api key provided\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on quota exceeded", () => {
      const logs = "Error: insufficient_quota - you have exceeded your billing limit\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on billing error", () => {
      const logs = "billing limit exceeded\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });
  });

  describe("default (unknown agent type)", () => {
    it("uses claude-code patterns as default", () => {
      expect(inferExitCode("some-future-agent", "fatal: error")).toBe(1);
      expect(inferExitCode("some-future-agent", "all good")).toBe(0);
    });
  });
});
