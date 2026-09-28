import { describe, expect, it } from "vitest";
import { truncate, TRUNCATION_MARKER } from "../src/hooks/truncate.js";

// The hook caps tool_output at 32000 characters on the wire, but every case
// here uses smaller budgets so the arithmetic stays auditable.

describe("truncate — serialized-length string bound", () => {
  it("returns a string unchanged when it fits", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("returns a string unchanged when it fits exactly", () => {
    const s = "a".repeat(50);
    expect(JSON.stringify(s).length).toBe(52);
    expect(truncate(s, 52)).toBe(s);
  });

  it("cuts so the serialized form fits even when escapes double the length", () => {
    const quoteHeavy = '"'.repeat(2000);
    const result = truncate(quoteHeavy, 300) as string;
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    // 2 quotes + 2 per escaped quote + marker must fit the budget.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(300);
  });

  it("handles backslash and control-character expansion", () => {
    const s = "\n".repeat(500);
    const result = truncate(s, 100) as string;
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100);
  });

  it("keeps as many whole characters as the budget allows", () => {
    const s = "a".repeat(1000);
    const result = truncate(s, 100) as string;
    // 2 quotes + 84 a's + 14 marker chars = 100 serialized.
    expect(result).toBe("a".repeat(84) + TRUNCATION_MARKER);
  });

  it("does not throw on budgets smaller than the marker", () => {
    const result = truncate("abcdef", 0) as string;
    expect(typeof result).toBe("string");
  });
});

describe("truncate — smallest fields survive a huge sibling", () => {
  it("keeps file_path and exit_code when an escape-heavy stdout cannot fit", () => {
    const output = {
      stdout: '"'.repeat(600),
      file_path: "/very/important/path.ts",
      exit_code: 0,
    };
    const result = truncate(output, 60) as Record<string, unknown>;
    expect(result["file_path"]).toBe("/very/important/path.ts");
    expect(result["exit_code"]).toBe(0);
    expect("stdout" in result).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(60);
  });

  it("keeps small fields and a truncated stdout when the budget allows both", () => {
    const output = {
      stdout: '"'.repeat(600),
      file_path: "/very/important/path.ts",
      exit_code: 0,
    };
    const result = truncate(output, 300) as Record<string, unknown>;
    expect(result["file_path"]).toBe("/very/important/path.ts");
    expect(result["exit_code"]).toBe(0);
    expect((result["stdout"] as string).endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(300);
  });

  it("keeps later fields when a long primitive cannot fit", () => {
    const output = {
      a: 1234567890123456789012345678901234567890,
      keep_me: "yes",
    };
    const result = truncate(output, 40) as Record<string, unknown>;
    expect(result["keep_me"]).toBe("yes");
  });

  it("keeps later fields when a long key cannot fit", () => {
    const output = {
      "an extremely long field name that outlives the budget": "v",
      k: 1,
    };
    const result = truncate(output, 40) as Record<string, unknown>;
    expect(result["k"]).toBe(1);
  });

  it("keeps later array elements when an unfittable element is skipped", () => {
    // JSON.stringify renders this as the 22-char "1.2345678901234567e+49".
    const big = 1.2345678901234567e49;
    const arr = [big, "x"];
    const result = truncate(arr, 23) as unknown[];
    expect(result).toEqual(["x"]);
  });

  it("keeps array order for elements that fit", () => {
    // Serializes to the 21-char "1.2345678901234567e+39".
    const big = 1.2345678901234567e39;
    const arr = [big, "tail"];
    const result = truncate(arr, 60) as unknown[];
    expect(result).toEqual([big, "tail"]);
  });
});

describe("truncate — whole-value passthrough", () => {
  it("returns an object unchanged when it fits", () => {
    const value = { a: 1, b: [1, 2, 3], c: "text" };
    expect(truncate(value, 1000)).toEqual(value);
  });

  it("returns an array unchanged when it fits", () => {
    const value = [1, "two", { three: 3 }];
    expect(truncate(value, 1000)).toEqual(value);
  });

  it("passes primitives through", () => {
    expect(truncate(42, 0)).toBe(42);
    expect(truncate(null, 0)).toBeNull();
    expect(truncate(true, 0)).toBe(true);
  });

  it("bounds nested structures within the overall budget", () => {
    const value = {
      files: Array.from({ length: 50 }, (_, i) => ({
        path: `/repo/dir-${i}/file-${i}.ts`,
        content: "line\n".repeat(20),
      })),
      summary: "done",
    };
    const result = truncate(value, 500);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(500);
    expect((result as Record<string, unknown>)["summary"]).toBe("done");
  });

  it("never returns an empty object for a non-empty over-budget input", () => {
    const output = { stdout: '"'.repeat(60000), file_path: "/p", exit_code: 0 };
    const result = truncate(output, 32000) as Record<string, unknown>;
    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(result["file_path"]).toBe("/p");
    expect(result["exit_code"]).toBe(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(32000);
  });
});
