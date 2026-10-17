/**
 * Stable error codes. Data, not behaviour.
 *
 * A code is a contract: callers, retry policy, telemetry and the wire (HTTP bodies, event
 * payloads) key on it instead of on a class name or on message text. A class name changes with
 * a rename and does not survive minification, and message text is reworded freely. Add a code
 * only when a real failure needs one, and never reuse or repurpose an existing code.
 *
 * `retryable` is a statement about the *same call, unchanged*: true means a later identical
 * attempt may succeed with no change by the caller.
 */

/** What kind of failure a code stands for. Drives grouping in telemetry and the docs. */
export type ErrorCategory =
  /** The substrate was briefly unable. A later attempt may work. */
  | "transient"
  /** The request cannot succeed as asked. Change something before retrying. */
  | "permanent"
  /** Configuration, credentials, or the environment is wrong. */
  | "config"
  /** The substrate does not support what was asked. */
  | "capability"
  /** A bug or a failure with no better classification. */
  | "internal";

export interface ErrorCodeSpec {
  category: ErrorCategory;
  retryable: boolean;
  /** The HTTP status a daemon should answer with for this code. */
  httpStatus: number;
  /** One line, for generated docs and for a reader meeting the code cold. */
  summary: string;
  /** What to do about it. Shown after the message. Optional. */
  hint?: string;
}

export const ERROR_CODES = {
  SANDBOX_NOT_FOUND: {
    category: "permanent",
    retryable: false,
    httpStatus: 404,
    summary: "The sandbox does not exist on the server (deleted, expired, or never created).",
    hint: "Start a new sandbox, or resume from the last checkpoint.",
  },
  SANDBOX_NOT_RUNNING: {
    category: "permanent",
    retryable: false,
    httpStatus: 409,
    summary:
      "The sandbox exists but is not in the Running state (for example Terminated or Failed).",
    hint: "A sandbox that has terminated cannot be reconnected to. Resume from a checkpoint.",
  },
  SANDBOX_PAUSED: {
    category: "permanent",
    retryable: false,
    httpStatus: 409,
    summary: "The sandbox is paused, so the operation cannot run.",
    hint: "Call resume() first.",
  },
  SANDBOX_START_FAILED: {
    category: "permanent",
    retryable: false,
    httpStatus: 502,
    summary: "The sandbox entered Failed or Terminated while starting.",
  },
  SANDBOX_START_TIMEOUT: {
    category: "transient",
    retryable: true,
    httpStatus: 504,
    summary: "The sandbox did not reach Running within the allowed time.",
    hint: "The host may be overloaded or still pulling the image. Retry, or raise the timeout.",
  },
  SESSION_NOT_FOUND: {
    category: "permanent",
    retryable: false,
    httpStatus: 404,
    summary: "No session with that id exists in the ledger.",
  },
  CHECKPOINT_NOT_FOUND: {
    category: "permanent",
    retryable: false,
    httpStatus: 404,
    summary: "The session has no checkpoint to restore from.",
    hint: "Call checkpoint() before relying on resume().",
  },
  SNAPSHOT_FAILED: {
    category: "permanent",
    retryable: false,
    httpStatus: 502,
    summary: "The server reported the snapshot as Failed.",
  },
  SNAPSHOT_TIMEOUT: {
    category: "transient",
    retryable: true,
    httpStatus: 504,
    summary: "The snapshot did not become ready within the allowed time.",
  },
  EXEC_NOT_READY: {
    category: "transient",
    retryable: true,
    httpStatus: 503,
    summary:
      "The sandbox is Running, but the exec daemon (execd) inside it never accepted a connection.",
    hint:
      "Check that the sandbox's execd image tag matches the server's `execd_image`, and read the " +
      "sandbox container logs. Retry once the host is idle.",
  },
  COMMAND_FAILED: {
    category: "permanent",
    retryable: false,
    httpStatus: 422,
    summary: "A command in the sandbox exited with a non-zero code.",
  },
  STEP_TIMEOUT: {
    category: "transient",
    retryable: true,
    httpStatus: 504,
    summary: "A workflow step exceeded its time limit.",
  },
  INVALID_ARGUMENT: {
    category: "permanent",
    retryable: false,
    httpStatus: 400,
    summary: "An argument or option was rejected before any request was sent.",
  },
  SPEC_INVALID: {
    category: "config",
    retryable: false,
    httpStatus: 400,
    summary: "An agent spec failed validation.",
  },
  CAPABILITY_UNSUPPORTED: {
    category: "capability",
    retryable: false,
    httpStatus: 501,
    summary: "The sandbox substrate or its configuration does not support this operation.",
  },
  CREDENTIAL_UNRESOLVED: {
    category: "config",
    retryable: false,
    httpStatus: 422,
    summary: "A credential binding could not be resolved from its source.",
    hint: "Set the environment variable, or pass a resolveCredential callback.",
  },
  PROVIDER_AUTH: {
    category: "config",
    retryable: false,
    httpStatus: 502,
    summary: "The sandbox provider rejected the credentials (401 or 403).",
    hint: "Check the provider API key.",
  },
  PROVIDER_RATE_LIMITED: {
    category: "transient",
    retryable: true,
    httpStatus: 429,
    summary: "The sandbox provider rate-limited the request (429).",
    hint: "Back off and retry.",
  },
  PROVIDER_UNAVAILABLE: {
    category: "transient",
    retryable: true,
    httpStatus: 503,
    summary: "The sandbox provider answered with a server error (5xx).",
  },
  PROVIDER_MISMATCH: {
    category: "config",
    retryable: false,
    httpStatus: 409,
    summary:
      "The session was created on a different sandbox provider than the one this client is configured for.",
    hint: "Point the client at the provider that created the session. Its sandbox id means nothing elsewhere.",
  },
  PROVIDER_ERROR: {
    category: "internal",
    retryable: false,
    httpStatus: 502,
    summary: "The sandbox provider rejected the request with an error that has no better code.",
  },
  MODEL_RATE_LIMITED: {
    category: "transient",
    retryable: true,
    httpStatus: 429,
    summary: "The model provider rate-limited the request (429) and ended the turn.",
    hint: "Back off and retry the turn, or lower how many agents prompt at once.",
  },
  MODEL_UNAVAILABLE: {
    category: "transient",
    retryable: true,
    httpStatus: 503,
    summary: "The model provider was overloaded or unavailable (5xx) and ended the turn.",
    hint: "Retry the turn after a short wait.",
  },
  PROMPT_TIMEOUT: {
    category: "transient",
    retryable: true,
    httpStatus: 504,
    summary: "A prompt produced no activity within the inactivity window.",
    hint: "The agent process may be stuck, or the model is slow. Steer, stop, or retry.",
  },
  BRIDGE_DISCONNECTED: {
    category: "transient",
    retryable: true,
    httpStatus: 502,
    summary: "The agent bridge closed its connection before it signalled the turn was done.",
    hint: "The agent process likely died. Reattach or resume.",
  },
  INTERNAL: {
    category: "internal",
    retryable: false,
    httpStatus: 500,
    summary: "A failure with no more specific code.",
  },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** True when `value` is one of the codes above. A type guard for untrusted input. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}
