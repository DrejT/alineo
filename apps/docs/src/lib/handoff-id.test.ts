import { describe, expect, test } from "bun:test";
import { readHandoffId, stripHandoffParam } from "./handoff-id";

const ID = "0190f3a2-7c1e-7b52-9a4d-3f8e1c2b5d60";

describe("readHandoffId", () => {
  test("returns a valid UUID", () => {
    expect(readHandoffId(`?ph_id=${ID}`)).toBe(ID);
  });

  test("returns undefined when the parameter is missing", () => {
    expect(readHandoffId("")).toBeUndefined();
    expect(readHandoffId("?other=1")).toBeUndefined();
  });

  test("rejects values that are not a UUID", () => {
    expect(readHandoffId("?ph_id=abc")).toBeUndefined();
    expect(readHandoffId(`?ph_id=${ID}x`)).toBeUndefined();
    expect(readHandoffId("?ph_id=<script>")).toBeUndefined();
  });
});

describe("stripHandoffParam", () => {
  test("removes only ph_id", () => {
    expect(stripHandoffParam("/docs", `?ph_id=${ID}&q=1`, "#top")).toBe("/docs?q=1#top");
  });

  test("leaves no trailing question mark", () => {
    expect(stripHandoffParam("/docs/agent", `?ph_id=${ID}`, "")).toBe("/docs/agent");
  });
});
