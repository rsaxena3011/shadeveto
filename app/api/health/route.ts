import { NextResponse } from "next/server";

// Liveness probe. Reports configuration as booleans only; secret
// values are never returned. Live mode's API credential comes from
// the server-only YOUCAM_API_KEY env var on hosted deployments, or
// the connected YouCam connector on the Hatch VM (see
// lib/youcam/credential.ts); the judge passcode gates spending.
export function GET() {
  return NextResponse.json({
    ok: true,
    service: "shadeveto",
    phase: "live-mode",
    judgePasscodeConfigured: Boolean(process.env.JUDGE_PASSCODE),
    youcamKeyConfigured: Boolean(process.env.YOUCAM_API_KEY?.trim()),
    time: new Date().toISOString(),
  });
}
