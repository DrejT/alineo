/**
 * Model API key env vars forwarded into the alineod container by `alineo_init` — mirrors
 * `packages/cli/src/pi-model-keys.ts`. Keep in sync with that copy as Pi adds providers.
 */
export const PI_MODEL_API_KEY_ENV_VARS: readonly string[] = [
  // Anthropic
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  // OpenAI / Azure OpenAI
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  // Google (Gemini, not Vertex)
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
  "AI_GATEWAY_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "RADIUS_API_KEY",
  "OPENCODE_API_KEY",
  // Chinese-market providers
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "MOONSHOT_API_KEY",
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
