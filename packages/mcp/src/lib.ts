/**
 * The library face of alineo-mcp, for a program that serves this MCP to other people. The package's
 * main entry (`index.ts`) is the executable and starts a server the moment it is imported, so
 * code that wants to build one itself imports from `alineo-mcp/server` instead.
 */
export { buildServer, type BuildServerOptions } from "./server.js";
export {
  createHttpMcp,
  serveHttp,
  type HttpMcp,
  type HttpMcpOptions,
  type ServeHttpOptions,
} from "./http.js";
export {
  addRemoteSpec,
  MemorySpecStore,
  type AddRemoteSpecInput,
  type AddRemoteSpecResult,
  type SpecStore,
  type SpecSummary,
} from "./spec-store.js";
export {
  fetchPublicJson,
  isPublicAddress,
  PublicFetchError,
  type PublicFetchOptions,
} from "./public-fetch.js";
export { AlineodClient, AlineodError, type AlineodClientOptions } from "./alineod-client.js";
