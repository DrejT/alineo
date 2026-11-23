import { DEFAULT_WORDS, inspectPage, type InspectPageOptions } from "./scripts/inspect-page";

export { DEFAULT_WORDS };

/** Options for `b.inspect()`. */
export interface InspectOptions {
  /**
   * Hide page data (default `true`): labels pass only when every word is in `words`, digits
   * become `#`, ids become `<id>`, input values, `data-*` and URL query strings are dropped,
   * and table/grid contents are not read (row counts only).
   *
   * `false` returns labels, values and full URLs as the page has them. Use it only on a public
   * page or your own app. Passwords are never returned either way.
   */
  mask?: boolean;
  /** Extra label words to allow (case-insensitive), added to `DEFAULT_WORDS`. */
  words?: string[];
  /** Replace `DEFAULT_WORDS` instead of extending it. */
  replaceWords?: boolean;
  /** CSS selector to limit the inspection to. */
  scope?: string;
  /** Maximum elements per list. Default 200. */
  limit?: number;
}

/** The JavaScript `b.inspect()` runs in the page. */
export function inspectScript(o: InspectOptions = {}): string {
  const words = [...(o.replaceWords ? [] : DEFAULT_WORDS), ...(o.words ?? [])].map((w) =>
    w.toLowerCase(),
  );
  const opts: InspectPageOptions = {
    mask: o.mask !== false,
    words,
    scope: o.scope,
    limit: o.limit ?? 200,
  };
  return `(${inspectPage.toString()})(${JSON.stringify(opts)})`;
}

/** What `b.inspect()` returns. Fields are absent when masked or not present on the page. */
export interface PageStructure {
  url?: string;
  title?: string;
  masked: boolean;
  counts: { tables: number; rows: number; iframes: number };
  iframes: Array<string | undefined>;
  dialogs: Array<{ role: string; label?: string; buttons: string[] }>;
  inputs: Array<{
    tag: string;
    type?: string;
    role?: string;
    id?: string;
    name?: string;
    required?: boolean;
    label?: string;
    value?: string;
    options?: Array<{ label?: string; value?: string }>;
  }>;
  elements: Array<{
    tag: string;
    role?: string;
    id?: string;
    name?: string;
    testid?: string;
    label?: string;
    href?: string;
    value?: string;
    visible: boolean;
    disabled?: boolean;
  }>;
}

/**
 * Parse `b.inspect()` output: either its stdout, or the value `exec(..., { as, parse: "json" })`
 * stored. Returns `null` for a failed or unrecognized result.
 */
export function parseInspect(value: unknown): PageStructure | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v.trim());
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null || (v as { success?: unknown }).success !== true)
    return null;
  const result = (v as { data?: { result?: unknown } }).data?.result;
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result) as PageStructure;
    return typeof parsed === "object" && parsed !== null && "counts" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** The parts of `SandboxBuilder` that `inspectOnFailure` uses. */
export interface InspectBuilder {
  exec(
    cmd: string,
    opts?: { name?: string; as?: string; parse?: "json"; strict?: boolean },
  ): unknown;
  when(pred: (ctx: { exitCode: number }) => boolean, then: (sb: InspectBuilder) => void): unknown;
}

/**
 * Queue: if the last exec failed (it must have run with `strict: false`), store the page
 * structure in `vars[as]`, masked by default. No screenshot: a screenshot of a page with data
 * holds that data.
 */
export function inspectOnFailure(
  sb: InspectBuilder,
  b: { inspect(o?: InspectOptions): string },
  as = "failedPage",
  o: InspectOptions = {},
): void {
  sb.when(
    (ctx) => ctx.exitCode !== 0,
    (s) => s.exec(b.inspect(o), { name: "browser.inspect", as, parse: "json", strict: false }),
  );
}
