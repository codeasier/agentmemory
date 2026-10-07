import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearPersistedBuiltinConfig,
  persistedBuiltinConfigDirs,
  persistedBuiltinConfigPaths,
  renderEngineConfig,
} from "../src/cli/engine-config.js";

const customDirConfig = [
  "workers:",
  "  - name: iii-http",
  "    config:",
  "      port: 3111",
  "  - name: configuration",
  "    config:",
  "      adapter:",
  "        name: fs",
  "        config:",
  "          directory: ./custom-cfg",
  "  - name: iii-state",
  "    config: {}",
].join("\n");

function shippedConfig(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("bundled iii engine config", () => {
  it.each([
    "iii-config.yaml",
    "iii-config.docker.yaml",
    "deploy/fly/entrypoint.sh",
    "deploy/render/entrypoint.sh",
    "deploy/railway/entrypoint.sh",
    "deploy/coolify/entrypoint.sh",
    "eval/scripts/sandbox.sh",
  ])(
    "keeps the in-memory observability store disabled in %s",
    (file) => {
      const observability = shippedConfig(file)
        .split("- name: iii-observability")[1]
        ?.split("- name:")[0];

      expect(observability).toBeDefined();
      expect(observability).toMatch(/enabled:\s*false/);
      expect(observability).toMatch(/sampling_ratio:\s*0\.1/);
      expect(observability).toMatch(/logs_console_output:\s*false/);
    },
  );
});

describe("renderEngineConfig", () => {
  it("stores engine state in the resolved data directory", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "iii-config.yaml"),
      "utf8",
    );
    const dataDir = join("/var", "lib", "agentmemory");

    const rendered = renderEngineConfig(source, { dataDir });

    expect(rendered).toContain(
      `file_path: '${join(dataDir, "state_store.db")}'`,
    );
    expect(rendered).toContain(
      `file_path: '${join(dataDir, "stream_store")}'`,
    );
    expect(rendered).not.toContain("./data/");
  });

  it("moves the complete native port quartet from one REST override", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "iii-config.yaml"),
      "utf8",
    );

    const rendered = renderEngineConfig(source, {
      dataDir: "/tmp/agentmemory",
      ports: {
        restPort: 3211,
        streamPort: 3212,
        viewerPort: 3213,
        enginePort: 49234,
      },
    });

    expect(rendered).toMatch(
      /- name: iii-http\n\s+config:\n\s+port: 3211/,
    );
    expect(rendered).toMatch(
      /- name: iii-stream\n\s+config:\n\s+port: 3212/,
    );
    expect(rendered).toContain(
      'allowed_origins: ["http://localhost:3211", "http://localhost:3213", "http://127.0.0.1:3211", "http://127.0.0.1:3213"]',
    );
    expect(rendered).toMatch(
      /- name: iii-worker-manager\n\s+config:\n\s+port: 49234\n\s+host: 127\.0\.0\.1/,
    );
  });

  it("keeps the iii- prefixed builtin names: on 0.22.1 the unprefixed names resolve to registry workers", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "iii-config.yaml"),
      "utf8",
    );
    const names = [...source.matchAll(/^\s*- name: (\S+)$/gm)].map((m) => m[1]);

    expect(names).toEqual(
      expect.arrayContaining([
        "iii-http",
        "iii-state",
        "iii-pubsub",
        "iii-cron",
        "iii-queue",
        "iii-stream",
        "iii-observability",
      ]),
    );
    for (const bare of ["http", "state", "pubsub", "cron", "queue"]) {
      expect(names).not.toContain(bare);
    }
  });

  // Ported from upstream b3d6cf5 (rohitg00/agentmemory#1457): the engine's own
  // default is 5000 ms; the shipped config and every render pin 2000 ms, and
  // the override still wins. The key must land in the adapter block.
  it("pins the file-backed save cadence without ports", () => {
    const source = shippedConfig("iii-config.yaml");

    const rendered = renderEngineConfig(source, { dataDir: "/tmp/agentmemory" });
    const intervals = [...rendered.matchAll(/^(\s*)save_interval_ms: (\d+)$/gm)];

    expect(intervals).toHaveLength(2);
    expect(intervals.map((m) => m[2])).toEqual(["2000", "2000"]);
    expect(rendered).toMatch(/store_method: file_based\n\s+save_interval_ms: 2000/);
    for (const match of intervals) {
      expect(rendered).toContain(`${match[1]}store_method: file_based`);
    }
  });

  it("honours AGENTMEMORY_STATE_SAVE_INTERVAL_MS", () => {
    const source = shippedConfig("iii-config.yaml");

    const rendered = renderEngineConfig(source, {
      dataDir: "/tmp/agentmemory",
      saveIntervalMs: 750,
    });

    expect([...rendered.matchAll(/save_interval_ms: (\d+)/g)].map((m) => m[1])).toEqual([
      "750",
      "750",
    ]);
  });

  it("adds the cadence to a file-backed config that never had one", () => {
    const withoutCadence = [
      "workers:",
      "  - name: iii-state",
      "    config:",
      "      adapter:",
      "        name: kv",
      "        config:",
      "          store_method: file_based",
      "          file_path: /tmp/state_store.db",
    ].join("\n");

    const rendered = renderEngineConfig(withoutCadence, { dataDir: "/tmp/agentmemory" });

    expect(rendered).toContain(
      "          store_method: file_based\n          save_interval_ms: 2000\n",
    );
  });
});

