// ICE servers for WebRTC.
// STUN alone fails between many mobile/carrier networks, so a TURN relay is needed for reliable calls.
//
// Priority:
//   1. CF_TURN_KEY_ID + CF_TURN_API_TOKEN -> short-lived Cloudflare TURN credentials (free up to 1,000 GB/month)
//   2. ICE_SERVERS                         -> a fixed JSON list (any TURN provider)
//   3. Google STUN                         -> works on most home Wi-Fi, not on every mobile network

const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const CF_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TOKEN = process.env.CF_TURN_API_TOKEN;
const TTL_SECONDS = 24 * 60 * 60;

// Browsers block port 53; offering it only slows down ICE gathering.
const usable = (url) => !/:53(\?|$)/.test(url);

function normalize(list) {
  return (Array.isArray(list) ? list : [list])
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(usable) }))
    .filter((s) => s.urls.length);
}

let fixed = null;
if (process.env.ICE_SERVERS) {
  try {
    fixed = normalize(JSON.parse(process.env.ICE_SERVERS));
  } catch {
    console.warn("ICE_SERVERS is not valid JSON; ignoring it");
  }
}

let cached = null; // { servers, expires }
let inflight = null;

async function fetchCloudflare() {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const data = await res.json();
  return normalize(data.iceServers);
}

export async function iceServers() {
  if (CF_KEY_ID && CF_TOKEN) {
    if (cached && cached.expires > Date.now()) return cached.servers;
    inflight ??= fetchCloudflare()
      .then((servers) => {
        // Refresh well before the credentials expire.
        cached = { servers, expires: Date.now() + (TTL_SECONDS * 1000) / 2 };
        return servers;
      })
      .catch((e) => {
        console.error("[ice] could not get TURN credentials:", e.message);
        // Don't make every call wait on a failing request: retry in 5 minutes.
        cached = { servers: fixed ?? STUN, expires: Date.now() + 5 * 60_000 };
        return cached.servers;
      })
      .finally(() => (inflight = null));
    return inflight;
  }
  return fixed ?? STUN;
}

export function turnInfo() {
  if (CF_KEY_ID && CF_TOKEN) return "Cloudflare TURN";
  if (fixed) return "ICE_SERVERS";
  return "STUN only (set CF_TURN_KEY_ID/CF_TURN_API_TOKEN for TURN)";
}
