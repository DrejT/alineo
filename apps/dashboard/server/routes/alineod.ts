/** Runs, agents, the swarm tree and its SSE stream all belong to alineod — forwarded as-is. */
import { Elysia } from "elysia";
import { forward } from "../alineod";

export const alineodRoutes = new Elysia({ name: "alineod-passthrough" })
  .all("/runs", ({ request }) => forward(request), { parse: "none" })
  .all("/runs/*", ({ request }) => forward(request), { parse: "none" })
  .all("/agents/*", ({ request }) => forward(request), { parse: "none" });
