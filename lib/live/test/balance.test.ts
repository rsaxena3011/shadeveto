import type { BalanceProvider } from "../../ledger/ledger.ts";
import {
  createYouCamClient,
  type YouCamClient,
} from "../../youcam/client.ts";
import { UnitInfoBalanceProvider } from "../balance.ts";
import { readLiveBalance } from "../balance-check.ts";

/**
 * Pre-run balance read, all against fakes: no real API call
 * happens in this suite. The load-bearing assertions:
 * - a valid judge passcode returns the provider's own figure,
 *   read through the real UnitInfoBalanceProvider.
 * - a missing, wrong, differently-cased, or whitespace-padded
 *   passcode gets the opaque fixture marker: no balance, no
 *   extra fields, and the provider is never even read (the
 *   compare stays the exact timing-safe one in access.ts).
 * - the read performs no task creation: over a recording
 *   client, the only request it ever makes is the unit-credit
 *   GET; upload and task endpoints are never touched.
 * - a failed provider read reports balance null (unknown),
 *   never an invented number and never zero.
 */

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

const PASSCODE = "judge-code-2026";

class CountingBalanceProvider implements BalanceProvider {
  reads = 0;
  readonly value: number | null;
  constructor(value: number | null) {
    this.value = value;
  }
  async getBalanceUnits(): Promise<number | null> {
    this.reads++;
    return this.value;
  }
}

async function main() {
  // 1. Valid passcode: the figure comes back, read exactly once.
  {
    const provider = new CountingBalanceProvider(807);
    const reply = await readLiveBalance(
      { balance: provider, expectedPasscode: PASSCODE },
      PASSCODE,
    );
    check(
      reply.mode === "live" && reply.balance === 807 && provider.reads === 1,
      "valid passcode returns the provider balance, read once",
    );
  }

  // 2. Missing passcode: opaque marker, provider never read,
  // and the reply carries no balance and no other detail.
  {
    const provider = new CountingBalanceProvider(807);
    for (const presented of [null, undefined, ""]) {
      const reply = await readLiveBalance(
        { balance: provider, expectedPasscode: PASSCODE },
        presented,
      );
      check(
        reply.mode === "fixture" &&
          !("balance" in reply) &&
          Object.keys(reply).length === 1,
        `missing passcode (${String(presented)}) gets the opaque fixture marker only`,
      );
    }
    check(provider.reads === 0, "missing passcode never reaches the balance read");
  }

  // 3. Wrong passcode: the identical opaque marker, no read.
  // Case and padding variants are wrong too: the compare is the
  // exact timing-safe one, with no folding and no trimming here.
  {
    const provider = new CountingBalanceProvider(807);
    for (const presented of [
      "judge-code-2027",
      "JUDGE-CODE-2026",
      " judge-code-2026 ",
      "judge-code-202",
    ]) {
      const reply = await readLiveBalance(
        { balance: provider, expectedPasscode: PASSCODE },
        presented,
      );
      check(
        reply.mode === "fixture" && !("balance" in reply),
        `wrong passcode ${JSON.stringify(presented)} gets the same opaque marker`,
      );
    }
    check(provider.reads === 0, "wrong passcodes never reach the balance read");
  }

  // 4. No passcode configured server-side: fail closed for
  // everyone, exactly like the live run.
  {
    const provider = new CountingBalanceProvider(807);
    const reply = await readLiveBalance(
      { balance: provider, expectedPasscode: undefined },
      PASSCODE,
    );
    check(
      reply.mode === "fixture" && provider.reads === 0,
      "unconfigured passcode fails closed to the fixture marker",
    );
  }

  // 5. Provider read fails: live mode, balance null (unknown),
  // never an invented number.
  {
    const provider = new CountingBalanceProvider(null);
    const reply = await readLiveBalance(
      { balance: provider, expectedPasscode: PASSCODE },
      PASSCODE,
    );
    check(
      reply.mode === "live" && reply.balance === null,
      "a failed provider read reports balance null, not a number",
    );
  }

  // 6. End to end through the real UnitInfoBalanceProvider over
  // a recording client: the only request is the unit-credit
  // GET, so the read cannot create a task or spend anything.
  {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/s2s/v1.0/client/credit")) {
        return new Response(
          JSON.stringify({
            data: { results: [{ amount: 800 }, { amount: 7 }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected request in balance test: ${url}`);
    };
    const client: YouCamClient = createYouCamClient({
      apiKey: "<MASKED_SECRET_001>",
      baseUrl: "https://provider.invalid",
      fetchFn,
    });
    const reply = await readLiveBalance(
      {
        balance: new UnitInfoBalanceProvider(client),
        expectedPasscode: PASSCODE,
      },
      PASSCODE,
    );
    check(
      reply.mode === "live" && reply.balance === 807,
      "real provider sums the credit buckets (800 + 7 = 807)",
    );
    check(
      requests.length === 1 &&
        requests[0].method === "GET" &&
        requests[0].url.endsWith("/s2s/v1.0/client/credit"),
      "the read makes exactly one request: the unit-credit GET (no upload, no task creation)",
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

await main();
