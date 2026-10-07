import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// better-sqlite3 is an optional dependency and is not installed here; the
// legacy store is faked at the driver boundary so the import path is the real
// one.
vi.mock("better-sqlite3", () => ({
  default: () => ({
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes("FROM sessions")) {
          return [
            {
              session_id: "ses_a",
              project_path: "/repo/a",
              created_at: "2026-01-03T00:00:00Z",
            },
            {
              session_id: "ses_b",
              project_path: "/repo/b",
              created_at: "2026-01-02T00:00:00Z",
            },
            {
              session_id: "ses_c",
              project_path: "/repo/c",
              created_at: "2026-01-01T00:00:00Z",
            },
          ];
        }
        if (sql.includes("FROM observations")) {
          return [
            { id: "obs_1", session_id: "ses_a", created_at: "2026-01-03T00:00:01Z" },
            { id: "obs_2", session_id: "ses_a", created_at: "2026-01-03T00:00:02Z" },
            { id: "obs_3", session_id: "ses_b", created_at: "2026-01-02T00:00:01Z" },
            { id: "obs_4", session_id: "ghost", created_at: "2026-01-01T00:00:01Z" },
          ];
        }
        return [];
      },
    }),
    close: () => {},
  }),
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMigrateFunction } from "../src/functions/migrate.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const dbDir = join(homedir(), ".agentmemory");
const dbPath = join(dbDir, "migrate-observation-count.db");

describe("mem::migrate observation counts", () => {
  afterEach(() => {
    rmSync(dbPath, { force: true });
  });

  it("tallies each migrated session's observationCount", async () => {
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(dbPath, "");
    const kv = mockKV();
    const sdk = mockSdk();
    registerMigrateFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::migrate", {
      dbPath,
    })) as { success: boolean; sessionCount: number; obsCount: number };

    expect(result.success).toBe(true);
    expect(result.sessionCount).toBe(3);
    expect(result.obsCount).toBe(4);
    expect(await kv.get(KV.sessions, "ses_a")).toMatchObject({
      observationCount: 2,
    });
    expect(await kv.get(KV.sessions, "ses_b")).toMatchObject({
      observationCount: 1,
    });
    expect(await kv.get(KV.sessions, "ses_c")).toMatchObject({
      observationCount: 0,
    });
    expect(await kv.get(KV.sessions, "ghost")).toBeNull();
  });
});
