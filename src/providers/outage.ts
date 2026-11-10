import { classifyFailure } from "./failure";

// When the model provider cannot serve, every run fails, whoever it belongs
// to. The gate holds whoever starts sessions while that lasts: a first failure
// pauses for the first wait, each failed try after the pause lapses backs off
// one step, and a call that succeeds closes the outage. The project hears
// about the opening and the closing, and decides what to notify and what to
// resume.

export type OutageGateOptions = {
  /** Waits per failed try, in ms. Default 1, 5, 15, then 30 minutes. */
  backoffMs?: number[];
  now?: () => number;
  /** An outage that was open when the process started: picked up and tried again after the first wait. */
  openSince?: number | null;
  /** The outage opened: the reason, and how long until the next try. */
  onOpen?: (info: { reason: string; status: number | undefined; retryInMs: number; since: number }) => void;
  /** A failed try inside an open outage: it backs off. */
  onBackoff?: (info: { reason: string; retryInMs: number }) => void;
  /** A model call succeeded: the outage closed, with when it opened. */
  onClose?: (info: { since: number }) => void;
};

export type OutageGate = {
  /** A run ended on the provider's failure: pause, and open the outage if new. */
  down(err: unknown): void;
  /** A model call succeeded: close the outage, if one is open. */
  up(): void;
  /** How long to hold off before starting anything; 0 means go. */
  pausedForMs(): number;
  /** Someone says the provider should be back: try now instead of waiting out the pause. */
  retryNow(): void;
  isOpen(): boolean;
  /** When the open outage started, or null. */
  since(): number | null;
};

const DEFAULT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

export function createOutageGate(opts: OutageGateOptions = {}): OutageGate {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const now = opts.now ?? Date.now;
  let level = -1; // index into backoff; -1 = no outage
  let pausedUntil = 0;
  let since: number | null = null;

  if (opts.openSince != null) {
    level = 0;
    since = opts.openSince;
    pausedUntil = now() + backoff[0]!;
  }

  return {
    down(err) {
      const t = now();
      const failure = classifyFailure(err);
      const opening = level < 0;
      // One step of backoff per try: runs already in flight when the pause began
      // fail inside it, and those are the same try, not more of them.
      const advanced = t >= pausedUntil;
      if (advanced) {
        level = Math.min(level + 1, backoff.length - 1);
        pausedUntil = t + backoff[level]!;
      }
      const retryInMs = pausedUntil - t;
      if (opening) {
        since = t;
        opts.onOpen?.({ reason: failure.message, status: failure.status, retryInMs, since: t });
      } else if (advanced) {
        opts.onBackoff?.({ reason: failure.message, retryInMs });
      }
    },

    up() {
      if (level < 0) return;
      const opened = since!;
      level = -1;
      pausedUntil = 0;
      since = null;
      opts.onClose?.({ since: opened });
    },

    pausedForMs: () => Math.max(0, pausedUntil - now()),
    retryNow() {
      if (level >= 0) pausedUntil = 0;
    },
    isOpen: () => level >= 0,
    since: () => since,
  };
}
