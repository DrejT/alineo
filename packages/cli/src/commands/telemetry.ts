import { envDisabled, readTelemetryConfig, writeTelemetryConfig } from "../telemetry.js";
import type { CliCommand } from "./types.js";

export async function telemetry(argv: string[]): Promise<void> {
  const sub = argv[0];
  const config = await readTelemetryConfig();

  if (sub === "enable") {
    await writeTelemetryConfig({ ...config, enabled: true });
    console.log("[alineo] telemetry enabled");
    return;
  }
  if (sub === "disable") {
    await writeTelemetryConfig({ ...config, enabled: false });
    console.log("[alineo] telemetry disabled");
    return;
  }
  if (sub === "status" || !sub) {
    if (envDisabled()) {
      console.log(
        "[alineo] telemetry: disabled (ALINEO_TELEMETRY_DISABLED or DO_NOT_TRACK is set)",
      );
    } else {
      console.log(`[alineo] telemetry: ${config.enabled ? "enabled" : "disabled"}`);
    }
    console.log(`  anonymous id: ${config.anonymousId}`);
    return;
  }
  throw new Error("Usage: alineo telemetry status|enable|disable");
}

export const telemetryCommand: CliCommand = {
  name: "telemetry",
  group: "sdk",
  variants: [
    { usage: "alineo telemetry status", summary: "Show whether telemetry is enabled" },
    { usage: "alineo telemetry enable", summary: "Enable anonymous usage telemetry" },
    { usage: "alineo telemetry disable", summary: "Disable anonymous usage telemetry" },
  ],
  run: async (argv) => {
    await telemetry(argv);
  },
};
