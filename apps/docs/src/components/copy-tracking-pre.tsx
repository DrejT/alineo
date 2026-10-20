"use client";

import type { ComponentProps } from "react";
import defaultMdxComponents from "fumadocs-ui/mdx";
import posthog from "posthog-js";
import { installKindOf } from "@/lib/install-command";

const DefaultPre = defaultMdxComponents.pre as (props: ComponentProps<"pre">) => React.ReactNode;

/** fumadocs labels its copy button "Copy Text" (and "Copied Text" after a click). */
const COPY_BUTTON = 'button[aria-label="Copy Text"]';

/**
 * The docs' code block with one addition: copying an install command sends
 * `docs_install_command_copied` to PostHog, so copies can be set against new `init` runs in the
 * CLI data. The event carries the kind of command and the page, never the text.
 *
 * `contents` keeps the wrapper out of layout, so the code block renders exactly as before.
 */
export function CopyTrackingPre(props: ComponentProps<"pre">) {
  return (
    <div
      className="contents"
      onClickCapture={(event) => {
        try {
          const button = (event.target as HTMLElement).closest(COPY_BUTTON);
          if (!button) return;
          const text = button.closest("figure")?.querySelector("pre")?.textContent ?? "";
          const kind = installKindOf(text);
          if (!kind || !posthog.__loaded) return;
          posthog.capture("docs_install_command_copied", {
            install_kind: kind,
            page: window.location.pathname,
          });
        } catch {
          // Analytics must never break copying.
        }
      }}
    >
      <DefaultPre {...props} />
    </div>
  );
}
