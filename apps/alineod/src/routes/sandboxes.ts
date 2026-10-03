/**
 * Raw-sandbox routes: create/list/get/close/checkpoint/fork/credentials/egress over HTTP, plus
 * an interactive terminal and a live-metrics stream over WebSocket (ported from
 * `apps/sandbox/server/ws/{terminal,metrics}.ts` — same approach, different transport host).
 */
import { Elysia } from "elysia";
import {
  CreateSandboxBody,
  CheckpointBody,
  ForkBody,
  SetCredentialBody,
  EgressPatchBody,
  EgressDeleteBody,
  ListSandboxesQuery,
} from "../sandboxes-schema";
import { parseBody } from "./http";
import * as engine from "../engine/sandboxes";
import * as ws from "../engine/sandbox-ws";

export const sandboxesRoutes = new Elysia({ prefix: "/sandboxes" })
  .post("/", async ({ body, set }) => {
    const created = await engine.createSandbox(parseBody(CreateSandboxBody, body));
    set.status = 201;
    return created;
  })

  .get("/", async ({ query }) => {
    const q = ListSandboxesQuery.parse(query);
    const sandboxes = await engine.listSandboxes(q);
    return { sandboxes };
  })

  .get("/:id", async ({ params }) => engine.getSandbox(params.id))

  .get("/:id/events", async ({ params }) => ({ events: await engine.getSandboxLedger(params.id) }))

  .delete("/:id", async ({ params }) => {
    await engine.closeSandbox(params.id);
    return new Response(null, { status: 204 });
  })

  .post("/:id/checkpoint", async ({ params, body, set }) => {
    const { name } = CheckpointBody.parse(body) ?? {};
    const snapshotId = await engine.checkpointSandbox(params.id, name);
    set.status = 201;
    return { snapshotId };
  })

  .get("/:id/checkpoints", async ({ params }) => {
    const checkpoints = await engine.listCheckpoints(params.id);
    return { checkpoints };
  })

  .post("/:id/fork", async ({ params, body, set }) => {
    const { tag } = ForkBody.parse(body) ?? {};
    const child = await engine.forkSandbox(params.id, tag);
    set.status = 201;
    return child;
  })

  .post("/:id/credentials", async ({ params, body, set }) => {
    const { name, value, binding } = parseBody(SetCredentialBody, body);
    await engine.setCredential(params.id, name, value, binding);
    set.status = 204;
  })

  .get("/:id/credentials", async ({ params }) => {
    const bindings = await engine.listCredentials(params.id);
    return { bindings };
  })

  .delete("/:id/credentials/:name", async ({ params }) => {
    await engine.removeCredential(params.id, params.name);
    return new Response(null, { status: 204 });
  })

  .get("/:id/egress", async ({ params }) => engine.getEgress(params.id))

  .patch("/:id/egress", async ({ params, body }) => {
    const { rules } = parseBody(EgressPatchBody, body);
    await engine.patchEgress(params.id, rules);
    return new Response(null, { status: 204 });
  })

  .delete("/:id/egress", async ({ params, body }) => {
    const { targets } = parseBody(EgressDeleteBody, body);
    await engine.deleteEgress(params.id, targets);
    return new Response(null, { status: 204 });
  })

  // ── live terminal + metrics (WebSocket) ──────────────────────────────────

  .ws("/:id/exec", {
    async open(socket) {
      const ok = await ws.openExecSession(socket.id, socket.data.params.id, (chunk) =>
        socket.send(chunk),
      );
      if (!ok) socket.close(1011, "sandbox unavailable");
    },
    message(socket, raw) {
      // Elysia's default WS message parser already JSON.parses incoming text frames (see
      // createWSMessageParser in its ws/index.js) — `raw` arrives as the parsed object, not a
      // string to parse ourselves.
      const msg = raw as
        | { type: "input"; data: string }
        | { type: "resize"; cols: number; rows: number }
        | { type: "signal"; name: string }
        | null
        | undefined;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "input") ws.writeExec(socket.id, msg.data);
      else if (msg.type === "resize") ws.resizeExec(socket.id, msg.cols, msg.rows);
      else if (msg.type === "signal") ws.signalExec(socket.id, msg.name);
    },
    async close(socket) {
      await ws.closeExecSession(socket.id);
    },
  })

  .ws("/:id/metrics", {
    async open(socket) {
      const ok = await ws.openMetricsSession(socket.id, socket.data.params.id, (chunk) =>
        socket.send(chunk),
      );
      if (!ok) socket.close(1011, "sandbox unavailable");
    },
    close(socket) {
      ws.closeMetricsSession(socket.id);
    },
  });
