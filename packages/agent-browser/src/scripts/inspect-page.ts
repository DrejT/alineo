/**
 * Runs in the page (serialized by `inspect()`), so it must not reference anything outside its
 * own body. Returns the page's structure as JSON. With `mask` (the default), it returns no
 * page data: labels pass only when every word is in the vocabulary, digits become `#`, ids
 * become `<id>`, values and `data-*` attributes are dropped, and table/grid contents are not
 * read (row counts only).
 */
export interface InspectPageOptions {
  mask: boolean;
  /** Words a label may contain, lowercase. A label with any other word is hidden. */
  words: string[];
  /** CSS selector to limit the inspection to. */
  scope?: string;
  /** Maximum elements returned per list. */
  limit: number;
}

export function inspectPage(o: InspectPageOptions): string {
  const mask = o.mask;
  const vocab = new Set(o.words);
  const ID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b[A-Z]{2,}[0-9]{4,}\b/gi;
  const root: ParentNode = (o.scope ? document.querySelector(o.scope) : document) ?? document;
  const clean = (t: string | null | undefined): string =>
    (t ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const maskText = (t: string): string => t.replace(ID_RE, "<id>").replace(/\d/g, "#");
  const label = (raw: string | null | undefined): string | undefined => {
    const t = clean(raw);
    if (!t) return undefined;
    if (!mask) return t;
    if (t.length > 40) return undefined;
    const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
    return words.every((w) => vocab.has(w)) ? maskText(t) : undefined;
  };
  const maskId = (v: string | null): string | undefined =>
    v ? (mask ? v.replace(ID_RE, "<id>").replace(/\d{4,}/g, "<n>") : v) : undefined;
  const maskPath = (p: string): string =>
    p
      .split("/")
      .map((s) => s.replace(ID_RE, "<id>").replace(/\d{3,}/g, "<n>"))
      .join("/");
  const url = (h: string | null): string | undefined => {
    if (!h) return undefined;
    try {
      const u = new URL(h, location.href);
      return mask ? u.host + maskPath(u.pathname) : u.href;
    } catch {
      return undefined;
    }
  };
  const inGrid = (e: Element): boolean =>
    !!e.closest("table,[role=grid],[role=treegrid],[role=rowgroup]");
  const visible = (e: Element): boolean => {
    const r = (e as HTMLElement).getBoundingClientRect?.();
    return !!r && (r.width > 0 || r.height > 0);
  };
  const labelledBy = (e: Element): string | undefined => {
    const ids = e.getAttribute("aria-labelledby");
    if (!ids) return undefined;
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  };
  const pick = <T>(list: T[]): T[] => list.slice(0, o.limit);
  const all = (sel: string): Element[] =>
    Array.from(root.querySelectorAll(sel)).filter((e) => !(mask && inGrid(e)));

  const elements = pick(
    all(
      "a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick]",
    ).map((e) => ({
      tag: e.tagName.toLowerCase(),
      role: e.getAttribute("role") ?? undefined,
      id: maskId(e.id || null),
      name: maskId(e.getAttribute("name")),
      testid: maskId(e.getAttribute("data-testid")),
      label: label(
        (e as HTMLElement).innerText || e.getAttribute("aria-label") || e.getAttribute("title"),
      ),
      href: url(e.getAttribute("href")),
      value: mask ? undefined : (e.getAttribute("data-value") ?? undefined),
      visible: visible(e),
      disabled: (e as HTMLButtonElement).disabled === true || undefined,
    })),
  );

  const inputs = pick(
    all(
      "input:not([type=hidden]),select,textarea,[role=combobox],[role=listbox],[role=checkbox],[role=switch],[role=textbox]",
    ).map((e) => {
      const el = e as HTMLInputElement;
      const own =
        (el.labels && el.labels[0] ? el.labels[0].textContent : null) ??
        labelledBy(e) ??
        e.getAttribute("aria-label") ??
        e.getAttribute("placeholder");
      const isSecret = el.type === "password";
      const hasValue = typeof el.value === "string" && el.value.length > 0;
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute("type") ?? undefined,
        role: e.getAttribute("role") ?? undefined,
        id: maskId(e.id || null),
        name: maskId(e.getAttribute("name")),
        required: el.required === true || undefined,
        label: label(own),
        // A password is never returned, masked or not.
        value: !hasValue ? undefined : mask || isSecret ? "<set>" : el.value,
        options:
          e.tagName === "SELECT"
            ? Array.from((e as HTMLSelectElement).options).map((op) => ({
                label: label(op.textContent),
                value: mask ? undefined : op.value,
              }))
            : undefined,
      };
    }),
  );

  const dialogs = Array.from(root.querySelectorAll("[role=dialog],[role=alertdialog],dialog[open]"))
    .filter(visible)
    .map((d) => ({
      role: d.getAttribute("role") ?? "dialog",
      label: label(
        d.getAttribute("aria-label") ?? d.querySelector("h1,h2,h3,h4,h5,h6")?.textContent,
      ),
      buttons: Array.from(d.querySelectorAll("button,[role=button]"))
        .map((b) => label((b as HTMLElement).innerText || b.getAttribute("aria-label")))
        .filter((x): x is string => !!x),
    }));

  return JSON.stringify({
    url: url(location.href),
    title: label(document.title),
    masked: mask,
    counts: {
      tables: root.querySelectorAll("table,[role=grid]").length,
      rows: root.querySelectorAll("tr,[role=row]").length,
      iframes: root.querySelectorAll("iframe").length,
    },
    iframes: Array.from(root.querySelectorAll("iframe")).map((f) => url(f.getAttribute("src"))),
    dialogs,
    inputs,
    elements,
  });
}

/** Default label vocabulary: generic UI words. Extend it per site with `inspect({ words })`. */
export const DEFAULT_WORDS = (
  "a about account accounts actions add all and apply archive back by cancel catalog catalogue " +
  "change clear close confirm continue create csv dashboard data date day delete details " +
  "dialog done download edit email end error export file files filter filters forgot from go " +
  "help hide history home import in info invoice invoices item items list load log login logout " +
  "manage menu month more my name new next no notifications of off ok on open or order orders " +
  "page password payment payments pdf period place prev previous print profile range refresh " +
  "report reporting reports reset return returns rows save search see select selected send " +
  "settings shipment show sign start status submit summary support tab the to today type " +
  "upload user username view week xlsx year yes your"
).split(" ");
