/**
 * Docs data access. Everything is read from the live site at request time and
 * cached at the edge — no build-time bundling, so the server always reflects
 * what's deployed.
 */

const SITE = "https://docs.alineo.tech";
const INDEX_URL = `${SITE}/search-index.json`;
const CACHE_TTL_SECONDS = 3600;

interface Section {
  heading: string | null;
  content: string;
}

interface DocPage {
  url: string;
  markdownUrl: string;
  title: string;
  description: string;
  headings: string[];
  sections: Section[];
}

interface SearchIndex {
  site: string;
  pages: DocPage[];
}

async function cachedFetch(url: string): Promise<Response> {
  const cache = (globalThis as { caches?: { default: Cache } }).caches?.default;
  const key = new Request(url);

  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  const res = await fetch(url, {
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);

  if (cache && res.ok) {
    const toCache = new Response(res.clone().body, res);
    toCache.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);
    await cache.put(key, toCache);
  }

  return res;
}

async function loadIndex(): Promise<DocPage[]> {
  const res = await cachedFetch(INDEX_URL);
  if (!res.ok) throw new Error(`Failed to load docs index (${res.status})`);
  const data = (await res.json()) as SearchIndex;
  return data.pages;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "how",
  "do",
  "i",
  "can",
  "what",
  "when",
  "my",
  "it",
  "this",
  "that",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function scorePage(page: DocPage, terms: string[]): { score: number; snippet: string } {
  const title = page.title.toLowerCase();
  const description = page.description.toLowerCase();
  const headings = page.headings.join(" ").toLowerCase();
  const body = page.sections
    .map((s) => s.content)
    .join(" ")
    .toLowerCase();

  let score = 0;
  let snippet = page.description;

  for (const term of terms) {
    if (title.includes(term)) score += 10;
    if (description.includes(term)) score += 4;
    if (headings.includes(term)) score += 3;
    const bodyHits = body.split(term).length - 1;
    score += Math.min(bodyHits, 5);

    // First section mentioning a term becomes the snippet.
    if (snippet === page.description) {
      const hit = page.sections.find((s) => s.content.toLowerCase().includes(term));
      if (hit) {
        const idx = hit.content.toLowerCase().indexOf(term);
        const start = Math.max(0, idx - 80);
        snippet =
          (start > 0 ? "…" : "") +
          hit.content.slice(start, start + 240).trim() +
          (hit.content.length > start + 240 ? "…" : "");
      }
    }
  }

  // Small boost when the whole query phrase appears verbatim.
  const phrase = terms.join(" ");
  if (phrase && (title.includes(phrase) || body.includes(phrase))) score += 6;

  return { score, snippet };
}

export async function searchDocs(query: string, limit: number): Promise<string> {
  const pages = await loadIndex();
  const terms = tokenize(query);
  if (terms.length === 0) return "Query had no searchable terms.";

  const ranked = pages
    .map((page) => ({ page, ...scorePage(page, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (ranked.length === 0) {
    return `No matches for "${query}". Try \`list_docs\` to see every page.`;
  }

  return ranked
    .map(
      ({ page, snippet }) =>
        `## ${page.title}\n${page.url}\n\n${page.description}\n\n> ${snippet}\n\n` +
        `Read it: \`get_doc("${page.url}")\``,
    )
    .join("\n\n---\n\n");
}

export async function listDocs(): Promise<string> {
  const pages = await loadIndex();
  const lines = pages
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((p) => `- [${p.title}](${p.url}) — ${p.description}`);
  return `# alineo documentation (${pages.length} pages)\n\n${lines.join("\n")}`;
}

/** Turn any accepted reference into the raw-markdown URL on the docs site. */
function toMarkdownUrl(ref: string): string | null {
  let r = ref.trim();
  if (r.startsWith("http")) {
    try {
      r = new URL(r).pathname;
    } catch {
      return null;
    }
  }
  r = r.replace(/^\/+/, "").replace(/\/+$/, "");

  if (r.startsWith("llms.mdx/")) {
    return `${SITE}/${r.endsWith(".md") ? r : `${r}.md`}`;
  }
  if (r.startsWith("docs/")) r = r.slice("docs/".length);
  if (!r) return null;

  const segments = r.split("/");
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.md$/, "") + ".md";
  return `${SITE}/llms.mdx/${segments.join("/")}`;
}

export async function getDoc(ref: string): Promise<string | null> {
  const mdUrl = toMarkdownUrl(ref);
  if (!mdUrl) return null;
  const res = await cachedFetch(mdUrl);
  if (!res.ok) return null;
  return res.text();
}
