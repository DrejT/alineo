/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { stripUpdatedDependencies, takeUntilRenameBoundary } from "./changelog";

describe("takeUntilRenameBoundary", () => {
  test("stops at a version-reset discontinuity", () => {
    const sections = [
      { version: "0.1.1" },
      { version: "0.1.0" },
      { version: "0.7.2" },
      { version: "0.7.1" },
    ];
    expect(takeUntilRenameBoundary(sections)).toEqual([{ version: "0.1.1" }, { version: "0.1.0" }]);
  });

  test("keeps a normally-decreasing sequence in full", () => {
    const sections = [{ version: "0.2.0" }, { version: "0.1.1" }, { version: "0.1.0" }];
    expect(takeUntilRenameBoundary(sections)).toEqual(sections);
  });

  test("a single section is always kept", () => {
    expect(takeUntilRenameBoundary([{ version: "0.1.0" }])).toEqual([{ version: "0.1.0" }]);
  });
});

describe("stripUpdatedDependencies", () => {
  test("drops an 'Updated dependencies' bullet and its nested package list", () => {
    const body = [
      "### Patch Changes",
      "",
      "- abc1234: Fix a real bug users hit.",
      "- Updated dependencies [def5678]",
      "  - @alineo-labs/core@1.0.0",
      "  - @alineo-labs/opensandbox@1.0.0",
    ].join("\n");

    expect(stripUpdatedDependencies(body)).toBe(
      ["### Patch Changes", "", "- abc1234: Fix a real bug users hit."].join("\n"),
    );
  });

  test("drops a heading whose only content was 'Updated dependencies' noise", () => {
    const body = [
      "### Patch Changes",
      "",
      "- Updated dependencies [def5678]",
      "  - @alineo-labs/core@1.0.0",
    ].join("\n");

    expect(stripUpdatedDependencies(body)).toBe("");
  });

  test("leaves a section with no 'Updated dependencies' bullets untouched", () => {
    const body = ["### Minor Changes", "", "- abc1234: Add a new feature."].join("\n");
    expect(stripUpdatedDependencies(body)).toBe(body);
  });
});
