import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderEngineConfig } from "../src/cli/engine-config.js";

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
});
