"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

const packages = [
  { value: "core", label: "Core SDK", sub: "alineo" },
  { value: "workflow", label: "Workflow Builder", sub: "@alineo-labs/workflow" },
  { value: "agent", label: "Agent SDK", sub: "@alineo-labs/agent" },
  { value: "alineo", label: "alineo CLI", sub: "alineo-cli" },
] as const;

type PackageValue = (typeof packages)[number]["value"];

export function PackageSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current: PackageValue = pathname.startsWith("/docs/workflow")
    ? "workflow"
    : pathname.startsWith("/docs/agent")
      ? "agent"
      : pathname.startsWith("/docs/alineo")
        ? "alineo"
        : "core";
  const selected = packages.find((p) => p.value === current)!;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative pb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-fd-border bg-fd-secondary/50 px-2.5 py-2 text-sm text-fd-secondary-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
        aria-expanded={open}
      >
        <div className="flex flex-1 flex-col items-start text-start leading-snug">
          <span className="font-medium">{selected.label}</span>
          <span className="text-xs text-fd-muted-foreground">{selected.sub}</span>
        </div>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fd-muted-foreground" />
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 flex flex-col gap-0.5 rounded-lg border border-fd-border bg-fd-popover p-1 shadow-md">
          {packages.map((pkg) => {
            const isActive = pkg.value === current;
            return (
              <button
                key={pkg.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (!isActive) router.push(`/docs/${pkg.value}`);
                }}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
              >
                <div className="flex flex-1 flex-col items-start text-start leading-snug">
                  <span className="font-medium">{pkg.label}</span>
                  <span className="text-xs text-fd-muted-foreground">{pkg.sub}</span>
                </div>
                <Check
                  className="size-3.5 shrink-0 text-fd-primary"
                  style={{ visibility: isActive ? "visible" : "hidden" }}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
