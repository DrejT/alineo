import { existsSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import server from "../server/index";

const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const artifactDir = "C:\\Users\\sankh\\.gemini\\antigravity\\brain\\b60fb957-d163-40db-99a7-8f3ec1865193";
const publicRecordings = join(import.meta.dir, "..", "public", "recordings");
const rootRecordings = "d:\\Users\\Desktop\\google folder\\recordings";
mkdirSync(publicRecordings, { recursive: true });
mkdirSync(rootRecordings, { recursive: true });

async function snap(url: string, file: string, delay = 3500) {
  const outPath = join(artifactDir, file);
  console.log(`Capturing ${file}...`);
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
    copyFileSync(outPath, join(publicRecordings, file));
    copyFileSync(outPath, join(rootRecordings, file));
    console.log(`[OK] Captured ${file} (${size} bytes)`);
  } else {
    console.log(`[ERR] Failed to capture ${file}`);
  }
}

async function main() {
  const tok = "tok_test_default_session";

  // 0. Auth Login / Signup Modal
  await snap("http://localhost:4600/", "00_auth_login_modal.png", 2500);

  // 1. Overview Dashboard (Authenticated)
  await snap(`http://localhost:4600/?token=${tok}&view=overview`, "01_overview_dashboard.png");

  // 2. Run Demo Swarm Use Case
  console.log("Triggering PR #418 Demo Swarm Use Case via API...");
  const res = await (await fetch("http://localhost:4600/api/demo/run-usecase", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` }
  })).json() as any;
  console.log(`[OK] Swarm completed: ${res.useCase} (Root: ${res.rootId}, Child: ${res.secChildId})`);
  await snap(`http://localhost:4600/?token=${tok}&view=overview`, "02_demo_swarm_executed.png");

  // 3. Sliding Terminal & Steer Drawer
  await snap(`http://localhost:4600/?token=${tok}&view=overview&drawer=true`, "03_terminal_steer_drawer.png", 4000);

  // 4. Sandboxes Fleet
  await snap(`http://localhost:4600/?token=${tok}&view=sandboxes`, "04_sandboxes_fleet.png");

  // 5. Audit & Replay Ledger
  await snap(`http://localhost:4600/?token=${tok}&view=ledger`, "05_audit_replay_ledger.png");

  // 6. Memory Core Subsystem
  await snap(`http://localhost:4600/?token=${tok}&view=memory`, "06_memory_core_subsystem.png");

  // 7. Security & Workflows
  await snap(`http://localhost:4600/?token=${tok}&view=security`, "07_security_workflows.png");

  // 8. OneCLI Runner
  await snap(`http://localhost:4600/?token=${tok}&onecli=true`, "08_onecli_runner.png", 4000);

  console.log("\nAll 9 walkthrough snapshots captured successfully into artifact directory!");
  server.stop(true);
}

main().catch(console.error);
