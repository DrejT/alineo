import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ogImageSize = { width: 1200, height: 630 };
export const ogImageContentType = "image/png";

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

export function renderOgImage(title: string, description?: string) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        padding: "80px",
        background: "#000000",
        color: "#ffffff",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", fontSize: 28, color: "#8a8a8a", marginBottom: 24 }}>
        alineo docs
      </div>
      <div style={{ display: "flex", fontSize: 64, fontWeight: 600, lineHeight: 1.1 }}>{title}</div>
      {description && (
        <div
          style={{ display: "flex", fontSize: 28, color: "#a3a3a3", marginTop: 24, maxWidth: 900 }}
        >
          {description}
        </div>
      )}
      <div style={{ display: "flex", fontSize: 24, color: "#6a6a6a", marginTop: "auto" }}>
        docs.alineo.tech
      </div>
    </div>
  );
}
