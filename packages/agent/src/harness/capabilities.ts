/**
 * What a harness can do. Declared by the adapter, never probed. A method behind a
 * capability the adapter declares `false` is never called: the SDK refuses first.
 *
 * `false` means "does not do it". A harness that cannot say whether it does must declare
 * `false` too. It must never claim `true` to be safe.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export interface HarnessCapabilities {
  /** Inject a message into the turn that is running now. */
  steer: boolean;
  /** Queue a message to run after the current turn. */
  followUp: boolean;
  /** Continue a prior session by its `sessionRef`. */
  resume: boolean;
  /** Start a new session from a point in an old one, by `messageId`. */
  fork: boolean;
  /** Compact the context on request. */
  compact: boolean;
  /** Change the model of a live session. */
  setModel: boolean;
  /** The harness asks before running a tool, through `permission_request`. */
  permissions: boolean;
  /** The harness exposes the model's reasoning as `reasoning` events. */
  reasoning: boolean;
}

export type HarnessCapability = keyof HarnessCapabilities;

/**
 * What Pi declares. Each value is what `PiAdapter` and `pi-bridge.ts` do today:
 * `/steer`, `/follow-up`, `/fork`, `/compact`, `/set-model`, the permission gate, and
 * `thinking_delta` events.
 */
export const PI_CAPABILITIES: HarnessCapabilities = {
  steer: true,
  followUp: true,
  resume: true,
  fork: true,
  compact: true,
  setModel: true,
  permissions: true,
  reasoning: true,
};
