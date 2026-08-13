import type { APIRoute } from "astro";
import { getAgentItems } from "../../lib/agents";

export const prerender = true;

/** Machine-readable catalog for tools (e.g. alineo's TUI) — the search page on `/` is the human view. */
export const GET: APIRoute = ({ site }) => {
  const items = getAgentItems().map(({ name, title, description, categories, path }) => ({
    name,
    title,
    description,
    categories,
    url: new URL(path, site).toString(),
  }));

  return new Response(JSON.stringify(items, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
