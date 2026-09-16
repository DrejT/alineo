import { Package, Bot, Workflow, Terminal, Network } from "lucide-react";
import type { LayoutTab } from "fumadocs-ui/layouts/shared";

/**
 * The product switcher. Each entry is one shipped thing; selecting it swaps the
 * sidebar to that product's own docs, which are organised by its concepts
 * (Overview → Quickstart → Concepts → API reference) rather than by the shape of
 * its source tree. Cookbooks and Playground are deliberately not here — they cut
 * across products, and live in the header nav instead.
 */
export const docsTabs: LayoutTab[] = [
  {
    url: "/docs/agent",
    title: "Agent SDK",
    description: "alineo",
    icon: <Bot className="size-4" />,
  },
  {
    url: "/docs/alineod",
    title: "alineod",
    description: "@alineo-labs/alineod",
    icon: <Network className="size-4" />,
  },
  {
    url: "/docs/core",
    title: "Core SDK",
    description: "@alineo-labs/sandbox",
    icon: <Package className="size-4" />,
  },
  {
    url: "/docs/cli",
    title: "alineo CLI",
    description: "alineo-cli",
    icon: <Terminal className="size-4" />,
  },
  {
    url: "/docs/workflow",
    title: "Workflow SDK",
    description: "@alineo-labs/workflow",
    icon: <Workflow className="size-4" />,
  },
];
