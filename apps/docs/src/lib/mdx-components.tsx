import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "@/components/mermaid";

/** MDX components available in every docs collection. */
export const mdxComponents: MDXComponents = {
  ...defaultMdxComponents,
  Steps,
  Step,
  Mermaid,
};
