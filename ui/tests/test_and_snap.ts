import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const artifactDir = "C:\\Users\\sankh\\.gemini\\antigravity\\brain\\b60fb957-d163-40db-99a7-8f3ec1865193";
const BASE_URL = "http://localhost:4600";

async function snap(url: string, file: string, delay = 2500) {
  const outPath = join(artifactDir, file);
  console.log(`[SNAP] Capturing ${file} from ${url}...`);
  const proc = Bun.spawn([
    chrome,
    "--headless=new",
    `--screenshot=${outPath}`,
    "--window-size=1440,900",
    "--hide-scrollbars",
    `--virtual-time-budget=${delay}`,
    url
  ]);
  await proc.exited;
  console.log(`[SNAP] Saved: ${outPath}`);
}

async function run() {
  console.log("[RUN] Authenticating user...");
  const username = `operator_${Date.now().toString(36)}`;
  const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@alineo.ai`,
      password: "SuperSecretPassword123!"
    })
  });

  const authData = await signupRes.json();
  const token = authData.token;
  console.log(`[RUN] Authenticated token: ${token}`);

  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };

  // 1. Spawn root sandbox with model provider
  console.log("[RUN] Spawning root sandbox...");
  const rootSbRes = await fetch(`${BASE_URL}/api/sandboxes`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      role: "distributed-tracer",
      cpuLimitMilli: 250,
      memLimitMi: 256,
      mcpTools: ["GitHub", "Slack"],
      modelProvider: "claude-3-5-sonnet"
    })
  });
  const rootSb = await rootSbRes.json();
  console.log(`[RUN] Root sandbox: ${rootSb.id}`);

  // 2. Checkpoint root sandbox
  await fetch(`${BASE_URL}/api/sandboxes/${rootSb.id}/checkpoint`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ checkpointId: "cp_trace_v1" })
  });

  // 3. Fork child sandbox with different model provider
  console.log("[RUN] Forking child sandbox...");
  const childSbRes = await fetch(`${BASE_URL}/api/sandboxes/${rootSb.id}/fork`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      role: "anomaly-detector",
      modelProvider: "gemini-2.0-flash"
    })
  });
  const childSb = await childSbRes.json();
  console.log(`[RUN] Child sandbox: ${childSb.id}`);

  // 4. Register Vault Credentials
  console.log("[RUN] Adding vault credentials...");
  await fetch(`${BASE_URL}/api/security/vault`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      key: "GITHUB_PERSONAL_ACCESS_TOKEN",
      value: "ghp_super_secret_production_token_xyz999",
      hostScope: "api.github.com",
      injectionMethod: "header"
    })
  });

  await fetch(`${BASE_URL}/api/security/vault`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      key: "OPENAI_API_KEY",
      value: "sk-proj-prod-live-secret-key-12345",
      hostScope: "api.openai.com",
      injectionMethod: "substitution"
    })
  });

  // 5. Add an egress gate
  await fetch(`${BASE_URL}/api/security/egress`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      targetHost: "api.github.com:443",
      protocol: "HTTPS",
      sandboxId: rootSb.id
    })
  });

  console.log("[RUN] Capturing screenshots now...");

  // Snapshot 1: Enhanced Topology with dot matrix, pulse ring status, model provider badge, and CoW fork
  await snap(`${BASE_URL}/?token=${token}&view=overview`, "enhanced_topology_view.png", 3000);

  // Snapshot 2: Browser Screencast View in Attach Drawer
  await snap(`${BASE_URL}/?token=${token}&view=overview&drawer=true&drawerTab=browser`, "browser_screencast_drawer_view.png", 3500);

  // Snapshot 3: Spawn Modal with Model Provider Dropdown
  await snap(`${BASE_URL}/?token=${token}&view=overview&spawnModal=true`, "spawn_modal_model_dropdown_view.png", 3000);

  // Snapshot 4: Security & Perimeter with Vault & Credential Injection Table
  await snap(`${BASE_URL}/?token=${token}&view=security`, "vault_credentials_security_view.png", 3000);

  // Snapshot 5: Add Secret Vault Modal
  await snap(`${BASE_URL}/?token=${token}&view=security&vaultModal=true`, "vault_add_modal_view.png", 3000);

  console.log("[RUN] All captures completed successfully!");
}

run().catch(err => {
  console.error("Execution failed:", err);
  process.exit(1);
});
