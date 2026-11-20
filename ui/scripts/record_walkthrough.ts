import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT_DIR = "C:\\Users\\sankh\\.gemini\\antigravity\\brain\\b60fb957-d163-40db-99a7-8f3ec1865193";
mkdirSync(ARTIFACT_DIR, { recursive: true });

async function getWsUrl() {
  const res = await fetch("http://127.0.0.1:9222/json/new?http://localhost:4600", { method: "PUT" });
  const data = await res.json() as any;
  return data.webSocketDebuggerUrl;
}

class CdpClient {
  ws: WebSocket;
  id = 1;
  pending = new Map<number, (res: any) => void>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.onopen = () => resolve();
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      };
    });
  }

  send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve) => {
      const curId = this.id++;
      this.pending.set(curId, resolve);
      this.ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async eval(expr: string): Promise<any> {
    const res = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  }

  async screenshot(filename: string): Promise<string> {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    const outPath = join(ARTIFACT_DIR, filename);
    writeFileSync(outPath, buffer);
    console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
    return outPath;
  }
}

async function run() {
  const wsUrl = await getWsUrl();
  console.log("Connected to CDP tab:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Wait for page load
  await new Promise((r) => setTimeout(r, 2000));
  console.log("Capturing 01_overview_dashboard.png...");
  await client.screenshot("01_overview_dashboard.png");

  // 2. Click "Run Demo Swarm Use Case"
  console.log("Triggering PR #418 Demo Swarm Use Case...");
  await client.eval("window.runDemoUseCase()");
  await new Promise((r) => setTimeout(r, 2500));
  console.log("Capturing 02_demo_swarm_executed.png...");
  await client.screenshot("02_demo_swarm_executed.png");

  // 3. Open Slide-Out Terminal & Steer Drawer
  console.log("Opening Terminal & Steer Drawer...");
  await client.eval("openAttachDrawer('sbx_8F4K2M')");
  await client.eval(`
    document.getElementById('drawer-cmd-input').value = 'bun test';
    document.getElementById('drawer-cmd-form').dispatchEvent(new Event('submit'));
  `);
  await new Promise((r) => setTimeout(r, 1500));
  console.log("Capturing 03_terminal_steer_drawer.png...");
  await client.screenshot("03_terminal_steer_drawer.png");
  await client.eval("closeAttachDrawer()");

  // 4. Approve Egress Gate
  console.log("Approving outbound egress gate_91...");
  await client.eval("if (window.decideGate) decideGate('gate_91', 'allowed')");
  await new Promise((r) => setTimeout(r, 1000));

  // 5. Sandboxes Fleet View
  console.log("Switching to Sandboxes Fleet view...");
  await client.eval("switchSection('sandboxes')");
  await new Promise((r) => setTimeout(r, 1000));
  console.log("Capturing 04_sandboxes_fleet.png...");
  await client.screenshot("04_sandboxes_fleet.png");

  // 6. Audit & Replay View
  console.log("Switching to Audit & Replay view...");
  await client.eval("switchSection('ledger')");
  await client.eval("replayFromSelectedTimelineNode()");
  await new Promise((r) => setTimeout(r, 1500));
  console.log("Capturing 05_audit_replay_ledger.png...");
  await client.screenshot("05_audit_replay_ledger.png");

  // 7. Memory Core Subsystem View
  console.log("Switching to Memory Core view...");
  await client.eval("switchSection('memory')");
  await client.eval(`
    const qInput = document.getElementById('semantic-query-input');
    if (qInput) {
      qInput.value = 'jwt';
      qInput.dispatchEvent(new Event('input'));
    }
  `);
  await new Promise((r) => setTimeout(r, 1500));
  console.log("Capturing 06_memory_core_subsystem.png...");
  await client.screenshot("06_memory_core_subsystem.png");

  // 8. Security & Workflows View
  console.log("Switching to Security & Workflows view...");
  await client.eval("switchSection('security')");
  await new Promise((r) => setTimeout(r, 1000));
  console.log("Capturing 07_security_workflows.png...");
  await client.screenshot("07_security_workflows.png");

  // 9. OneCLI Runner Palette
  console.log("Opening OneCLI modal & running 'alineo status'...");
  await client.eval(`
    const m = document.getElementById('onecli-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    const chip = document.querySelector('.onecli-chip');
    if (chip) chip.click();
  `);
  await new Promise((r) => setTimeout(r, 1500));
  console.log("Capturing 08_onecli_runner.png...");
  await client.screenshot("08_onecli_runner.png");

  console.log("Walkthrough recording complete! All 8 screenshots captured successfully.");
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
