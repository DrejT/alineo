import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ogImageSize = { width: 1200, height: 630 };
export const ogImageContentType = "image/png";

// Docs light palette (src/app/globals.css)
const BRAND = "#7a1b48";
const BG = "#ffffff";
const FG = "#111111";
const MUTED = "#52525b";
const FAINT = "#a1a1aa";
const BORDER = "#e4e4e7";

export async function loadOgFonts() {
  const [regular, semibold] = await Promise.all([
    readFile(join(process.cwd(), "assets/Inter-Regular.woff")),
    readFile(join(process.cwd(), "assets/Inter-SemiBold.woff")),
  ]);

  return [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: semibold, weight: 600 as const, style: "normal" as const },
  ];
}

export function renderOgImage(title: string, description?: string, eyebrow = "alineo docs") {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: BG,
        fontFamily: "Inter",
      }}
    >
      {/* Burgundy edge band — echoes the docs sidebar */}
      <div style={{ display: "flex", width: 14, height: "100%", background: BRAND }} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "72px 80px",
          borderTop: `1px solid ${BORDER}`,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{ display: "flex", width: 20, height: 20, borderRadius: 5, background: BRAND }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: BRAND,
            }}
          >
            {eyebrow}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 66,
            fontWeight: 600,
            lineHeight: 1.1,
            color: FG,
            marginTop: 36,
            letterSpacing: "-0.02em",
          }}
        >
          {title}
        </div>

        {description && (
          <div
            style={{
              display: "flex",
              fontSize: 28,
              lineHeight: 1.4,
              color: MUTED,
              marginTop: 24,
              maxWidth: 920,
            }}
          >
            {description}
          </div>
        )}

        <div style={{ display: "flex", fontSize: 22, color: FAINT, marginTop: "auto" }}>
          docs.alineo.tech
        </div>
      </div>
    </div>
  );
}
