export { DEFAULT_PROVIDER_ID, LedgerEvent, SandboxStatus } from "./ledger";
export type {
  LedgerEntry,
  IStorageAdapter,
  SandboxDetails,
  ListSandboxOptions,
  EnvironmentRecord,
  CheckpointInfo,
  EngineLedgerEntry,
  EngineLedgerRow,
  IEngineLedger,
} from "./ledger";

export { LogLevel, ConsoleLogger, noopLogger } from "./logger";
export type { ILogger } from "./logger";

export type {
  CredentialBinding,
  CredentialInjection,
  CredentialBroker,
  CredentialSource,
  CredentialResolver,
  BoundCredential,
} from "./credentials";
export { resolveBoundCredential, reconstructBoundCredentials } from "./credentials";
export { reconstructEgressRules } from "./egress";
export type { ReconstructedEgress } from "./egress";

export {
  SandboxHandle,
  BashSession,
  resolveExecChannel,
  requireCapability,
  composeHooks,
} from "./sandbox/index";
export type {
  ExecOptions,
  ExecCodeOptions,
  SandboxDeps,
  SandboxHooks,
  PendingInteractiveExec,
  ComposeHooksOptions,
} from "./sandbox/index";
export type { FileInfo, DiagnosticLog, DiagnosticEvent, Metrics } from "@alineo-labs/provider";

export { ExecHandle, InteractiveExecHandle } from "./exec-handle";
export type { ExecResult, PtyControls, AttachableSource } from "./exec-handle";

export {
  WorkflowError,
  SandboxError,
  ExecConnectionError,
  CommandError,
  StepTimeoutError,
} from "./errors";
export type { ExecConnectionFailure } from "./errors";
export { AlineoError, errorCodeOf, isRetryable } from "@alineo-labs/errors";
export type { ErrorCode } from "@alineo-labs/errors";
