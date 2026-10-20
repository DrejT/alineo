import { describe, expect, it } from "bun:test";
import { installKindOf } from "./install-command";

describe("installKindOf", () => {
  it("recognizes the CLI bootstrap", () => {
    expect(installKindOf("bunx alineo-cli init")).toBe("cli_init");
    expect(installKindOf("# start here\nnpx alineo-cli init --yes\n")).toBe("cli_init");
  });

  it("recognizes SDK package installs", () => {
    expect(installKindOf("npm install @alineo-labs/sandbox @alineo-labs/workflow")).toBe(
      "sdk_install",
    );
    expect(installKindOf("bun add alineo")).toBe("sdk_install");
    expect(installKindOf("pnpm add alineo @alineo-labs/sqlite")).toBe("sdk_install");
  });

  it("ignores later CLI steps and unrelated installs", () => {
    for (const text of [
      "bunx alineo-cli add https://example.com/spec.json",
      "bunx alineo-cli start ./agents/my-agent.json",
      "bunx alineo-cli telemetry disable",
      "npm install react",
      "bun add zod",
      "npx skills add DrejT/alineo --skill alineo",
      "git clone https://github.com/DrejT/alineo",
    ]) {
      expect(installKindOf(text)).toBeNull();
    }
  });

  it("does not match a package that only contains the word", () => {
    expect(installKindOf("bun add alineo-extras")).toBeNull();
    expect(installKindOf("bun add not-alineo")).toBeNull();
  });
});
