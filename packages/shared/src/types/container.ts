export interface ContainerSpec {
  image: string;
  command: string[];
  env: Record<string, string>;
  workDir: string;
  cpuLimit?: string;
  memoryLimit?: string;
  labels: Record<string, string>;
  volumes?: VolumeMount[];
  networkMode?: string;
  imagePullPolicy?: "Always" | "Never" | "IfNotPresent";
  runAsUser?: number;
  runAsGroup?: number;
  /** Optional pod name override. If not set, the runtime generates one. */
  name?: string;
}

export interface VolumeMount {
  hostPath?: string;
  persistentVolumeClaim?: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface ContainerHandle {
  id: string;
  name: string;
}

export interface ContainerStatus {
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  exitCode?: number;
  startedAt?: Date;
  finishedAt?: Date;
  reason?: string;
}

export interface ExecSession {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  resize(cols: number, rows: number): void;
  close(): void;
}
