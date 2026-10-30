import { NextResponse } from "next/server";
import { createConnectorLiveDeps } from "../../../lib/live/runner.ts";
import { readLiveBalance } from "../../../lib/live/balance-check.ts";

// Server work only, like the live check: credential socket and a
// provider read. It must never run on the edge runtime.
export const runtime = "nodejs";

/**
 * Pre-run balance endpoint. Judges see the real unit balance
 * before they spend it; everyone else gets the same opaque
 * fixture marker the live check returns for a missing or wrong
 * passcode, with no balance and no detail about the gate. The
 * read is display only (lib/live/balance-check.ts): it creates
 * no task and spends nothing, for any passcode.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ mode: "fixture" });
  }
  const passcode = form.get("passcode");

  let deps;
  try {
    deps = await createConnectorLiveDeps();
  } catch {
    // The credential service is not available in this
    // environment: fail closed to the same opaque marker.
    return NextResponse.json({ mode: "fixture" });
  }

  const reply = await readLiveBalance(
    deps,
    typeof passcode === "string" ? passcode : null,
  );
  return NextResponse.json(reply);
}
