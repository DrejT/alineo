/**
 * The logger now lives in `@alineo-labs/logger`. These names are re-exported so existing
 * `import { ConsoleLogger, noopLogger, LogLevel, type ILogger } from "@alineo-labs/core"` keeps
 * working for one release — new code should use `getLogger()` from `@alineo-labs/logger`
 * (silent by default, child loggers, `ALINEO_LOG_LEVEL`).
 */
export { ConsoleLogger, LogLevel, noopLogger } from "@alineo-labs/logger";
export type { ILogger } from "@alineo-labs/logger";
