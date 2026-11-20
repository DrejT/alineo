import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Card, PageHeader, toast } from "../lib";

const SNIPPET = `{
  "mcpServers": {
    "alineo-control-plane": {
      "command": "bunx",
      "args": ["alineo-cli", "mcp", "--port", "4600"]
    }
  }
}`;

export function Mcp() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(SNIPPET); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { toast.error("Could not copy. Select the text and copy it by hand."); }
  }
  return (
    <>
      <PageHeader title="MCP connector" sub="Connect an MCP client such as Claude Desktop, Claude Code or Cursor to this control plane." />
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3"><h2 className="h-section">Client configuration</h2><Button onClick={() => void copy()}>{copied ? "Copied" : "Copy JSON"}</Button></div>
        <p className="mt-1 text-sm text-fd-muted-foreground">Add this to your client's MCP config file, then restart the client.</p>
        <pre className="mt-3 overflow-auto rounded-lg bg-fd-muted p-3 font-mono text-xs leading-5">{SNIPPET}</pre>
      </Card>
      <p className="text-xs text-fd-muted-foreground">This snippet and the <span className="chip-code">alineo-cli mcp</span> command come from the previous dashboard. They have not been verified against the current CLI.</p>
    </>
  );
}
