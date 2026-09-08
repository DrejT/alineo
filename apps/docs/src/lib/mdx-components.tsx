import type { ComponentProps } from "react";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Mermaid } from "@/components/mermaid";

/**
 * Plain <img> — the default fumadocs `img` wraps next/image, which needs an optimizer this
 * static export doesn't have. `src` is a plain path string (source.config.ts
 * `remarkImageOptions.useImport: false`); `h-auto` keeps aspect ratio if width/height are set.
 */
function Img({ className, ...props }: ComponentProps<"img">) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      loading="lazy"
      className={`my-6 h-auto max-w-full rounded-lg border border-fd-border ${className ?? ""}`}
    />
  );
}

/** MDX components available in every docs collection. */
export const mdxComponents = {
  ...defaultMdxComponents,
  img: Img,
  Steps,
  Step,
  Tabs,
  Tab,
  Accordion,
  Accordions,
  Mermaid,
};
