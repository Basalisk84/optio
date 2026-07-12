ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agenticos_idempotency_key" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agenticos_payload_hash" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "agenticos_dispatch_completed_at" timestamptz;

CREATE INDEX IF NOT EXISTS "tasks_agenticos_idempotency_key_idx"
  ON "tasks" ("agenticos_idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "tasks_agenticos_workspace_key_unique_idx"
  ON "tasks" (COALESCE("workspace_id"::text, ''), "agenticos_idempotency_key")
  WHERE "agenticos_idempotency_key" IS NOT NULL;
