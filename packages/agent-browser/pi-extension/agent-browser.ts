import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";

/**
 * Gives a Pi agent browser-automation tool calls, wrapping the `agent-browser`
 * CLI (https://github.com/vercel-labs/agent-browser) — accessibility-tree
 * snapshots with stable element refs (@e1, @e2, ...), not coordinates.
 *
 * Every tool here runs `agent-browser` via `pi.exec()` — i.e. as a local child
 * process of wherever this Pi session's own bridge process is already running
 * (that's always inside the sandbox, since that's how every alineo agent works).
 * There is no separate `SandboxHandle` object to inject: the CLI's daemon, its
 * authenticated session/profile state, and this extension's own code all live
 * in that same container already.
 *
 * Install `agent-browser` itself via a spec's `setup` steps:
 *   npm install -g agent-browser
 *   agent-browser install --with-deps
 *
 * See packages/agent-browser/README.md for known v1 limitations — no CAPTCHA
 * handling, no live view during a first/verify run.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_open",
    label: "Open a URL in the sandboxed browser",
    description:
      "Navigates the sandboxed browser to a URL. Call with no url to just launch the browser " +
      "without navigating. Follow up with browser_snapshot to see the resulting page.",
    promptSnippet: "browser_open — navigate the sandboxed browser to a URL",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to navigate to" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["open", ...(params.url ? [params.url] : []), "--json"];
      const res = await pi.exec("agent-browser", args, { cwd: ctx.cwd, signal });
      if (res.code !== 0) throw new Error(res.stderr || `agent-browser open exited ${res.code}`);
      return { content: [{ type: "text", text: res.stdout }], details: { raw: res.stdout } };
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Snapshot the page's accessibility tree",
    description:
      "Returns the current page's accessibility tree as compact text, with a stable ref " +
      "(e.g. @e1) for every interactive element. Refs go stale as soon as the page changes — " +
      "always take a fresh snapshot after any action that might have changed the page before " +
      "using a ref from an older snapshot.",
    promptSnippet: "browser_snapshot — get element refs for the current page",
    parameters: Type.Object({
      interactiveOnly: Type.Optional(
        Type.Boolean({ description: "Only include interactive elements (recommended default)" }),
      ),
      selector: Type.Optional(Type.String({ description: "Scope the snapshot to a CSS selector" })),
      depth: Type.Optional(Type.Number({ description: "Limit tree depth" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = [
        "snapshot",
        ...(params.interactiveOnly ? ["-i"] : []),
        ...(params.selector ? ["-s", params.selector] : []),
        ...(params.depth !== undefined ? ["-d", String(params.depth)] : []),
        "--json",
      ];
      const res = await pi.exec("agent-browser", args, { cwd: ctx.cwd, signal });
      if (res.code !== 0) {
        throw new Error(res.stderr || `agent-browser snapshot exited ${res.code}`);
      }
      return { content: [{ type: "text", text: res.stdout }], details: { raw: res.stdout } };
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Click an element",
    description: "Clicks the element with the given ref (from the most recent browser_snapshot).",
    promptSnippet: "browser_click — click an element by ref",
    parameters: Type.Object({
      ref: Type.String({
        description: "Element ref from the most recent browser_snapshot, e.g. @e3",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const res = await pi.exec("agent-browser", ["click", params.ref, "--json"], {
        cwd: ctx.cwd,
        signal,
      });
      if (res.code !== 0) throw new Error(res.stderr || `agent-browser click exited ${res.code}`);
      return { content: [{ type: "text", text: res.stdout }], details: { raw: res.stdout } };
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Fill a form field",
    description:
      "Clears and types text into the element with the given ref (from the most recent " +
      "browser_snapshot). Requires exactly one of `text` or `envVar`.",
    promptSnippet: "browser_fill — clear and type text into a field by ref",
    parameters: Type.Object({
      ref: Type.String({
        description: "Element ref from the most recent browser_snapshot, e.g. @e3",
      }),
      text: Type.Optional(Type.String({ description: "Literal text to type" })),
      envVar: Type.Optional(
        Type.String({
          description:
            "Name of an env var available in this sandbox to type instead of a literal value -- " +
            "use this for any secret (password, API key, token). Never put a secret's actual " +
            "value in `text`; it becomes part of this tool call's own permanent record.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (Boolean(params.text) === Boolean(params.envVar)) {
        throw new Error("browser_fill requires exactly one of `text` or `envVar`");
      }
      const value = params.envVar ? process.env[params.envVar] : params.text!;
      if (params.envVar && value === undefined) {
        throw new Error(`"${params.envVar}" is not set in this sandbox's environment`);
      }
      const res = await pi.exec("agent-browser", ["fill", params.ref, value!, "--json"], {
        cwd: ctx.cwd,
        signal,
      });
      if (res.code !== 0) throw new Error(res.stderr || `agent-browser fill exited ${res.code}`);
      return { content: [{ type: "text", text: res.stdout }], details: { raw: res.stdout } };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot the page",
    description:
      "Takes a screenshot of the current page and returns it as an image, so you can visually " +
      "inspect layout the accessibility tree doesn't fully capture. Set annotate to true to " +
      "overlay numbered labels matching browser_snapshot's refs.",
    promptSnippet: "browser_screenshot — see the current page, optionally with ref labels overlaid",
    parameters: Type.Object({
      annotate: Type.Optional(
        Type.Boolean({ description: "Overlay numbered labels matching snapshot refs" }),
      ),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const path = `/tmp/agent-browser-shot-${toolCallId}.png`;
      const args = [
        "screenshot",
        path,
        ...(params.annotate ? ["--annotate"] : []),
        ...(params.fullPage ? ["--full"] : []),
      ];
      const res = await pi.exec("agent-browser", args, { cwd: ctx.cwd, signal });
      if (res.code !== 0) {
        throw new Error(res.stderr || `agent-browser screenshot exited ${res.code}`);
      }
      const data = await readFile(path);
      return {
        content: [
          { type: "text", text: res.stdout.trim() || `Screenshot saved to ${path}` },
          { type: "image", data: data.toString("base64"), mimeType: "image/png" },
        ],
        details: { path },
      };
    },
  });
}
