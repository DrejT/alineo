import type { FakeScenario, HarnessAdapter, HarnessCapabilities } from "../../src/harness";

/**
 * What the suite needs from a harness. One small file per harness builds one of these.
 * Everything the suite asserts goes through `HarnessAdapter`, so a new harness is held to
 * the same cases as Pi.
 */
export interface HarnessBinding {
  /** Shown in test names. */
  name: string;
  /**
   * An adapter that is started and ready, and whose next turn plays `scenario`. For a
   * scripted harness (`fake`, a stub bridge) the scenario is exact. For a live harness the
   * binding maps it to a prompt that provokes the same behavior.
   */
  create(scenario: FakeScenario): Promise<HarnessAdapter>;
  /**
   * Cases to skip, with the reason. A skip with no reason is not allowed: the list is the
   * place a known gap shows up.
   */
  skip?: Partial<Record<CaseId, string>>;
  /** The capabilities the adapter is expected to declare. A mismatch fails a case. */
  expectedCapabilities?: Partial<HarnessCapabilities>;
}

export type CaseId =
  | "text-turn"
  | "tool-events-pair"
  | "abort-ends-turn"
  | "failure-is-events"
  | "steer-between-turns"
  | "capabilities-match-methods"
  | "false-capability-refused"
  | "permission-deny-blocks"
  | "permission-allow-runs";
