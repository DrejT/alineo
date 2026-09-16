import {
  coreSource,
  agentSource,
  workflowSource,
  cliSource,
  alineodSource,
  cookbooksSource,
  playgroundSource,
} from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";

export const dynamic = "force-static";

export async function GET() {
  const allPages = [
    ...coreSource.getPages(),
    ...agentSource.getPages(),
    ...workflowSource.getPages(),
    ...cliSource.getPages(),
    ...alineodSource.getPages(),
    ...cookbooksSource.getPages(),
    ...playgroundSource.getPages(),
  ];
  const scanned = await Promise.all(allPages.map(getLLMText));
  return new Response(scanned.join("\n\n---\n\n"));
}
