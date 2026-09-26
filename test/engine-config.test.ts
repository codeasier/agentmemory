import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function shippedConfig(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("bundled iii engine config", () => {
  it.each(["iii-config.yaml", "iii-config.docker.yaml"])(
    "keeps the in-memory observability store disabled in %s",
    (file) => {
      const observability = shippedConfig(file)
        .split("- name: iii-observability")[1]
        ?.split("- name:")[0];

      expect(observability).toBeDefined();
      expect(observability).toMatch(/enabled:\s*false/);
    },
  );
});
