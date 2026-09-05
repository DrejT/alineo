import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { lazy } from "react";
import { DEFAULT_DESCRIPTION } from "@/lib/metadata";
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
  description: DEFAULT_DESCRIPTION,
  keywords: [
    "sandbox",
    "OpenSandbox",
    "AI agent sandbox",
    "TypeScript SDK",
    "code execution",
    "checkpoint and resume",
    "audit ledger",
    "workflow orchestration",
  ],
  openGraph: {
    type: "website",
    siteName: "alineo docs",
    title: "alineo docs",
    description: DEFAULT_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "alineo docs",
    description: DEFAULT_DESCRIPTION,
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "alineo docs",
  url: "https://docs.alineo.tech",
  description: DEFAULT_DESCRIPTION,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <RootProvider search={{ SearchDialog }}>
          <HomeLayout
            nav={{ title: "alineo", url: "/" }}
            themeSwitch={{ enabled: false }}
            links={[
              { text: "Docs", url: "/docs/core", active: "nested-url" },
              { text: "Examples", url: "/docs/examples", active: "nested-url" },
              { text: "Cookbook", url: "/cookbook", active: "nested-url" },
              { text: "FAQ", url: "/faq", active: "nested-url" },
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
