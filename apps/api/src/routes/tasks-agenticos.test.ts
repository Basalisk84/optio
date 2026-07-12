import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateTaskIdempotent = vi.fn();
const mockGetTaskByKey = vi.fn();
const mockIsDispatchComplete = vi.fn();
const mockMarkDispatchCompleted = vi.fn();
const mockTransitionTask = vi.fn();
const mockAddDependencies = vi.fn();
const mockQueueAdd = vi.fn();

vi.mock("../services/task-service.js", () => ({
  createTaskIdempotent: (...args: unknown[]) => mockCreateTaskIdempotent(...args),
  getTaskByAgenticosIdempotencyKey: (...args: unknown[]) => mockGetTaskByKey(...args),
  isAgenticosDispatchComplete: (...args: unknown[]) => mockIsDispatchComplete(...args),
  markAgenticosDispatchCompleted: (...args: unknown[]) => mockMarkDispatchCompleted(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
  listTasks: vi.fn().mockResolvedValue([]),
  searchTasks: vi.fn().mockResolvedValue({ tasks: [], hasMore: false, nextCursor: null }),
  getTask: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/dependency-service.js", () => ({
  addDependencies: (...args: unknown[]) => mockAddDependencies(...args),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
    getJobs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({ tasks: {} }));

import { taskRoutes } from "./tasks.js";
import { AgenticosIdempotencyConflictError } from "../services/agenticos-idempotency.js";

async function app() {
  const f = Fastify();
  await taskRoutes(f);
  return f;
}

const body = {
  title: "T",
  prompt: "P",
  repoUrl: "https://github.com/o/r",
  agentType: "codex",
};

describe("AgenticOS task route idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransitionTask.mockResolvedValue({});
    mockQueueAdd.mockResolvedValue({});
    mockAddDependencies.mockResolvedValue(undefined);
    mockIsDispatchComplete.mockReturnValue(true);
    mockMarkDispatchCompleted.mockImplementation(async (id: string) => ({
      id,
      agenticosDispatchCompletedAt: new Date().toISOString(),
    }));
  });

  it("passes dependencies and ticket fields into idempotent create for semantic conflict detection", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", priority: 100, maxRetries: 3 },
      created: true,
    });
    const f = await app();
    await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: {
        ...body,
        ticketSource: "github",
        ticketExternalId: "42",
        dependsOn: ["00000000-0000-0000-0000-000000000001"],
      },
    });

    expect(mockCreateTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketSource: "github",
        ticketExternalId: "42",
        dependsOn: ["00000000-0000-0000-0000-000000000001"],
        agenticosIdempotencyKey: "agenticos:run:task",
      }),
    );
    expect(mockAddDependencies).toHaveBeenCalledWith(
      "t1",
      ["00000000-0000-0000-0000-000000000001"],
      { idempotent: true },
    );
    await f.close();
  });

  it("returns existing task and does not enqueue duplicate exact request", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "existing", priority: 100, maxRetries: 3 },
      created: false,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).idempotent).toBe(true);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    await f.close();
  });

  it("rejects matching-key semantic conflicts with 409", async () => {
    mockCreateTaskIdempotent.mockRejectedValueOnce(new AgenticosIdempotencyConflictError());
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: { ...body, dependsOn: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(409);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    await f.close();
  });

  it("accepts matching key across header/body/metadata carriers", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", priority: 100, maxRetries: 3 },
      created: true,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: {
        ...body,
        agenticosIdempotencyKey: "agenticos:run:task",
        metadata: { agenticos: { idempotencyKey: "agenticos:run:task" } },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    await f.close();
  });

  it("keeps non-AgenticOS internal creation failures as 5xx", async () => {
    mockCreateTaskIdempotent.mockRejectedValueOnce(new Error("db down"));
    const f = await app();
    const res = await f.inject({ method: "POST", url: "/api/tasks", payload: body });

    expect(res.statusCode).toBe(500);
    await f.close();
  });

  it("resumes an incomplete duplicate by running transition, queue, and completion marker", async () => {
    mockIsDispatchComplete.mockReturnValueOnce(false);
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "existing", priority: 100, maxRetries: 3 },
      created: false,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockMarkDispatchCompleted).toHaveBeenCalledWith("existing");
    await f.close();
  });

  it("does not mark AgenticOS dispatch complete when queue insertion fails, allowing later retry", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", priority: 100, maxRetries: 3 },
      created: true,
    });
    mockQueueAdd.mockRejectedValueOnce(new Error("queue down"));
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(500);
    expect(mockMarkDispatchCompleted).not.toHaveBeenCalled();
    await f.close();
  });

  it("rejects empty and malformed metadata key carriers", async () => {
    const f = await app();
    const empty = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: { ...body, metadata: { agenticos: { idempotencyKey: "" } } },
    });
    const malformed = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: { ...body, metadata: { agenticos: { idempotencyKey: 123 } } },
    });

    expect(empty.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(mockCreateTaskIdempotent).not.toHaveBeenCalled();
    await f.close();
  });

  it("does not mark AgenticOS dispatch complete when dependency setup fails", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", priority: 100, maxRetries: 3 },
      created: true,
    });
    mockAddDependencies.mockRejectedValueOnce(new Error("missing dep"));
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: { ...body, dependsOn: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockMarkDispatchCompleted).not.toHaveBeenCalled();
    await f.close();
  });

  it("does not mark AgenticOS dispatch complete when transition fails", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", priority: 100, maxRetries: 3 },
      created: true,
    });
    mockTransitionTask.mockRejectedValueOnce(new Error("transition failed"));
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(500);
    expect(mockMarkDispatchCompleted).not.toHaveBeenCalled();
    await f.close();
  });

  it("resumes after an insert/publication failure created an incomplete existing task", async () => {
    mockCreateTaskIdempotent
      .mockRejectedValueOnce(new Error("publish down"))
      .mockResolvedValueOnce({
        task: { id: "existing", priority: 100, maxRetries: 3 },
        created: false,
      });
    mockIsDispatchComplete.mockReturnValueOnce(false);
    const f = await app();
    const first = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });
    const retry = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockMarkDispatchCompleted).toHaveBeenCalledWith("existing");
    await f.close();
  });

  it("resumes an already-queued incomplete duplicate without repeating state transition", async () => {
    mockIsDispatchComplete.mockReturnValueOnce(false);
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "existing", state: "queued", priority: 100, maxRetries: 3 },
      created: false,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockMarkDispatchCompleted).toHaveBeenCalledWith("existing");
    await f.close();
  });

  it("does not acknowledge success if completion marker update returns no durable marker", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "t1", state: "queued", priority: 100, maxRetries: 3 },
      created: true,
    });
    mockMarkDispatchCompleted.mockResolvedValueOnce(null);
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(500);
    await f.close();
  });

  it("marks progressed no-dependency incomplete duplicates complete without transition or queue", async () => {
    mockIsDispatchComplete.mockReturnValueOnce(false);
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "existing", state: "running", priority: 100, maxRetries: 3 },
      created: false,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockMarkDispatchCompleted).toHaveBeenCalledWith("existing");
    await f.close();
  });

  it("marks progressed dependency-backed incomplete duplicates complete without dependency or transition replay", async () => {
    mockIsDispatchComplete.mockReturnValueOnce(false);
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "existing", state: "provisioning", priority: 100, maxRetries: 3 },
      created: false,
    });
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "agenticos:run:task" },
      payload: { ...body, dependsOn: ["00000000-0000-0000-0000-000000000001"] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockAddDependencies).not.toHaveBeenCalled();
    expect(mockTransitionTask).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockMarkDispatchCompleted).toHaveBeenCalledWith("existing");
    await f.close();
  });

  it("rejects ambiguous multi-value idempotency header carriers", async () => {
    const f = await app();
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": ["agenticos:run:task", "agenticos:run:task"] as any },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreateTaskIdempotent).not.toHaveBeenCalled();
    await f.close();
  });

  it("preserves non-AgenticOS create response contract", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "plain", state: "pending", priority: 100, maxRetries: 3 },
      created: true,
    });
    const f = await app();
    const res = await f.inject({ method: "POST", url: "/api/tasks", payload: body });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      task: { id: "plain", state: "pending", priority: 100, maxRetries: 3 },
    });
    expect(mockMarkDispatchCompleted).not.toHaveBeenCalled();
    await f.close();
  });

  it("uses strict two-argument dependency insertion for non-AgenticOS create", async () => {
    mockCreateTaskIdempotent.mockResolvedValueOnce({
      task: { id: "plain", state: "pending", priority: 100, maxRetries: 3 },
      created: true,
    });
    const f = await app();
    const deps = ["00000000-0000-0000-0000-000000000001"];
    const res = await f.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { ...body, dependsOn: deps },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddDependencies).toHaveBeenCalledWith("plain", deps);
    expect(mockAddDependencies).not.toHaveBeenCalledWith("plain", deps, expect.anything());
    await f.close();
  });

  it("looks up by immutable idempotency key", async () => {
    mockGetTaskByKey.mockResolvedValueOnce({ id: "existing" });
    const f = await app();
    const res = await f.inject({
      method: "GET",
      url: "/api/tasks/by-idempotency/agenticos:run:task",
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetTaskByKey).toHaveBeenCalledWith("agenticos:run:task", null);
    await f.close();
  });
});
