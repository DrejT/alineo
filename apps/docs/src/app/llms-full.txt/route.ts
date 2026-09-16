import { guideSource, referenceSource, cookbooksSource, playgroundSource } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";

export const dynamic = "force-static";

export async function GET() {
  const allPages = [
    ...guideSource.getPages(),
    ...referenceSource.getPages(),
    ...cookbooksSource.getPages(),
    ...playgroundSource.getPages(),
  ];
  const scanned = await Promise.all(allPages.map(getLLMText));
  return new Response(scanned.join("\n\n---\n\n"));
}
