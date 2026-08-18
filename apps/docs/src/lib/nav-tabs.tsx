import { Package, Workflow, Bot, Terminal, FlaskConical } from "lucide-react";
import type { LayoutTab } from "fumadocs-ui/layouts/shared";

export const docsTabs: LayoutTab[] = [
  {
    url: "/docs/core",
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
    url: "/docs/alineo",
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
];
