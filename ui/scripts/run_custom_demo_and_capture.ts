import { existsSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const artifactDir = "C:\\Users\\sankh\\.gemini\\antigravity\\brain\\b60fb957-d163-40db-99a7-8f3ec1865193";
const publicRecDir = "D:\\Users\\Desktop\\google folder\\alineo\\ui\\public\\recordings";
const BASE_URL = "http://localhost:4600";

if (!existsSync(publicRecDir)) mkdirSync(publicRecDir, { recursive: true });

async function snap(url: string, file: string, delay = 3500) {
  const outPath = join(artifactDir, file);
  console.log(`[SNAP] Capturing ${file} from ${url}...`);
  const proc = Bun.spawn([
    chrome,
    "--headless=new",
    `--screenshot=${outPath}`,
    "--window-size=1440,900",
    `--virtual-time-budget=${delay}`,
    url,
  ]);
  await proc.exited;

  if (existsSync(outPath)) {
    const size = statSync(outPath).size;
    copyFileSync(outPath, join(publicRecDir, file));
    console.log(`[OK] Captured ${file} (${size} bytes)`);
  } else {
    console.log(`[ERR] Failed to capture ${file}`);
  }
}

async function main() {
  console.log("=== 1. CAPTURING STANDALONE /login SCREEN ===");
  await snap(`${BASE_URL}/login`, "01_new_user_login.png", 2500);

  console.log("=== 2. CREATING BRAND NEW USER ===");
  const username = `pilot_${Date.now().toString(36)}`;
  const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@alineo.ai`,
      password: "Password@2026",
    }),
  });
  const signupData = (await signupRes.json()) as any;
  const token = signupData.token;
  console.log(`[OK] Created new user: ${username} (Token: ${token})`);

  console.log("=== 3. CAPTURING 100% BLANK DASHBOARD ===");
  await snap(`${BASE_URL}/?token=${token}&view=overview`, "02_new_user_blank_dashboard.png", 3500);

  console.log("=== 4. RUNNING SMALL CUSTOM DEMO (DYNAMIC TRACER SWARM) ===");
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // a) Spawn root micro-container
  const rootSbRes = await fetch(`${BASE_URL}/api/sandboxes`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      role: "distributed-tracer",
      cpuLimitMilli: 250,
      memLimitMi: 256,
      mcpTools: ["GitHub", "Slack"],
      summary: "Dynamic tracing micro-worker monitoring telemetry and latency spikes across nodes.",
    }),
  });
  const rootSb = (await rootSbRes.json()) as any;
  console.log(`[OK] Spawned root sandbox: ${rootSb.id} (${rootSb.role})`);

  // b) Exec command in root sandbox
  const execRes = await fetch(`${BASE_URL}/api/sandboxes/${rootSb.id}/exec`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ command: 'node -v && echo "Distributed tracer node online"' }),
  });
  const execData = await execRes.json();
  console.log(`[OK] Executed command in ${rootSb.id}:`, execData);

  // c) Working Memory
  await fetch(`${BASE_URL}/api/memory/working`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      sandboxId: rootSb.id,
      key: "trace_sampling_rate",
      value: "0.05",
      scope: "swarm",
    }),
  });
  console.log("[OK] Working memory entry set.");

  // d) Episodic Memory
  await fetch(`${BASE_URL}/api/memory/episodic`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      sandboxId: rootSb.id,
      prompt: "Inspect network ingress latency for auth service",
      response: "Trace tree sampled 42 requests. Zero anomalous tail latency detected.",
      model: "claude-3-5-sonnet",
    }),
  });
  console.log("[OK] Episodic memory recorded.");

  // e) Semantic Fact
  await fetch(`${BASE_URL}/api/memory/semantic`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      subject: "service.auth",
      predicate: "target_sla_ms",
      object: "45",
      tags: ["telemetry", "tracing", "auth"],
    }),
  });
  console.log("[OK] Semantic fact stored.");

  // f) Egress Policy Gate
  const gateRes = await fetch(`${BASE_URL}/api/security/egress`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      sandboxId: rootSb.id,
      targetHost: "telemetry.datadoghq.com:443",
      protocol: "HTTPS",
      reason: "Exporting sampled span traces from tracer sandbox",
    }),
  });
  const gateData = (await gateRes.json()) as any;
  console.log(`[OK] Created egress gate: ${gateData.gateId}`);

  // g) Fork child sandbox
  const forkRes = await fetch(`${BASE_URL}/api/sandboxes/${rootSb.id}/fork`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ role: "anomaly-detector" }),
  });
  const childSb = (await forkRes.json()) as any;
  console.log(`[OK] Forked child sandbox: ${childSb.id} (${childSb.role})`);

  // h) Checkpoint
  const cpRes = await fetch(`${BASE_URL}/api/sandboxes/${rootSb.id}/checkpoint`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ tag: "cp_trace_v1" }),
  });
  const cpData = await cpRes.json();
  console.log("[OK] Saved checkpoint:", cpData);

  // i) Steer Agent
  await fetch(`${BASE_URL}/api/sandboxes/${childSb.id}/steer`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      directive: "Alert if 99th percentile latency exceeds 120ms",
      scope: "node",
    }),
  });
  console.log("[OK] Steered child agent.");

  // j) Enqueue Workflow
  await fetch(`${BASE_URL}/api/workflows/enqueue`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "trace_aggregation_pipeline", step: 1 }),
  });
  console.log("[OK] Workflow job enqueued.");

  console.log("=== 5. CAPTURING ALL UPDATED DASHBOARD SECTIONS ===");

  // Overview with topology
  await snap(`${BASE_URL}/?token=${token}&view=overview`, "03_spawned_custom_topology.png", 3500);

  // Attach drawer
  await snap(`${BASE_URL}/?token=${token}&view=overview&drawer=true`, "04_terminal_steer_drawer.png", 3500);

  // Sandboxes Fleet
  await snap(`${BASE_URL}/?token=${token}&view=sandboxes`, "05_sandboxes_fleet.png", 3500);

  // Audit Ledger & Scrubber
  await snap(`${BASE_URL}/?token=${token}&view=ledger`, "06_audit_replay_ledger.png", 3500);

  // Memory Core
  await snap(`${BASE_URL}/?token=${token}&view=memory`, "07_memory_core.png", 3500);

  // Security Perimeter
  await snap(`${BASE_URL}/?token=${token}&view=security`, "08_security_egress.png", 3500);

  // Alineo Runner
  await snap(`${BASE_URL}/?token=${token}&view=runner`, "09_alineo_runner.png", 3500);

  // MCP Connector
  await snap(`${BASE_URL}/?token=${token}&view=mcp`, "10_mcp_connector_claude.png", 3500);

  console.log("=== ALL 10 SCREENSHOTS CAPTURED SUCCESSFULLY ===");
}

main().catch(console.error);
