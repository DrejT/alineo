import defaultMdxComponents from "fumadocs-ui/mdx";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Mermaid } from "@/components/mermaid";

/** MDX components available in every docs collection. */
export const mdxComponents = {
  ...defaultMdxComponents,
  Steps,
  Step,
  Tabs,
  Tab,
  Accordion,
  Accordions,
  Mermaid,
};
