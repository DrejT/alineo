import { useState, type ReactNode } from "react";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog";
import { Globe, GitFork, MessageSquare, Pause, Play, Save, SquareTerminal, Trash2 } from "lucide-react";
import { api, type Sandbox } from "../api";
import { IconButton, act } from "../lib";
import { BrowserView } from "./BrowserView";
import { ChatPanel } from "./ChatPanel";

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: ReactNode; confirmLabel: string; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="w-[min(420px,92vw)] p-5">
        <div data-slot="stack">
          <DialogTitle className="h-section">{title}</DialogTitle>
          <DialogDescription className="text-sm text-fd-muted-foreground">{description}</DialogDescription>
        </div>
        <div data-slot="row" className="mt-5">
          <DialogClose>Cancel</DialogClose>
          <DialogClose data-variant="destructive" onClick={onConfirm}>{confirmLabel}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const BTN = "btn-sm inline-flex items-center gap-1.5";

/** Expanded: a text button. Compact (table rows): an icon button whose label shows on hover and focus.
 *  Defined at module scope on purpose: a component defined inside another remounts on every poll. In expanded
 *  mode the label must be an element, because ui-sdk gives a button with a lone <svg> child the square icon style. */
function ActionItem({ compact, label, icon, onClick, disabled, destructive }: {
  compact?: boolean; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean;
}) {
  return compact ? (
    <IconButton label={label} onClick={onClick} disabled={disabled} destructive={destructive}>{icon}</IconButton>
  ) : (
    <Button className={BTN} onClick={onClick} disabled={disabled} data-variant={destructive ? "destructive" : undefined}>{icon}<span>{label}</span></Button>
  );
}

/** Lifecycle buttons for one sandbox. Every action calls the real OpenSandbox container through the API. */
export function SandboxActions({ sb, onTerminal, onChange, compact }: { sb: Sandbox; onTerminal: (id: string) => void; onChange: () => void; compact?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [chat, setChat] = useState(false);
  const [browser, setBrowser] = useState(false);
  const running = sb.status === "running";
  const ic = "size-3.5";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ActionItem compact={compact} label={compact ? "Open terminal" : "Terminal"} icon={<SquareTerminal className={ic} aria-hidden="true" />} onClick={() => onTerminal(sb.id)} disabled={!running} />
      {running
        ? <ActionItem compact={compact} label="Pause" icon={<Pause className={ic} aria-hidden="true" />} onClick={() => void act("Sandbox paused", () => api.pause(sb.id), onChange)} />
        : <ActionItem compact={compact} label="Resume" icon={<Play className={ic} aria-hidden="true" />} onClick={() => void act("Sandbox resumed", () => api.resume(sb.id), onChange)} />}
      <ActionItem compact={compact} label="Checkpoint" icon={<Save className={ic} aria-hidden="true" />} onClick={() => void act("Checkpoint saved", () => api.checkpoint(sb.id), onChange)} disabled={!running} />
      <ActionItem compact={compact} label={compact ? "Fork into a new container" : "Fork"} icon={<GitFork className={ic} aria-hidden="true" />} onClick={() => void act("Forked into a new container", () => api.fork(sb.id), onChange)} disabled={!running} />
      {sb.agent && <ActionItem compact={compact} label={compact ? "Chat with the agent" : "Chat"} icon={<MessageSquare className={ic} aria-hidden="true" />} onClick={() => setChat(true)} disabled={!running} />}
      {sb.agent && sb.browser && <ActionItem compact={compact} label={compact ? "Watch the browser live" : "Browser"} icon={<Globe className={ic} aria-hidden="true" />} onClick={() => setBrowser(true)} disabled={!running} />}
      <ActionItem compact={compact} label="Terminate" icon={<Trash2 className={ic} aria-hidden="true" />} onClick={() => setConfirm(true)} destructive />
      {sb.agent && sb.browser && <BrowserView sandbox={browser ? sb : null} onClose={() => setBrowser(false)} />}
      {sb.agent && <ChatPanel sandbox={chat ? sb : null} onClose={() => setChat(false)} onChange={onChange} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Terminate ${sb.role}?`}
        description={<>This deletes the container <span className="chip-code">{sb.id.slice(0, 8)}</span> and its filesystem. It cannot be undone.</>}
        confirmLabel="Terminate"
        onConfirm={() => void act("Sandbox terminated", () => api.terminate(sb.id), onChange)}
      />
    </div>
  );
}
