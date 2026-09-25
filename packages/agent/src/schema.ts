/**
 * Validation for `AgentSpec` — the behaviour half.
 *
 * The shapes themselves (`AgentSpec`, `AgentSpecSchema`, `SetupStep`, `CredentialEnvBinding`)
 * live in `@alineo-labs/schema` and are re-exported here, so every existing import keeps
 * working. What stays is what actually does something: validation, and the error it throws.
 */
import * as z from "zod";
import { AgentSpecSchema } from "@alineo-labs/schema";
import { AgentSpecValidationError } from "./errors";

export type { AgentSpec, CredentialEnvBinding, SetupStep } from "@alineo-labs/schema";
export { AgentSpecSchema } from "@alineo-labs/schema";
import type { AgentSpec } from "@alineo-labs/schema";

/**
 * The old spec field names, and what each became. There is no alias — an old spec is
 * rejected — but "must have a 'harness' field" is an unhelpful thing to read while looking
 * at a spec that plainly has a `cli` field. Name the rename instead.
 */
const RENAMED_FIELDS = [
  ["cli", "harness"],
  ["cliVersion", "harnessVersion"],
] as const;

function renamedFieldHint(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const stale = RENAMED_FIELDS.filter(([from, to]) => from in data && !(to in data));
  if (stale.length === 0) return "";
  const list = (pick: 0 | 1) => stale.map((pair) => `'${pair[pick]}'`).join(" and ");
  return (
    `\n\nThis spec uses ${list(0)}, renamed to ${list(1)}: the field names the ` +
    `agent-loop driver, which is not always a CLI.`
  );
}

/**
 * Validate an unknown value as an `AgentSpec`, aggregating every problem found in one pass.
 * Throws `AgentSpecValidationError` (with a pre-formatted `.message` and a structured
 * `.issues` array) rather than a bare `Error` — see #185.
 */
export function validateAgentSpec(data: unknown): AgentSpec {
  const result = AgentSpecSchema.safeParse(data);
  if (!result.success) {
    throw new AgentSpecValidationError(
      `Invalid agent spec:\n${z.prettifyError(result.error)}${renamedFieldHint(data)}`,
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  return result.data;
}
