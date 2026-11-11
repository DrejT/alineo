/** Short, human-scannable identifiers for runs and agents. */

function short(length: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

// Run ids are 16 hex characters (64 bits), so a script cannot guess one. Ids made before this had
// 8, and every route still accepts them. An id is not a credential: tenant checks are what keep
// runs apart. The length only makes guessing hopeless.
export function newRunId(): string {
  return `r_${short(16)}`;
}

export function newAgentId(): string {
  return `a_${short(8)}`;
}
