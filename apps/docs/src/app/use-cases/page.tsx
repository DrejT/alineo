import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Use Cases",
  description: "Real-world patterns for building agent sandboxes with alineo.",
};

export default function UseCasesPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Use Cases</h1>
      <p className="text-fd-muted-foreground">
        Coming soon — real-world patterns for building agent sandboxes with alineo.
      </p>
    </div>
  );
}
