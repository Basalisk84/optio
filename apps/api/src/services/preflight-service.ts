import type { AgentAdapter } from "@optio/agent-adapters";
import type { AgentContainerConfig } from "@optio/shared";
import { listSecrets } from "./secret-service.js";
import { logger } from "../logger.js";

const RUNTIME_ENV_SECRET_ALLOWLIST = new Set(["GITHUB_TOKEN"]);

export interface PreflightCheckResult {
  passed: boolean;
  checkedAt: string;
  checks: {
    secrets: {
      passed: boolean;
      missing: string[];
      available: string[];
    };
  };
}

/**
 * Run preflight checks before provisioning a task.
 *
 * Checks that the adapter's required secrets are resolvable without
 * fetching or logging any secret values. Uses `listSecrets()` to get
 * secret names and checks the env-var allowlist for runtime secrets.
 *
 * Returns a structured result suitable for persisting in task metadata.
 */
export async function runPreflightChecks(
  adapter: AgentAdapter,
  agentConfig: AgentContainerConfig,
  repoUrl: string,
  workspaceId: string | null,
): Promise<PreflightCheckResult> {
  const log = logger.child({ service: "preflight", repoUrl });

  // Gather available secret names from all scopes (no values fetched)
  const [globalSecrets, repoSecrets] = await Promise.all([
    listSecrets("global", workspaceId).catch(() => []),
    repoUrl !== "global" ? listSecrets(repoUrl, workspaceId).catch(() => []) : Promise.resolve([]),
  ]);

  const availableSecretNames = new Set<string>();
  for (const s of globalSecrets) availableSecretNames.add(s.name);
  for (const s of repoSecrets) availableSecretNames.add(s.name);

  // Add runtime env secrets that are present and non-blank
  for (const name of RUNTIME_ENV_SECRET_ALLOWLIST) {
    const val = process.env[name];
    if (val && val.trim().length > 0) {
      availableSecretNames.add(name);
    }
  }

  // Check agentConfig.requiredSecrets against available names
  const configMissing = agentConfig.requiredSecrets.filter((s) => !availableSecretNames.has(s));

  // Also run the adapter's own validation logic (may check additional constraints)
  const validation = adapter.validateSecrets([...availableSecretNames]);

  // Union of both failure sets, deduplicated
  const allMissing = [...new Set([...configMissing, ...validation.missing])];
  const passed = allMissing.length === 0;

  const result: PreflightCheckResult = {
    passed,
    checkedAt: new Date().toISOString(),
    checks: {
      secrets: {
        passed,
        missing: allMissing,
        available: agentConfig.requiredSecrets.filter((s) => availableSecretNames.has(s)),
      },
    },
  };

  if (!result.passed) {
    log.warn({ missing: validation.missing }, "Preflight check failed: missing required secrets");
  } else {
    log.info("Preflight checks passed");
  }

  return result;
}
