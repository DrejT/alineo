---
---

Internal only, no publishable package changes: bump `@ai-sdk/groq` and `@ai-sdk/google` to
their v4 majors, in lockstep with the core `ai` package (6→7) and `@ai-sdk/openai` (3→4) so all
providers in `packages/model-providers` stay on the same V4 provider spec.

Bumping just `@ai-sdk/groq`/`@ai-sdk/google` alone (dependabot #177/#176) breaks: those packages'
factory functions then return `LanguageModelV4`, which doesn't satisfy the `LanguageModel` type
exported by `ai@6` (`string | LanguageModelV3 | LanguageModelV2`) — a real `tsc --noEmit --strict`
failure in `src/groq.ts`/`src/google.ts` that CI's hardcoded per-package typecheck list doesn't
currently catch, since `packages/model-providers` isn't in it. `@ai-sdk/openai` (used by the
NVIDIA NIM provider via the generic `createOpenAI` wrapper) has to move too, for the same reason.
Verified with `tsc --noEmit --strict` and the package's own test suite across all four provider
files after the bump; supersedes #177 and #176.
