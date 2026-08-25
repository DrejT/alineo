// Canonical render/serialize order for the built-in sections. Loosely follows the
// identity/context -> constraints -> format/examples progression multiple frontier labs'
// own prompting docs converge on (see this package's README, "Provider-neutral by
// design") -- provisional, not yet settled as final.
const BUILTIN_SECTION_ORDER = ["role", "context", "guardrail", "mindset", "format", "examples"];

const SECTION_HEADER = /^##\s+(.+)$/m;

// Legal XML tag name: letters/digits/._- , must not start with a digit or reserved "xml"
// prefix. Deliberately conservative -- this only needs to cover names callers would
// plausibly choose, not the full XML Name production.
const VALID_SECTION_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `render()` output format. `"xml"` (default) matches this package's original behavior. */
export type RenderFormat = "xml" | "markdown";

export interface RenderOptions {
  /** @default "xml" */
  format?: RenderFormat;
}

export interface LoadOptions {
  /** Add to existing content instead of replacing it. @default false */
  merge?: boolean;
}

export interface MergeOptions {
  /** Allow merging into a section on `this` that is locked. @default false */
  overwriteLocked?: boolean;
}

/** Thrown by `.section()` when writing to a section that was `.lock()`ed. */
export class SectionLockedError extends Error {
  constructor(name: string) {
    super(`Section "${name}" is locked and cannot be written to.`);
    this.name = "SectionLockedError";
  }
}

export interface Harness {
  /** General form the built-in sugar methods below are shorthand for. */
  section(name: string, text: string): this;
  role(text: string): this;
  context(text: string): this;
  guardrail(text: string): this;
  mindset(text: string): this;
  format(text: string): this;
  examples(text: string): this;

  /** Prevents further writes to `name` via `.section()` (including via merge). */
  lock(name: string): this;
  /** Whether `name` is currently locked. */
  isLocked(name: string): boolean;

  /** Final composed prompt. `format: "xml"` (default) or `"markdown"` (`## name` headers). */
  render(options?: RenderOptions): string;
  /** console.log-for-a-harness: shows section structure, not the rendered prompt. */
  log(): void;
  /** Writes this harness to a markdown file at `path` -- one `## name` header per section. */
  dumps(path: string): Promise<void>;
  /** Loads `path` into this harness. Replaces existing content unless `options.merge`. */
  load(path: string, options?: LoadOptions): Promise<this>;

  /** Independent deep copy: sections, order, and locks. No I/O. */
  clone(): Harness;
  /** Appends every section from `other` onto `this`, honoring lock checks. */
  merge(other: Harness, options?: MergeOptions): this;

  /**
   * Cheap, provider-agnostic size estimate (chars / 4, the rule of thumb quoted across
   * providers' own docs for English text) over the default XML `render()`. Not a real
   * tokenizer -- for cost/budget visibility, not billing-accurate counts.
   */
  estimateTokens(): number;
}

/**
 * Escapes a close-tag-shaped sequence for `name` so fragment text can't forge one --
 * `</role>` inside a fragment becomes the inert `<\/role>` rather than actually closing the
 * section early. Deliberately a visible ASCII escape (backslash), not an invisible Unicode
 * trick, so it survives copy/paste, diffing, and formatting untouched.
 */
function escapeCloseTag(text: string, name: string): string {
  const pattern = new RegExp(`</(${escapeRegExp(name)})>`, "gi");
  return text.replace(pattern, "<\\/$1>");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class HarnessImpl implements Harness {
  private sections = new Map<string, string[]>();
  private customOrder: string[] = [];
  private locked = new Set<string>();

  section(name: string, text: string): this {
    if (!VALID_SECTION_NAME.test(name)) {
      throw new Error(
        `Invalid section name "${name}": must be a legal XML tag name (letters/digits/._-, ` +
          `not starting with a digit).`,
      );
    }
    if (this.locked.has(name)) throw new SectionLockedError(name);

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

  lock(name: string): this {
    this.locked.add(name);
    return this;
  }

  isLocked(name: string): boolean {
    return this.locked.has(name);
  }

  private orderedSectionNames(): string[] {
    return [
      ...BUILTIN_SECTION_ORDER.filter((name) => this.sections.has(name)),
      ...this.customOrder,
    ];
  }

  render(options?: RenderOptions): string {
    const format = options?.format ?? "xml";
    if (format === "markdown") return this.toMarkdown();

    return this.orderedSectionNames()
      .map((name) => {
        const body = this.sections
          .get(name)!
          .map((fragment) => escapeCloseTag(fragment, name))
          .join("\n\n");
        return `<${name}>\n${body}\n</${name}>`;
      })
      .join("\n\n");
  }

  private toMarkdown(): string {
    return this.orderedSectionNames()
      .map((name) => `## ${name}\n\n${this.sections.get(name)!.join("\n\n")}`)
      .join("\n\n");
  }

  log(): void {
    console.log(this.toMarkdown());
  }

  async dumps(path: string): Promise<void> {
    await Bun.write(path, `${this.toMarkdown()}\n`);
  }

  async load(path: string, options?: LoadOptions): Promise<this> {
    const merge = options?.merge ?? false;
    const content = await Bun.file(path).text();

    if (!merge) {
      this.sections.clear();
      this.customOrder = [];
      this.locked.clear();
    }

    // String#split with a capturing regex interleaves the captures into the result, so
    // splitting on the header pattern (global) yields [preamble, name, body, name, body, ...].
    const parts = content.split(new RegExp(SECTION_HEADER.source, "gm"));
    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i]!.trim();
      const body = (parts[i + 1] ?? "").trim();
      if (body) this.section(name, body);
    }
    return this;
  }

  clone(): Harness {
    const copy = new HarnessImpl();
    for (const [name, fragments] of this.sections) {
      copy.sections.set(name, [...fragments]);
    }
    copy.customOrder = [...this.customOrder];
    copy.locked = new Set(this.locked);
    return copy;
  }

  merge(other: Harness, options?: MergeOptions): this {
    const overwriteLocked = options?.overwriteLocked ?? false;
    if (!(other instanceof HarnessImpl)) {
      throw new Error("merge() requires a Harness created by harness().");
    }
    for (const name of other.orderedSectionNames()) {
      if (this.locked.has(name) && !overwriteLocked) {
        throw new SectionLockedError(name);
      }
      for (const fragment of other.sections.get(name)!) {
        // Bypass this.section()'s own lock check only when overwriteLocked explicitly
        // allows it; otherwise the check above already threw.
        let fragments = this.sections.get(name);
        if (!fragments) {
          fragments = [];
          this.sections.set(name, fragments);
          if (!BUILTIN_SECTION_ORDER.includes(name)) this.customOrder.push(name);
        }
        fragments.push(fragment);
      }
    }
    return this;
  }

  estimateTokens(): number {
    return Math.ceil(this.render().length / 4);
  }
}

export function harness(): Harness {
  return new HarnessImpl();
}
