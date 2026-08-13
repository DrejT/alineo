import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import { lazy } from "react";
import "./globals.css";

const SearchDialog = lazy(() => import("@/components/search-dialog"));

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.drej.dev"),
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
      className={`${geistSans.variable} ${geistMono.variable} light`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <RootProvider theme={{ forcedTheme: "light" }} search={{ SearchDialog }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
