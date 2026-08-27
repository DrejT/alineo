// Canonical render/serialize order for the built-in sections. Loosely follows the
// identity/context -> constraints -> format/examples progression multiple frontier labs'
// own prompting docs converge on (see this package's README, "Provider-neutral by
// design") -- provisional, not yet settled as final.
const BUILTIN_SECTION_ORDER = ["role", "context", "guardrail", "mindset", "format", "examples"];

const SECTION_HEADER = /^##\s+(.+)$/m;

export interface Harness {
  /** General form the built-in sugar methods below are shorthand for. */
  section(name: string, text: string): this;
  role(text: string): this;
  context(text: string): this;
  guardrail(text: string): this;
  mindset(text: string): this;
  format(text: string): this;
  examples(text: string): this;

  /** Final composed prompt: each non-empty section wrapped in a matching XML tag. */
  render(): string;
  /** console.log-for-a-harness: shows section structure, not the rendered prompt. */
  log(): void;
  /** Writes this harness to a markdown file at `path` -- one `## name` header per section. */
  dumps(path: string): Promise<void>;
  /** Replaces this harness's content entirely with what's parsed from `path`. */
  load(path: string): Promise<this>;
}

class HarnessImpl implements Harness {
  private sections = new Map<string, string[]>();
  private customOrder: string[] = [];

  section(name: string, text: string): this {
    let fragments = this.sections.get(name);
    if (!fragments) {
      fragments = [];
      this.sections.set(name, fragments);
      if (!BUILTIN_SECTION_ORDER.includes(name)) this.customOrder.push(name);
    }
    fragments.push(text);
    return this;
  }

  role(text: string): this {
    return this.section("role", text);
  }
  context(text: string): this {
    return this.section("context", text);
  }
  guardrail(text: string): this {
    return this.section("guardrail", text);
  }
  mindset(text: string): this {
    return this.section("mindset", text);
  }
  format(text: string): this {
    return this.section("format", text);
  }
  examples(text: string): this {
    return this.section("examples", text);
  }

  private orderedSectionNames(): string[] {
    return [
      ...BUILTIN_SECTION_ORDER.filter((name) => this.sections.has(name)),
      ...this.customOrder,
    ];
  }

  render(): string {
    return this.orderedSectionNames()
      .map((name) => `<${name}>\n${(this.sections.get(name) ?? []).join("\n\n")}\n</${name}>`)
      .join("\n\n");
  }

  private toMarkdown(): string {
    return this.orderedSectionNames()
      .map((name) => `## ${name}\n\n${(this.sections.get(name) ?? []).join("\n\n")}`)
      .join("\n\n");
  }

  log(): void {
    console.log(this.toMarkdown());
  }

  async dumps(path: string): Promise<void> {
    await Bun.write(path, `${this.toMarkdown()}\n`);
  }

  async load(path: string): Promise<this> {
    const content = await Bun.file(path).text();
    this.sections.clear();
    this.customOrder = [];

    // String#split with a capturing regex interleaves the captures into the result, so
    // splitting on the header pattern (global) yields [preamble, name, body, name, body, ...].
    const parts = content.split(new RegExp(SECTION_HEADER.source, "gm"));
    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i].trim();
      const body = (parts[i + 1] ?? "").trim();
      if (body) this.section(name, body);
    }
    return this;
  }
}

export function harness(): Harness {
  return new HarnessImpl();
}
