import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import type { SecretRef } from "@optio/shared";

const ALGORITHM = "aes-256-gcm";
const RUNTIME_ENV_SECRET_ALLOWLIST = new Set(["GITHUB_TOKEN"]);

function getEncryptionKey(): Buffer {
  const key = process.env.OPTIO_ENCRYPTION_KEY;
  if (!key) throw new Error("OPTIO_ENCRYPTION_KEY is not set");
  if (key.length === 64 && /^[0-9a-f]+$/i.test(key)) {
    return Buffer.from(key, "hex");
  }
  return createHash("sha256").update(key).digest();
}

let _encryptionKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (!_encryptionKey) {
    _encryptionKey = getEncryptionKey();
  }
  return _encryptionKey;
}

export function encrypt(plaintext: string): { encrypted: Buffer; iv: Buffer; authTag: Buffer } {
  const key = encryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

export function decrypt(encrypted: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

export async function storeSecret(
  name: string,
  value: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<void> {
  const { encrypted, iv, authTag } = encrypt(value);

  // Build conditions for lookup
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));

  // Try update first, then insert
  const existing = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(...conditions));

  if (existing.length > 0) {
    await db
      .update(secrets)
      .set({ encryptedValue: encrypted, iv, authTag, updatedAt: new Date() })
      .where(and(...conditions));
  } else {
    await db.insert(secrets).values({
      name,
      scope,
      encryptedValue: encrypted,
      iv,
      authTag,
      workspaceId: workspaceId ?? undefined,
    });
  }
}

export async function retrieveSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<string> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));

  const [secret] = await db
    .select()
    .from(secrets)
    .where(and(...conditions));
  if (!secret) throw new Error(`Secret not found: ${name} (scope: ${scope})`);
  return decrypt(secret.encryptedValue, secret.iv, secret.authTag);
}

export async function listSecrets(
  scope?: string,
  workspaceId?: string | null,
): Promise<SecretRef[]> {
  const conditions = [];
  if (scope) conditions.push(eq(secrets.scope, scope));
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(secrets)
          .where(and(...conditions))
      : db.select().from(secrets);
  const rows = await query;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
): Promise<void> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));
  await db.delete(secrets).where(and(...conditions));
}

export async function resolveSecretsForTask(
  requiredSecrets: string[],
  scope = "global",
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of requiredSecrets) {
    const envValue = RUNTIME_ENV_SECRET_ALLOWLIST.has(name) ? process.env[name] : undefined;
    if (envValue && envValue.trim().length > 0) {
      resolved[name] = envValue;
      continue;
    }

    if (scope !== "global") {
      // Try repo-scoped secret first, fall back to global
      try {
        resolved[name] = await retrieveSecret(name, scope);
        continue;
      } catch {
        // Not found at repo scope — fall through to global
      }
    }
    resolved[name] = await retrieveSecret(name, "global");
  }
  return resolved;
}
