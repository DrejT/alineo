import {
  coreSource,
  workflowSource,
  agentSource,
  alineoSource,
  examplesSource,
} from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";

export const dynamic = "force-static";

export async function GET() {
  const allPages = [
    ...coreSource.getPages(),
    ...workflowSource.getPages(),
    ...agentSource.getPages(),
    ...alineoSource.getPages(),
    ...examplesSource.getPages(),
  ];
  const scanned = await Promise.all(allPages.map(getLLMText));
  return new Response(scanned.join("\n\n---\n\n"));
}
