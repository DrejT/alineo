import { llms } from "fumadocs-core/source";
import {
  coreSource,
  workflowSource,
  agentSource,
  alineoSource,
  examplesSource,
} from "@/lib/source";
import { DEFAULT_DESCRIPTION } from "@/lib/metadata";

export const dynamic = "force-static";

const SECTIONS = [
  ["Core SDK", coreSource],
  ["Workflow Builder", workflowSource],
  ["Agent SDK", agentSource],
  ["alineo CLI", alineoSource],
  ["Examples", examplesSource],
] as const;

export function GET() {
  const body = SECTIONS.map(([, source]) => llms(source).index()).join("\n\n");
  return new Response(`# alineo docs\n\n> ${DEFAULT_DESCRIPTION}\n\n${body}\n`);
}
