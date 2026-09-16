import { BookOpen, ChefHat, Play, Braces } from "lucide-react";
import type { LayoutTab } from "fumadocs-ui/layouts/shared";

/**
 * Tabs are reading modes, not packages. The old switcher listed one tab per npm
 * package (Core SDK / Workflow Builder / Agent SDK / alineo CLI / alineod), which
 * asked the reader to pick a package before anything had told them what the product
 * does. Narrative lives in Guide; the exhaustive API surface is quarantined in
 * Reference so it never sits in the path of someone learning.
 */
export const docsTabs: LayoutTab[] = [
  {
    url: "/docs/guide",
    title: "Guide",
    description: "Agents, swarms, sandboxes",
    icon: <BookOpen className="size-4" />,
  },
  {
    url: "/docs/cookbooks",
    title: "Cookbooks",
    description: "Runnable recipes",
    icon: <ChefHat className="size-4" />,
  },
  {
    url: "/docs/playground",
    title: "Playground",
    description: "Run it in the browser",
    icon: <Play className="size-4" />,
  },
  {
    url: "/docs/reference",
    title: "Reference",
    description: "Every API, route and flag",
    icon: <Braces className="size-4" />,
  },
];
