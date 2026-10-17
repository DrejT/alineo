import type { SandboxProvider } from "@alineo-labs/provider";

/**
 * A provider whose every method throws, with the methods a test exercises replaced.
 *
 * A method a test did not expect to be called fails loudly, naming itself, instead of returning
 * `undefined` and failing three calls later.
 */
export function stubProvider<T extends Partial<SandboxProvider>>(methods: T): SandboxProvider & T {
  const unexpected = (name: string) => () => {
    throw new Error(`stubProvider: unexpected call to ${name}()`);
  };
  const base: SandboxProvider = {
    id: "opensandbox",
    descriptor: {
      id: "opensandbox",
      label: "OpenSandbox",
      capabilities: {
        snapshot: { kind: "filesystem" },
        pause: true,
        egress: false,
        credentials: false,
        pty: true,
        code: true,
      },
    },
    createSandbox: unexpected("createSandbox"),
    getSandbox: unexpected("getSandbox"),
    listSandboxes: unexpected("listSandboxes"),
    deleteSandbox: unexpected("deleteSandbox"),
    pauseSandbox: unexpected("pauseSandbox"),
    resumeSandbox: unexpected("resumeSandbox"),
    createSnapshot: unexpected("createSnapshot"),
    getSnapshot: unexpected("getSnapshot"),
    getEndpoint: unexpected("getEndpoint"),
    getDiagnosticLogs: unexpected("getDiagnosticLogs"),
    getDiagnosticEvents: unexpected("getDiagnosticEvents"),
    connectExec: unexpected("connectExec"),
  };
  return Object.assign(base, methods);
}
