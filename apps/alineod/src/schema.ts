/**
 * alineod's wire contract now lives in `@alineo-labs/schema` — see `src/alineod.ts` there for
 * why. It is its own entry point, `@alineo-labs/schema/alineod`, so the root export stays the
 * vocabulary and the shapes every package shares. This file re-exports it so every route, engine module and script keeps importing from
 * `../schema` unchanged.
 */
export {
  AgentDetail,
  AgentView,
  AlineodEvent,
  ControlScopeBody,
  CreateRunBody,
  CreateRunResponse,
  NotifyOnBody,
  PromptBody,
  QuiescenceView,
  ResultResponse,
  RunAwaitBody,
  RunAwaitResponse,
  SpawnAgentBody,
  SpawnAgentResponse,
  SteerBody,
  StopAgentBody,
  SubtreeOpResult,
  SubtreeSteerResponse,
  TranscriptResponse,
  TreeView,
} from "@alineo-labs/schema/alineod";
