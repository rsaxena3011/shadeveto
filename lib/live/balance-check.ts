/**
 * The pre-run balance read: the same provider unit endpoint the
 * runner settles against (UnitInfoBalanceProvider), exposed for
 * display only, behind the judge passcode.
 *
 * Access discipline mirrors the live run exactly (runner step 1):
 * the passcode is resolved through lib/ledger/access.ts, and
 * anything but judge mode gets the app's opaque non-answer, the
 * plain fixture marker, with no balance, no error, and no detail
 * about the mechanism. A wrong passcode therefore learns nothing,
 * not even whether a balance exists.
 *
 * This read NEVER creates a task and NEVER spends: the only
 * provider surface it can touch is the BalanceProvider it is
 * handed, whose single method is the unit-balance read.
 */

import { resolveAccessMode } from "../ledger/access.ts";
import type { BalanceProvider } from "../ledger/ledger.ts";

export interface BalanceDeps {
  balance: BalanceProvider;
  /** Defaults to the JUDGE_PASSCODE env value at call time. */
  expectedPasscode?: string;
}

export type BalanceReply =
  /** Not judge mode: the opaque marker, nothing else. */
  | { mode: "fixture" }
  /** Judge mode: the provider's figure, or null when the read
   * failed (unknown, never invented and never read as zero). */
  | { mode: "live"; balance: number | null };

export async function readLiveBalance(
  deps: BalanceDeps,
  passcode: string | null | undefined,
): Promise<BalanceReply> {
  // Passcode first, exactly like the runner: a missing or wrong
  // passcode never reaches the provider at all.
  if (resolveAccessMode(passcode, deps.expectedPasscode) !== "judge") {
    return { mode: "fixture" };
  }
  return { mode: "live", balance: await deps.balance.getBalanceUnits() };
}