describe("clearPersistedBuiltinConfig", () => {
  const configPath = join("/srv", "state", "iii-config.runtime.yaml");

  it("covers the engine cwd, the config file directory and the legacy 0.19 location", () => {
    expect(persistedBuiltinConfigDirs("/srv/engine", configPath)).toEqual([
      join("/srv", "engine", "config"),
      join("/srv", "state", "config"),
      join("/srv", "engine", "data", "configuration"),
    ]);
  });

  it("lists both the unprefixed and the legacy entry name for every seeded builtin", () => {
    const paths = persistedBuiltinConfigPaths("/srv/engine", configPath);

    expect(paths).toContain(join("/srv", "state", "config", "http.yaml"));
    expect(paths).toContain(join("/srv", "state", "config", "iii-http.yaml"));
    expect(paths).toContain(join("/srv", "state", "config", "iii-worker-manager.yaml"));
    expect(paths).toContain(
      join("/srv", "engine", "data", "configuration", "iii-http.yaml"),
    );
    expect(paths.every((p) => p.endsWith(".yaml"))).toBe(true);
  });

  it("adds the directory a configuration worker entry names, resolved against the engine cwd", () => {
    expect(persistedBuiltinConfigDirs("/srv/engine", configPath, customDirConfig)).toEqual([
      join("/srv", "engine", "custom-cfg"),
      join("/srv", "engine", "config"),
      join("/srv", "state", "config"),
      join("/srv", "engine", "data", "configuration"),
    ]);
    expect(
      persistedBuiltinConfigDirs(
        "/srv/engine",
        configPath,
        customDirConfig.replace("./custom-cfg", "'/var/lib/iii-cfg'"),
      )[0],
    ).toBe(join("/var", "lib", "iii-cfg"));
    expect(
      persistedBuiltinConfigDirs("/srv/engine", configPath, "workers:\n  - name: iii-http\n"),
    ).toEqual(persistedBuiltinConfigDirs("/srv/engine", configPath));
  });

  it("removes persisted builtin entries from both locations and leaves everything else in place", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentmemory-engine-"));
    const dataDir = mkdtempSync(join(tmpdir(), "agentmemory-data-"));
    const runtimeConfig = join(dataDir, "iii-config.runtime.yaml");
    const current = join(dataDir, "config");
    const legacy = join(cwd, "data", "configuration");
    mkdirSync(current, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(current, "http.yaml"), "id: http\nvalue:\n  port: 3111\n");
    writeFileSync(join(current, "iii-state.yaml"), "id: iii-state\nvalue: {}\n");
    writeFileSync(join(current, "agentmemory.yaml"), "id: agentmemory\nvalue: {}\n");
    writeFileSync(join(legacy, "iii-http.yaml"), "id: iii-http\nvalue:\n  port: 3111\n");

    const cleared = clearPersistedBuiltinConfig(cwd, runtimeConfig);

    expect(cleared).toHaveLength(3);
    expect(existsSync(join(current, "http.yaml"))).toBe(false);
    expect(existsSync(join(current, "iii-state.yaml"))).toBe(false);
    expect(existsSync(join(legacy, "iii-http.yaml"))).toBe(false);
    expect(existsSync(join(current, "agentmemory.yaml"))).toBe(true);
  });

  it("removes the entries the engine persisted under a custom configuration directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentmemory-engine-"));
    const dir = join(cwd, "custom-cfg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "iii-http.yaml"), "id: iii-http\nvalue:\n  port: 3111\n");
    writeFileSync(join(dir, "agentmemory.yaml"), "id: agentmemory\nvalue: {}\n");

    const cleared = clearPersistedBuiltinConfig(
      cwd,
      join(cwd, "iii-config.runtime.yaml"),
      customDirConfig,
    );

    expect(cleared).toEqual([join(dir, "iii-http.yaml")]);
    expect(existsSync(join(dir, "agentmemory.yaml"))).toBe(true);
  });

  it("leaves files that are not engine entries alone, even under a seeded builtin name", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentmemory-engine-"));
    const dir = join(cwd, "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "http.yaml"), "host: 0.0.0.0\nport: 8080\n");
    writeFileSync(join(dir, "state.yaml"), "id: something-else\nvalue: {}\n");
    writeFileSync(join(dir, "iii-http.yaml"), "\nid: iii-http\nname: HTTP\nvalue:\n  port: 3111\n");

    const cleared = clearPersistedBuiltinConfig(cwd, join(cwd, "iii-config.runtime.yaml"));

    expect(cleared).toEqual([join(dir, "iii-http.yaml")]);
    expect(existsSync(join(dir, "http.yaml"))).toBe(true);
    expect(existsSync(join(dir, "state.yaml"))).toBe(true);
  });

  it("is a no-op when the engine has never persisted anything", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentmemory-engine-"));

    expect(
      clearPersistedBuiltinConfig(cwd, join(cwd, "iii-config.runtime.yaml")),
    ).toEqual([]);
  });

  it("fails loudly when a persisted entry exists but cannot be removed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentmemory-engine-"));
    mkdirSync(join(cwd, "config", "http.yaml"), { recursive: true });

    expect(() =>
      clearPersistedBuiltinConfig(cwd, join(cwd, "iii-config.runtime.yaml")),
    ).toThrow(/http\.yaml/);
  });
});
