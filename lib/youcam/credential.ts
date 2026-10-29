/**
 * Connector credential access for live mode (server-side only).
 *
 * The YouCam API key never lives in this repo, in an env file, or in
 * code. It is held by the connected "custom.youcam" connector (the
 * same pattern the study runners in ../study use through
 * dynamic_credentials.py): this module asks the local credential
 * service for a surrogate token over its unix socket, and hands the
 * client that surrogate as its bearer token. The surrogate is not
 * the key; the runtime swaps it for the real key only on approved
 * requests to the registered API host, yce-api-01.makeupar.com.
 *
 * Rules that keep this safe:
 * - The surrogate value is never logged, returned to a browser, or
 *   written to disk. It exists in server memory for one live run.
 * - A value that does not carry the surrogate prefix is refused, so
 *   a real credential can never leak through this path by accident.
 * - When the credential service is unreachable, this throws and live
 *   mode fails closed: fixture mode keeps working, nothing spends.
 */

import { request as httpRequest } from "node:http";

export const YOUCAM_CREDENTIAL_NAME = "custom.youcam";
export const YOUCAM_API_HOST = "yce-api-01.makeupar.com";

const DEFAULT_AUTHD_SOCKET = "/run/hatch/auth/authd.sock";
const SURROGATE_PATH = "/v1/credentials/surrogate";

export interface SurrogateEntry {
  name: string;
  surrogate: string;
  placement: unknown;
}

/**
 * Parse a credential-service response and return one entry. Pure,
 * so the safety checks are testable without the socket.
 */
export function parseSurrogateResponse(
  text: string,
  entryName = "access_token",
): SurrogateEntry {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The credential service returned a non-JSON response.");
  }
  const entries =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).credentials
      : null;
  if (!Array.isArray(entries)) {
    throw new Error("The credential service returned no credential entries.");
  }
  for (const entry of entries as Record<string, unknown>[]) {
    if (!entry || entry.name !== entryName) continue;
    const surrogate = String(entry.surrogate ?? "").trim();
    if (!surrogate.startsWith("hsurr:")) {
      throw new Error(
        "The credential service returned a non-surrogate value; refusing to use it.",
      );
    }
    return { name: entryName, surrogate, placement: entry.placement ?? null };
  }
  throw new Error(
    `The credential service has no ${entryName} entry for the YouCam connection.`,
  );
}

function postJsonOverSocket(
  socketPath: string,
  path: string,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `The credential service refused the surrogate request (HTTP ${res.statusCode}).`,
              ),
            );
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on("error", (err) => {
      reject(
        new Error(`The credential service is unreachable: ${err.message}`),
      );
    });
    req.write(body);
    req.end();
  });
}

/**
 * The bearer for a live run, from whichever source the server
 * actually has:
 * - Hosted deployments (Vercel) have no Hatch credential socket to
 *   ask, so the key there is the server-only YOUCAM_API_KEY env var
 *   set in the project settings. It is read per request, used only
 *   as the Authorization bearer on server-side calls to the API
 *   host, and never logged, returned, or written anywhere.
 * - On the Hatch VM there is no env var, so the connector
 *   surrogate below is used instead.
 * Until 2026-10-29 the live deps asked ONLY for the surrogate,
 * which does not exist on Vercel, so every hosted live request
 * threw before the passcode was even checked and the route failed
 * closed to fixture mode. That is why the judge run "did not
 * start" even with the correct passcode and a measured photo.
 */
export async function youcamBearerForLiveRun(): Promise<string> {
  const envKey = process.env.YOUCAM_API_KEY?.trim();
  if (envKey) return envKey;
  return youcamBearerFromConnector();
}

/** Fetch the YouCam surrogate entry from the credential service. */
export async function fetchYouCamSurrogate(
  socketPath: string = process.env.JARVIS_AUTHD_SOCK ?? DEFAULT_AUTHD_SOCKET,
): Promise<SurrogateEntry> {
  const text = await postJsonOverSocket(
    socketPath,
    SURROGATE_PATH,
    JSON.stringify({ name: YOUCAM_CREDENTIAL_NAME }),
  );
  return parseSurrogateResponse(text);
}

/**
 * The bearer token for the YouCam client: the surrogate, never the
 * real key. The connection registers bearer_header placement, which
 * is the only placement this client knows how to apply.
 */
export async function youcamBearerFromConnector(): Promise<string> {
  const entry = await fetchYouCamSurrogate();
  if (entry.placement !== "bearer_header") {
    throw new Error(
      "The YouCam connection uses a credential placement the live client cannot apply.",
    );
  }
  return entry.surrogate;
}
