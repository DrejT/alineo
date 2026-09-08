interface LLMPage {
  url: string;
  data: {
    title: string;
    description?: string;
    getText: (type: "processed") => Promise<string>;
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * `remarkMdxMermaid` rewrites ```mermaid fences to `<Mermaid chart="…" />` for the
 * rendered docs — but the Markdown/LLM output wants the fence back (agents and
 * GitHub render mermaid natively).
 */
function restoreMermaidFences(markdown: string): string {
  return markdown.replace(
    /<Mermaid\s+chart="([\s\S]*?)"\s*\/>/g,
    (_, chart: string) => `\`\`\`mermaid\n${decodeEntities(chart).trim()}\n\`\`\``,
  );
}

export async function getLLMText(page: LLMPage) {
  const content = restoreMermaidFences(await page.data.getText("processed"));
  return `# ${page.data.title}\nURL: ${page.url}\n\n${page.data.description ?? ""}\n\n${content}`;
}
