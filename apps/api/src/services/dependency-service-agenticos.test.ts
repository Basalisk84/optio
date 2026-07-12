import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const onConflictDoNothing = vi.fn();
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn();
  const fromWithWhere = vi.fn(() => ({ where }));
  const fromEdges = vi.fn(async () => []);
  const select = vi.fn((selection?: unknown) => ({ from: selection ? fromWithWhere : fromEdges }));
  return { onConflictDoNothing, values, insert, where, fromWithWhere, fromEdges, select };
});

vi.mock("../db/client.js", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
  },
}));
vi.mock("../db/schema.js", () => ({ taskDependencies: {}, tasks: { id: "id" } }));

import { addDependencies } from "./dependency-service.js";

describe("addDependencies idempotent mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.where.mockResolvedValue([{ id: "dep-1" }]);
    mocks.fromEdges.mockResolvedValue([]);
    mocks.onConflictDoNothing.mockResolvedValue(undefined);
  });

  it("uses strict insert behavior by default", async () => {
    await addDependencies("task-1", ["dep-1"]);

    expect(mocks.insert).toHaveBeenCalled();
    expect(mocks.values).toHaveBeenCalledWith([{ taskId: "task-1", dependsOnTaskId: "dep-1" }]);
    expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
  });

  it("uses onConflictDoNothing only when idempotent mode is requested", async () => {
    await addDependencies("task-1", ["dep-1"], { idempotent: true });

    expect(mocks.insert).toHaveBeenCalled();
    expect(mocks.values).toHaveBeenCalledWith([{ taskId: "task-1", dependsOnTaskId: "dep-1" }]);
    expect(mocks.onConflictDoNothing).toHaveBeenCalledOnce();
  });
});
