import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { lazy } from "react";
import "./globals.css";

const SearchDialog = lazy(() => import("@/components/search-dialog"));

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.alineo.tech"),
  title: {
    default: "alineo docs",
    template: "%s — alineo docs",
  },
  description:
    "Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.",
  openGraph: {
    type: "website",
    siteName: "alineo docs",
    title: "alineo docs",
    description:
      "Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.",
    images: [{ url: "/og.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "alineo docs",
    description:
      "Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} dark`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <RootProvider theme={{ forcedTheme: "dark" }} search={{ SearchDialog }}>
          <HomeLayout
            nav={{ title: "alineo", url: "/" }}
            themeSwitch={{ enabled: false }}
            links={[
              { text: "Docs", url: "/docs/core", active: "nested-url" },
              { text: "Use Cases", url: "/use-cases", active: "nested-url" },
              { text: "Changelog", url: "/changelog", active: "nested-url" },
            ]}
          >
            {children}
          </HomeLayout>
        </RootProvider>
      </body>
    </html>
  );
}
