import { describe, expect, it } from "vitest";
import { findTsgoCoreTestShardViolations } from "../../scripts/lib/tsgo-core-test-shards.mts";

describe("tsgo core test shards", () => {
  it("accepts an exact once-only partition within the root budget", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "a", roots: ["src/a.test.ts"] },
          { name: "b", roots: ["src/b.test.ts"] },
        ],
      }),
    ).toEqual([]);
  });

  it("reports missing, duplicate, extra, and oversized shard roots", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts", "src/missing.test.ts"],
        maxRoots: 1,
        shards: [
          { name: "first", roots: ["src/a.test.ts", "src/b.test.ts"] },
          { name: "second", roots: ["src/b.test.ts", "src/extra.test.ts"] },
        ],
      }),
    ).toEqual([
      "first: 2 test roots exceeds the 1 limit",
      "second: 2 test roots exceeds the 1 limit",
      "assigned 2 times (first, second): src/b.test.ts",
      "unassigned: src/missing.test.ts",
      "not in the canonical core-test graph (second): src/extra.test.ts",
    ]);
  });
});
