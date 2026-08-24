import { redirect } from "next/navigation";
import { coreLatestVersion } from "@/lib/source";

export default function Home() {
  redirect(`/docs/core/${coreLatestVersion}`);
}
