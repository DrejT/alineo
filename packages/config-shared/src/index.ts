export { findProjectConfig, globalConfigPath, readJsonFile, PROJECT_CONFIG_FILE } from "./discover";
export { mergeDeep, deepFreeze } from "./merge";
export { defineEnv, readEnv, readEnvGroup, envTable } from "./env";
export type { EnvVarDef, ReadEnvOptions } from "./env";
export { loadConfig, loadConfigWithSources, CONFIG_CONTENT_ENV } from "./load";
export type { LoadConfigOptions, LoadedConfig, ConfigSources } from "./load";
export {
  ProjectConfigSchema,
  ProjectConfigObjectSchema,
  PROJECT_CONFIG_SCHEMA_URL,
  loadProjectConfig,
  loadProjectConfigWithSources,
  projectConfigFromEnv,
} from "./project";
export type { ProjectConfig, LoadProjectConfigOptions } from "./project";
export { projectConfigJsonSchema } from "./json-schema";
