import { Package, Workflow, Bot, Terminal, FlaskConical, ChefHat } from "lucide-react";
import type { LayoutTab } from "fumadocs-ui/layouts/shared";
import { coreLatestVersion, alineoLatestVersion } from "@/lib/source";

export const docsTabs: LayoutTab[] = [
  {
    // Points at the latest version directly rather than the unversioned /docs/core
    // alias, to avoid an extra redirect hop on every product switch while already
    // browsing docs. coreLatestVersion is the single place a version cut updates.
    url: `/docs/core/${coreLatestVersion}`,
    title: "Core SDK",
    description: "alineo",
    icon: <Package className="size-4" />,
  },
  {
    url: "/docs/workflow",
    title: "Workflow Builder",
    description: "@alineo-labs/workflow",
    icon: <Workflow className="size-4" />,
  },
  {
    url: "/docs/agent",
    title: "Agent SDK",
    description: "@alineo-labs/agent",
    icon: <Bot className="size-4" />,
  },
  {
    url: `/docs/alineo/${alineoLatestVersion}`,
    title: "alineo CLI",
    description: "alineo-cli",
    icon: <Terminal className="size-4" />,
  },
  {
    url: "/docs/examples",
    title: "Examples",
    description: "Runnable examples",
    icon: <FlaskConical className="size-4" />,
  },
  {
    url: "/docs/cookbooks",
    title: "Cookbooks",
    description: "Task-oriented recipes",
    icon: <ChefHat className="size-4" />,
  },
];
