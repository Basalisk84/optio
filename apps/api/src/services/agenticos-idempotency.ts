import { createHash } from "node:crypto";
import { normalizeRepoUrl, type CreateTaskInput } from "@optio/shared";

export class AgenticosIdempotencyConflictError extends Error {
  constructor(message = "AgenticOS idempotency key already exists with a different payload") {
    super(message);
    this.name = "AgenticosIdempotencyConflictError";
  }
}

export type AgenticosRequestKeySource = {
  headers?: Record<string, unknown>;
  body?: unknown;
};

const KEY_RE = /^[A-Za-z0-9._:-]{8,256}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getHeader(headers: Record<string, unknown> | undefined, name: string): unknown {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([k]) => k.toLowerCase() === lower)?.[1];
}

export function validateAgenticosIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (!KEY_RE.test(trimmed)) {
    throw new Error("Invalid AgenticOS idempotency key");
  }
  return trimmed;
}

function suppliedStringCarrier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid AgenticOS idempotency key carrier: ${label}`);
  }
  return validateAgenticosIdempotencyKey(value);
}

export function extractAgenticosIdempotencyKey(
  source: AgenticosRequestKeySource,
): string | undefined {
  const body = asRecord(source.body);
  const metadata = asRecord(body.metadata);
  const agenticos = asRecord(metadata.agenticos);
  const candidates = [
    suppliedStringCarrier(getHeader(source.headers, "idempotency-key"), "header"),
    suppliedStringCarrier(body.agenticosIdempotencyKey, "body"),
    suppliedStringCarrier(agenticos.idempotencyKey, "metadata.agenticos"),
  ].filter((v): v is string => v !== undefined);
  if (candidates.length === 0) return undefined;
  const first = candidates[0];
  if (candidates.some((v) => v !== first)) {
    throw new Error("AgenticOS idempotency key mismatch between sources");
  }
  return first;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stable(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function canonicalMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const root = { ...(metadata ?? {}) };
  const agenticos = asRecord(root.agenticos);
  if (Object.keys(agenticos).length > 0) {
    const { idempotencyKey: _idempotencyKey, ...rest } = agenticos;
    if (Object.keys(rest).length > 0) root.agenticos = rest;
    else delete root.agenticos;
  }
  return root;
}

export function canonicalAgenticosTaskPayload(input: CreateTaskInput): unknown {
  return stable({
    title: input.title,
    prompt: input.prompt,
    repoUrl: normalizeRepoUrl(input.repoUrl),
    repoBranch: input.repoBranch ?? "main",
    agentType: input.agentType,
    ticketSource: input.ticketSource,
    ticketExternalId: input.ticketExternalId,
    metadata: canonicalMetadata(input.metadata),
    dependsOn: [...(input.dependsOn ?? [])].sort(),
    maxRetries: input.maxRetries ?? 3,
    priority: input.priority ?? 100,
  });
}

export function canonicalAgenticosTaskHash(input: CreateTaskInput): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalAgenticosTaskPayload(input)))
    .digest("hex");
}
