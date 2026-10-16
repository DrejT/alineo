import { FakeHarness } from "../src/harness";
import { defineHarnessContract } from "./harness-contract/contract";

defineHarnessContract({
  name: "fake",
  create: (scenario) => Promise.resolve(new FakeHarness(scenario)),
});
