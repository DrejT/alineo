import { ControlClient } from "@alineo-labs/opensandbox";

/** A real (never-connected) `ControlClient` with the methods a test exercises replaced by mocks. */
export function stubControl<T extends Partial<ControlClient>>(methods: T): ControlClient & T {
  return Object.assign(
    new ControlClient({ baseUrl: "http://control.invalid", apiKey: "" }),
    methods,
  );
}
