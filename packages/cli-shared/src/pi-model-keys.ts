/**
 * Model API key env vars Pi's coding-agent runtime resolves providers from — mirrors the
 * `envMap` in earendil-works/pi's `packages/ai/src/env-api-keys.ts` (plus Anthropic's three,
 * handled separately there). An `AgentSpec`'s env map (`{ NVIDIA_API_KEY: "${NVIDIA_API_KEY}" }`,
 * see `packages/agent/src/schema.ts`) is resolved from `process.env` inside whatever process
 * calls `Alineo.start()`/`.spawn()` — for a swarm run through alineod, that's alineod's own
 * container. `alineo init` forwards whichever of these are set in the operator's shell into
 * that container so any Pi-supported model works, not just NVIDIA's free tier.
 *
 * Deliberately excludes ambient/file-based credential mechanisms (AWS IAM role chains,
 * `AWS_PROFILE`, Google Application Default Credentials) — those need a mounted file or
 * assumed-role wiring, not just a passed-through env var. Amazon Bedrock and Google Vertex
 * are not yet supported by `init`'s auto-start for that reason.
 *
 * Keep in sync with pi's `env-api-keys.ts` `envMap` as it adds providers.
 */
export const PI_MODEL_API_KEY_ENV_VARS: readonly string[] = [
  // Anthropic
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  // OpenAI / Azure OpenAI
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  // Google (Gemini, not Vertex — see file doc comment)
  "GEMINI_API_KEY",
  // NVIDIA NIM, DeepSeek, Mistral, Groq, Cerebras, xAI
  "NVIDIA_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  // Aggregators / gateways
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY", // Vercel AI Gateway
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID", // paired with CLOUDFLARE_API_KEY for Cloudflare's providers
  "CLOUDFLARE_GATEWAY_ID",
  "RADIUS_API_KEY",
  "OPENCODE_API_KEY",
  // Chinese-market providers
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "MOONSHOT_API_KEY", // moonshotai + moonshotai-cn
  "KIMI_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ANT_LING_API_KEY",
  // Hosting/inference platforms
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  // GitHub Copilot
  "COPILOT_GITHUB_TOKEN",
];
