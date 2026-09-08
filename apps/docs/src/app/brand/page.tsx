import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand",
  description: "The alineo logo, colors, and typography — and how to use them.",
  alternates: { canonical: "https://docs.alineo.tech/brand" },
};

const BURGUNDY = "#7a1b48";

const NEUTRALS: { name: string; hex: string; note: string }[] = [
  { name: "Foreground", hex: "#111111", note: "Body text" },
  { name: "Muted foreground", hex: "#71717a", note: "Secondary text" },
  { name: "Border", hex: "#e4e4e7", note: "Hairlines, dividers" },
  { name: "Card", hex: "#fafafa", note: "Raised surfaces" },
  { name: "Background", hex: "#ffffff", note: "Page" },
];

function Swatch({ hex, name, note }: { hex: string; name: string; note: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-fd-border p-3">
      <div
        className="size-10 shrink-0 rounded-md border border-fd-border"
        style={{ background: hex }}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-fd-foreground">{name}</div>
        <div className="text-xs text-fd-muted-foreground">
          <code>{hex}</code> · {note}
        </div>
      </div>
    </div>
  );
}

export default function BrandPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-12 px-6 py-24">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Brand</h1>
        <p className="text-fd-muted-foreground">
          The alineo logo, colors, and typography. Use these when writing about or linking to alineo
          — a talk, a blog post, an integration listing.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fd-foreground">Logo</h2>
        <div className="flex flex-wrap items-center gap-6 rounded-xl border border-fd-border bg-fd-card p-8">
          <span className="flex items-center gap-2.5 text-2xl font-semibold tracking-[-0.02em] text-fd-foreground">
            <span className="size-5 rounded-[5px]" style={{ background: BURGUNDY }} />
            alineo
          </span>
        </div>
        <p className="text-sm text-fd-muted-foreground">
          The wordmark is set in Inter Semibold, all lowercase, paired with the burgundy mark.
          Don&apos;t recolor the wordmark, add effects, or set it on a busy background. Raw assets:{" "}
          <a href="/logo.svg">logo.svg</a>,{" "}
          <a href="/web-app-manifest-512x512.png">icon (512×512 PNG)</a>.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fd-foreground">Color</h2>
        <div className="flex flex-col gap-2">
          <div
            className="flex items-end gap-3 rounded-xl p-6 text-white"
            style={{ background: BURGUNDY }}
          >
            <span className="text-lg font-semibold">Burgundy</span>
            <code className="text-sm opacity-90">{BURGUNDY}</code>
          </div>
          <p className="text-sm text-fd-muted-foreground">
            The single brand color — the docs sidebar, links, and accents. Everything else is
            neutral.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {NEUTRALS.map((c) => (
            <Swatch key={c.hex} {...c} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fd-foreground">Typography</h2>
        <div className="flex flex-col gap-3 rounded-xl border border-fd-border p-6">
          <div>
            <div className="text-2xl font-semibold text-fd-foreground">Inter</div>
            <div className="text-sm text-fd-muted-foreground">
              Headings and body. Weights 400 and 600.
            </div>
          </div>
          <div>
            <div className="font-mono text-xl text-fd-foreground">Geist Mono</div>
            <div className="text-sm text-fd-muted-foreground">
              Code, identifiers, terminal output.
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fd-foreground">Principles</h2>
        <ul className="flex flex-col gap-2 text-sm text-fd-muted-foreground">
          <li>Light mode only. No dark-on-brand treatments outside the sidebar.</li>
          <li>No gradients, glows, or generic &ldquo;AI product&rdquo; visual shortcuts.</li>
          <li>Restraint over spectacle — clarity is the point.</li>
        </ul>
      </section>
    </div>
  );
}
