import { z } from "zod";
import { ProjectConfigObjectSchema, PROJECT_CONFIG_SCHEMA_URL } from "./project";

/**
 * Emit the project config's JSON Schema.
 *
 * This package is never published, so nobody outside the repo can import `ProjectConfig` to
 * type their file. A published JSON Schema plus a `$schema` key in `alineo.config.json` gives
 * them autocomplete and validation in any editor with nothing installed — the same
 * generate-from-Zod approach the component registry already uses.
 */
export function projectConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProjectConfigObjectSchema, { io: "input" }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PROJECT_CONFIG_SCHEMA_URL,
    title: "alineo project config",
    description: "Settings for alineo.config.json. Credentials are never stored here.",
    ...schema,
    properties: {
      ...((schema.properties as Record<string, unknown>) ?? {}),
      $schema: { type: "string", description: "URL of this schema, for editor support." },
    },
  };
}
