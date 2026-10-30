/**
 * A bounded wait for the live-check round trip, used by the check
 * page's live panel.
 *
 * The failure this exists for (filmed 2026-10-30, see
 * CAPTURE_RECORD_2026-10-30.md): the panel awaited its run POST
 * with no bound at all, so a response lost between the platform
 * and the browser left the panel on "Running..." forever, with
 * the reading charged and no way offered to collect it. A fetch
 * that never settles never reaches a catch block; the only fix
 * is to stop waiting.
 *
 * When the wait gives up, nothing about the run is lost: the
 * server keeps the run under the run identity the client sent,
 * and the panel's collect action resumes that same run by id.
 * Timing out is a change of waiting room, never a restart.
 */

/**
 * How long the panel waits for one live-check round trip before
 * handing over to the collect path. The server's own budgets set
 * the scale: one request can poll the reading for up to 120s and
 * a BUY preview for up to 120s more (lib/config.ts), so the bound
 * sits at the sum. A slower answer is not an error; it is
 * collected, not chased.
 */
export const LIVE_RUN_WAIT_MS = 240_000;

export type BoundedResult<T> =
  | { kind: "done"; value: T }
  | { kind: "timeout" }
  | { kind: "unreachable"; error: unknown };

/**
 * Run `operation` with an AbortSignal that fires after
 * `timeoutMs`, and report which of the three ways it ended. An
 * operation that ignores the signal and never settles still
 * loses the race: the timeout result is returned at the bound
 * regardless (the abandoned operation is left to finish or die
 * on its own; its result is never read).
 */
export async function awaitBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const work = (async (): Promise<BoundedResult<T>> => {
    try {
      const value = await operation(controller.signal);
      return { kind: "done", value };
    } catch (error) {
      return { kind: "unreachable", error };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
