export type ClaudeAuthMode = "api-key" | "max-subscription" | "host-claude";

export interface AgentTaskInput {
  taskId: string;
  prompt: string;
  repoUrl: string;
  repoBranch: string;
  additionalContext?: string;
  claudeAuthMode?: ClaudeAuthMode;
  optioApiUrl?: string; // for apiKeyHelper callback
  /** The rendered system prompt (from the prompt template) */
  renderedPrompt?: string;
  /** The task file content to write into the worktree */
  taskFileContent?: string;
  /** Path for the task file inside the worktree */
  taskFilePath?: string;
  claudeModel?: string;
  claudeContextWindow?: string;
  claudeThinking?: boolean;
  claudeEffort?: string;
}

export interface AgentContainerConfig {
  command: string[];
  env: Record<string, string>;
  requiredSecrets: string[];
  image?: string;
  /** Files to create inside the container before running the agent */
  setupFiles?: Array<{ path: string; content: string; executable?: boolean }>;
}

export interface AgentResult {
  success: boolean;
  prUrl?: string;
  summary?: string;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface AgentConfig {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
