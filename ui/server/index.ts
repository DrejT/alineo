import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { db, seedUserWorkspace } from "./db";
import {
  signup,
  login,
  validateSession,
  logout,
  getUser,
  type User,
} from "./auth";
import {
  listSandboxes,
  getSandbox,
  spawnSandbox,
  pauseSandbox,
  resumeSandbox,
  forkSandbox,
  checkpointSandbox,
  terminateSandbox,
  execInSandbox,
} from "./sandboxes";
import {
  listWorkingMemory,
  setWorkingMemory,
  deleteWorkingMemory,
  listEpisodicMemory,
  addEpisodicMemory,
  recallSemanticFacts,
  addSemanticFact,
  compactMemory,
} from "./memory";
import { listEgressGates, decideEgressGate, createEgressGate } from "./security";
import { getWorkflowState, enqueueWorkflowJob, flushWorkflowPipeline } from "./workflow";
import { steerAgent } from "./steer";
import { promptAgent } from "./agents";
import { publicModels } from "./models";
import { AGENTS_ENABLED } from "./runtime";
import { executeOneCliCommand } from "./cli";

const PORT = Number(process.env.PORT || (process.env.NODE_ENV === "test" ? 4699 : 4600));
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const DIST_DIR = join(import.meta.dir, "..", "dist");

