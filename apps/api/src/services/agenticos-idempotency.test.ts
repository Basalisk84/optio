import { describe, expect, it } from "vitest";
import {
  canonicalAgenticosTaskHash,
  extractAgenticosIdempotencyKey,
} from "./agenticos-idempotency.js";

describe("extractAgenticosIdempotencyKey", () => {
  it("accepts matching header, body, and metadata keys", () => {
    const key = extractAgenticosIdempotencyKey({
      headers: { "idempotency-key": "agenticos:run:task" },
      body: {
        agenticosIdempotencyKey: "agenticos:run:task",
        metadata: { agenticos: { idempotencyKey: "agenticos:run:task" } },
      },
    });
    expect(key).toBe("agenticos:run:task");
  });

  it("rejects mismatched idempotency key sources", () => {
    expect(() =>
      extractAgenticosIdempotencyKey({
        headers: { "idempotency-key": "agenticos:run:one" },
        body: { agenticosIdempotencyKey: "agenticos:run:two" },
      }),
    ).toThrow(/mismatch/i);
  });

  it("rejects invalid keys", () => {
    expect(() =>
      extractAgenticosIdempotencyKey({ body: { agenticosIdempotencyKey: "bad key with spaces" } }),
    ).toThrow(/invalid/i);
  });
});

describe("canonicalAgenticosTaskHash", () => {
  it("hashes semantic task fields deterministically", () => {
    const a = canonicalAgenticosTaskHash({
      title: "T",
      prompt: "P",
      repoUrl: "https://github.com/o/r",
      agentType: "codex",
      metadata: { b: 2, a: 1 },
    });
    const b = canonicalAgenticosTaskHash({
      metadata: { a: 1, b: 2 },
      agentType: "codex",
      repoUrl: "https://github.com/o/r",
      prompt: "P",
      title: "T",
    });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
  });
});

it("does not include idempotency key carrier metadata in payload hash", () => {
  const headerOnly = canonicalAgenticosTaskHash({
    title: "T",
    prompt: "P",
    repoUrl: "https://github.com/o/r",
    agentType: "codex",
  } as any);
  const metadataCarrier = canonicalAgenticosTaskHash({
    title: "T",
    prompt: "P",
    repoUrl: "https://github.com/o/r",
    agentType: "codex",
    metadata: { agenticos: { idempotencyKey: "agenticos:run:task" } },
  } as any);
  expect(metadataCarrier).toBe(headerOnly);
});

it("includes ticket fields and dependencies in payload hash", () => {
  const base = canonicalAgenticosTaskHash({
    title: "T",
    prompt: "P",
    repoUrl: "https://github.com/o/r",
    agentType: "codex",
  } as any);
  expect(
    canonicalAgenticosTaskHash({
      title: "T",
      prompt: "P",
      repoUrl: "https://github.com/o/r",
      agentType: "codex",
      ticketSource: "github",
    } as any),
  ).not.toBe(base);
  expect(
    canonicalAgenticosTaskHash({
      title: "T",
      prompt: "P",
      repoUrl: "https://github.com/o/r",
      agentType: "codex",
      dependsOn: ["00000000-0000-0000-0000-000000000001"],
    } as any),
  ).not.toBe(base);
});

it("rejects empty supplied carriers even with a valid header", () => {
  expect(() =>
    extractAgenticosIdempotencyKey({
      headers: { "idempotency-key": "agenticos:run:task" },
      body: { agenticosIdempotencyKey: "" },
    }),
  ).toThrow(/invalid/i);
});

it("preserves semantic nested empty metadata objects", () => {
  const base = canonicalAgenticosTaskHash({
    title: "T",
    prompt: "P",
    repoUrl: "https://github.com/o/r",
    agentType: "codex",
  } as any);
  const nestedEmpty = canonicalAgenticosTaskHash({
    title: "T",
    prompt: "P",
    repoUrl: "https://github.com/o/r",
    agentType: "codex",
    metadata: { config: {} },
  } as any);
  expect(nestedEmpty).not.toBe(base);
});

it("rejects ambiguous multi-value header carriers", () => {
  expect(() =>
    extractAgenticosIdempotencyKey({
      headers: { "idempotency-key": ["agenticos:run:task", "agenticos:run:task"] },
    }),
  ).toThrow(/carrier/i);
});

it("rejects non-string header carriers", () => {
  expect(() => extractAgenticosIdempotencyKey({ headers: { "idempotency-key": 123 } })).toThrow(
    /carrier/i,
  );
});
