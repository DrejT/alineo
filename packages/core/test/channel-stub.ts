import type { ExecChannel } from "@alineo-labs/provider";

/**
 * An exec channel whose every method throws, with the ones a test exercises replaced. A method a
 * test did not expect to be called fails by name.
 */
export function stubChannel(methods: Partial<ExecChannel> = {}): ExecChannel {
  const unexpected = (name: string) => () => {
    throw new Error(`stubChannel: unexpected call to ${name}()`);
  };
  const base: ExecChannel = {
    withSignal: unexpected("withSignal"),
    disposeConnections: () => {},
    executeCommand: unexpected("executeCommand"),
    executeCode: unexpected("executeCode"),
    interruptCommand: unexpected("interruptCommand"),
    listContexts: unexpected("listContexts"),
    createContext: unexpected("createContext"),
    createSession: unexpected("createSession"),
    runInSession: unexpected("runInSession"),
    deleteSession: unexpected("deleteSession"),
    getFileInfo: unexpected("getFileInfo"),
    deleteFile: unexpected("deleteFile"),
    moveFile: unexpected("moveFile"),
    searchFiles: unexpected("searchFiles"),
    replaceInFiles: unexpected("replaceInFiles"),
    uploadFile: unexpected("uploadFile"),
    downloadFile: unexpected("downloadFile"),
    listDirectory: unexpected("listDirectory"),
    createDirectory: unexpected("createDirectory"),
    deleteDirectory: unexpected("deleteDirectory"),
    getMetrics: unexpected("getMetrics"),
    watchMetrics: unexpected("watchMetrics"),
  };
  return Object.assign(base, methods);
}