let storageAdapter: 'SQLiteAdapter' | 'PostgresAdapter' = 'SQLiteAdapter';
let daemonOnline = true;
const daemonBootTime = Date.now();

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function getAuthUser(req: Request): User | null {
  const authHeader = req.headers.get("Authorization");
  let token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;

  if (!token) {
    const url = new URL(req.url);
    token = url.searchParams.get("token");
  }

  if (token) {
    const u = validateSession(token);
    if (u) return u;
  }

  return null;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === "OPTIONS") return corsPreflight();

    // -------------------------------------------------------------
    // AUTHENTICATION ROUTES
    // -------------------------------------------------------------
    if (url.pathname === "/api/auth/signup" && method === "POST") {
      try {
        const body = await req.json();
        const res = signup(body);
        return jsonResponse(res, 201);
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 400);
      }
    }

    if (url.pathname === "/api/auth/login" && method === "POST") {
      try {
        const body = await req.json();
        const res = login(body);
        return jsonResponse(res);
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 401);
      }
    }

    if (url.pathname === "/api/auth/logout" && method === "POST") {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
      if (token) logout(token);
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/auth/me" && method === "GET") {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
      const user = token ? validateSession(token) : null;
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
      return jsonResponse({ user });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, version: "1.0.0", daemon: daemonOnline ? "online" : "offline" });
    }

    // -------------------------------------------------------------
    // PROTECTED API ENDPOINTS (RESOLVED PER-USER)
    // -------------------------------------------------------------
    const currentUser = getAuthUser(req);
    if (!currentUser && url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Unauthorized. Please authenticate to access control plane." }, 401);
    }
    const userId = currentUser ? currentUser.id : "usr_test";

    if (url.pathname === "/api/status") {
      const sandboxes = listSandboxes(userId);
      const gates = listEgressGates(userId);
      const pendingGates = gates.filter(g => g.status === 'pending').length;
      const wf = getWorkflowState(userId);

      return jsonResponse({
        user: currentUser,
        daemon: {
          online: daemonOnline,
          port: PORT,
          adapter: storageAdapter,
          bootTime: daemonBootTime,
          uptimeSeconds: Math.floor((Date.now() - daemonBootTime) / 1000),
        },
        fleet: {
          total: sandboxes.length,
          running: sandboxes.filter(s => s.status === 'running').length,
          paused: sandboxes.filter(s => s.status === 'paused').length,
          pendingGates,
          activeWorkflowSlots: wf.activeCount,
          queuedJobs: wf.queuedCount,
        },
      });
    }

    // --- Sandboxes ---
    if (url.pathname === "/api/sandboxes" && method === "GET") {
      return jsonResponse(listSandboxes(userId));
    }

    if (url.pathname === "/api/sandboxes" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const sb = await spawnSandbox(userId, body);
      return jsonResponse(sb, 201);
    }

    const sbMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)$/);
    if (sbMatch && method === "GET") {
      const sb = getSandbox(userId, sbMatch[1]);
      if (!sb) return jsonResponse({ error: "Not found" }, 404);
      return jsonResponse(sb);
    }
    if (sbMatch && method === "DELETE") {
      const ok = await terminateSandbox(userId, sbMatch[1]);
      return jsonResponse({ ok });
    }

    const sbPauseMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/pause$/);
    if (sbPauseMatch && method === "POST") {
      const ok = await pauseSandbox(userId, sbPauseMatch[1]);
      return jsonResponse({ ok });
    }

    const sbResumeMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/resume$/);
    if (sbResumeMatch && method === "POST") {
      const ok = await resumeSandbox(userId, sbResumeMatch[1]);
      return jsonResponse({ ok });
    }

    const sbForkMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/fork$/);
    if (sbForkMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const child = await forkSandbox(userId, sbForkMatch[1], body.role, body.modelProvider);
      return jsonResponse(child, 201);
    }

    const sbCpMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/checkpoint$/);
    if (sbCpMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const cpId = await checkpointSandbox(userId, sbCpMatch[1], body.tag);
      return jsonResponse({ checkpointId: cpId });
    }

    const sbExecMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/exec$/);
    if (sbExecMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.command) return jsonResponse({ error: "Missing command" }, 400);
      const res = await execInSandbox(userId, sbExecMatch[1], body.command);
      return jsonResponse(res);
    }

    const sbSteerMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/steer$/);
    if (sbSteerMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.directive && body.mode !== 'abort') return jsonResponse({ error: "Missing directive" }, 400);
      const mode = ['steer', 'followUp', 'abort'].includes(body.mode) ? body.mode : 'steer';
      const res = await steerAgent(userId, sbSteerMatch[1], body.directive ?? '', body.scope || 'node', mode);
      return jsonResponse(res);
    }

    const sbPromptMatch = url.pathname.match(/^\/api\/sandboxes\/([^\/]+)\/agent\/prompt$/);
    if (sbPromptMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return jsonResponse({ error: "Missing message" }, 400);
      if (message.length > 8000) return jsonResponse({ error: "Message is too long (8000 characters max)" }, 400);
      const frames = promptAgent(userId, sbPromptMatch[1], message);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // A comment line every few seconds keeps proxies from closing a quiet stream.
          const beat = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 5000);
          try {
            for await (const frame of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
          } finally {
            clearInterval(beat);
            controller.close();
          }
        },
        cancel() { void frames.return(undefined); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
    }

    if (url.pathname === "/api/models" && method === "GET") {
      return jsonResponse({ models: publicModels(), agents: AGENTS_ENABLED });
    }

    // --- Ledger ---
    if (url.pathname === "/api/ledger" && method === "GET") {
      const type = url.searchParams.get("type");
      const rows = type && type !== "all"
        ? db.query(`SELECT * FROM ledger WHERE user_id = ? AND type = ? ORDER BY seq ASC`).all(userId, type)
        : db.query(`SELECT * FROM ledger WHERE user_id = ? ORDER BY seq ASC`).all(userId);
      return jsonResponse(rows);
    }

    if (url.pathname === "/api/ledger/replay" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const seq = body.seq || 1;
      const events = db.query(`SELECT * FROM ledger WHERE user_id = ? AND seq >= ? ORDER BY seq ASC LIMIT 20`).all(userId, seq);
      return jsonResponse({ replayedEvents: events });
    }

    // --- Memory ---
    if (url.pathname === "/api/memory/working" && method === "GET") {
      const sbId = url.searchParams.get("sandboxId") || undefined;
      return jsonResponse(listWorkingMemory(userId, sbId));
    }
    if (url.pathname === "/api/memory/working" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      if (!body.sandboxId || !body.key || body.value === undefined) {
        return jsonResponse({ error: "Missing sandboxId, key, or value" }, 400);
      }
      const item = setWorkingMemory(userId, body.sandboxId, body.key, String(body.value), body.scope);
      return jsonResponse(item);
    }
    if (url.pathname.startsWith("/api/memory/working/") && method === "DELETE") {
      const parts = url.pathname.replace("/api/memory/working/", "").split("/");
      const sbId = parts[0];
      const key = parts[1];
      if (sbId && key) {
        deleteWorkingMemory(userId, sbId, key);
        return jsonResponse({ ok: true });
      }
    }

    if (url.pathname === "/api/memory/episodic" && method === "GET") {
      const sbId = url.searchParams.get("sandboxId") || undefined;
      return jsonResponse(listEpisodicMemory(userId, sbId));
    }
    if (url.pathname === "/api/memory/episodic" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const ep = addEpisodicMemory(userId, body);
      return jsonResponse(ep, 201);
    }

    if (url.pathname === "/api/memory/semantic" && method === "GET") {
      const q = url.searchParams.get("query") || undefined;
      const topK = Number(url.searchParams.get("topK") || 5);
      const minConfidence = Number(url.searchParams.get("minConfidence") || 0.4);
      return jsonResponse(recallSemanticFacts(userId, q, topK, minConfidence));
    }
    if (url.pathname === "/api/memory/semantic" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const fact = addSemanticFact(userId, body);
      return jsonResponse(fact, 201);
    }

    if (url.pathname === "/api/memory/compact" && method === "POST") {
      const res = compactMemory(userId);
      return jsonResponse(res);
    }

    // --- Security & Egress ---
    if (url.pathname === "/api/security/egress" && method === "GET") {
      return jsonResponse(listEgressGates(userId));
    }
    if (url.pathname === "/api/security/egress" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const gate = createEgressGate(userId, body);
      return jsonResponse(gate, 201);
    }
    const gateDecideMatch = url.pathname.match(/^\/api\/security\/egress\/([^\/]+)\/decide$/);
    if (gateDecideMatch && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.decision || (body.decision !== "allowed" && body.decision !== "denied")) {
        return jsonResponse({ error: "Invalid decision: must be 'allowed' or 'denied'" }, 400);
      }
      const gate = await decideEgressGate(userId, gateDecideMatch[1], body.decision, currentUser?.username || "operator");
      return jsonResponse(gate);
    }

    // --- Vault & Exec-Time Secret Injection ---
    if (url.pathname === "/api/security/vault" && method === "GET") {
      const rows = db.query(`SELECT id, user_id, name, host, injection_type, header_name, placeholder, target_surfaces, secret_masked, created_at FROM vault_credentials WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as any[];
      return jsonResponse(rows.map(r => ({
        ...r,
        key: r.name,
        hostScope: r.host,
        injectionMethod: r.injection_type,
        maskedValue: r.secret_masked,
        targetSurfaces: JSON.parse(r.target_surfaces || '["header"]')
      })));
    }
    if (url.pathname === "/api/security/vault" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = body.name || body.key;
      const host = body.host || body.hostScope;
      const secret = body.secret || body.value;
      if (!name || !host || !secret) {
        return jsonResponse({ error: "Missing name, host, or secret" }, 400);
      }
      const id = "vc_" + Math.random().toString(36).substring(2, 8);
      const secretStr = String(secret);
      const masked = secretStr.length > 8 ? secretStr.substring(0, 4) + "••••••••" + secretStr.substring(secretStr.length - 2) : "••••••••";
      const now = Date.now();
      db.prepare(`
        INSERT INTO vault_credentials (id, user_id, name, host, injection_type, header_name, placeholder, target_surfaces, secret_masked, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        userId,
        name,
        host,
        body.injectionType || body.injectionMethod || 'header',
        body.headerName || 'Authorization',
        body.placeholder || '__TOKEN__',
        JSON.stringify(body.targetSurfaces || ['header']),
        masked,
        now
      );
      return jsonResponse({ id, name, host, secretMasked: masked, key: name, hostScope: host, maskedValue: masked }, 201);
    }
    const vaultDelMatch = url.pathname.match(/^\/api\/security\/vault\/([^\/]+)$/);
    if (vaultDelMatch && method === "DELETE") {
      db.prepare(`DELETE FROM vault_credentials WHERE user_id = ? AND id = ?`).run(userId, vaultDelMatch[1]);
      return jsonResponse({ ok: true });
    }

    // --- Workflows ---
    if (url.pathname === "/api/workflows" && method === "GET") {
      return jsonResponse(getWorkflowState(userId));
    }
    if (url.pathname === "/api/workflows/enqueue" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const job = enqueueWorkflowJob(userId, body.name, body.step);
      return jsonResponse(job, 201);
    }
    if (url.pathname === "/api/workflows/flush" && method === "POST") {
      const res = flushWorkflowPipeline(userId);
      return jsonResponse(res);
    }

    // --- OneCLI Runner ---
    if (url.pathname === "/api/cli/run" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.command) return jsonResponse({ error: "Missing command" }, 400);
      const res = await executeOneCliCommand(userId, body.command);
      return jsonResponse(res);
    }

    // --- Daemon Power & Adapter ---
    if (url.pathname === "/api/daemon/power" && method === "POST") {
      daemonOnline = !daemonOnline;
      return jsonResponse({ online: daemonOnline });
    }
    if (url.pathname === "/api/daemon/adapter" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.adapter === 'SQLiteAdapter' || body.adapter === 'PostgresAdapter') {
        storageAdapter = body.adapter;
      }
      return jsonResponse({ adapter: storageAdapter });
    }

    // --- End-to-End Use Case Runner ---
    if (url.pathname === "/api/demo/run-usecase" && method === "POST") {
      const sandboxes = listSandboxes(userId);
      let root = sandboxes.find(s => s.role === 'code-reviewer-root');
      if (!root) {
        root = await spawnSandbox(userId, {
          role: 'code-reviewer-root',
          cpuLimitMilli: 500,
          memLimitMi: 512,
          mcpTools: ['GitHub', 'Slack'],
          agent: false,
          summary: 'Orchestrating PR #418 review across forked security and performance sub-agents.',
        });
      }

      const execDiff = await execInSandbox(userId, root.id, 'git diff origin/main...HEAD --stat');
      const secChild = await forkSandbox(userId, root.id, 'reviewer-security');

      setWorkingMemory(userId, root.id, 'pr_target', '418', 'swarm');
      setWorkingMemory(userId, secChild.id, 'jwt_algorithm', 'RS256', 'local');
      addSemanticFact(userId, {
        subject: 'pr.418.review',
        predicate: 'status',
        object: 'approved_with_advisory_check',
        tags: ['review', 'security', 'auth'],
      });

      const cpId = await checkpointSandbox(userId, root.id, 'cp_0142');

      const gate = createEgressGate(userId, {
        sandboxId: secChild.id,
        targetHost: 'api.osv.dev:443',
        protocol: 'HTTPS',
        reason: 'Automated vulnerability advisory check for PR #418',
      });
      await pauseSandbox(userId, secChild.id);

      await steerAgent(userId, root.id, 'Verify RS256 token signing and enforce 900s expiry', 'subtree');

      return jsonResponse({
        success: true,
        useCase: 'PR #418 Automated Code Review & Security Benchmark Swarm',
        userId,
        rootId: root.id,
        secChildId: secChild.id,
        checkpointId: cpId,
        gateId: gate.gateId,
        execDiffOutput: execDiff.stdout,
      });
    }

    // -------------------------------------------------------------
    // STATIC ASSETS SERVING
    // -------------------------------------------------------------
    // New React dashboard (ui/web, built to ui/dist). The old static UI in ui/public stays as a fallback
    // when no build exists, and keeps serving its own assets (login.html, recordings.html, screenshots).
    const distIndex = join(DIST_DIR, "index.html");
    if (existsSync(distIndex)) {
      const rel = url.pathname === "/" || url.pathname === "/login" ? "/index.html" : url.pathname;
      const candidate = join(DIST_DIR, rel);
      if (candidate.startsWith(DIST_DIR + "/") && existsSync(candidate) && statSync(candidate).isFile()) {
        return new Response(Bun.file(candidate));
      }
      const legacy = join(PUBLIC_DIR, url.pathname);
      if (url.pathname !== "/" && legacy.startsWith(PUBLIC_DIR + "/") && existsSync(legacy) && statSync(legacy).isFile()) {
        return new Response(Bun.file(legacy));
      }
      return new Response(Bun.file(distIndex));
    }

    if (url.pathname === "/login") {
      const loginFile = Bun.file(join(PUBLIC_DIR, "login.html"));
      return new Response(loginFile);
    }

    let filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    if (!existsSync(filePath)) {
      filePath = join(PUBLIC_DIR, "index.html");
    }

    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[alineo-control-plane] listening on http://localhost:${PORT}`);
export default server;
