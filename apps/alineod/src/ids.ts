/** Short, human-scannable identifiers for runs and agents. */

function short(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function newRunId(): string {
  return `r_${short()}`;
}

export function newAgentId(): string {
  return `a_${short()}`;
}
