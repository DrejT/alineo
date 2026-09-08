import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Mermaid } from "@/components/mermaid";

/** MDX components available in every docs collection. */
export const mdxComponents = {
  ...defaultMdxComponents,
  Steps,
  Step,
  Mermaid,
};
