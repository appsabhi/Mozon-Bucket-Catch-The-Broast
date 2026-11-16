/**
 * Shared PostgreSQL test helpers.
 *
 * Tests authenticate exactly like the browser does: the server only accepts
 * player-scoped writes (leaderboard, name, claims) from a same-origin request that
 * carries a valid `soofi_player_session` cookie. The helper below seeds a
 * `player_sessions` row using the same SHA-256 token-hash scheme the server
 * validates. It does not bypass OTP verification, the 100-point rule, or claim
 * idempotency checks; those are still enforced by the real endpoints under test.
 */

const crypto = require("node:crypto");

const PLAYER_SESSION_COOKIE = "soofi_player_session";

/**
 * Creates a player session row and returns the headers a same-origin client would send.
 * @param {{query: Function}} db  The application db module (db.js).
 * @param {string} playerId
 * @param {{origin: string, mobile?: string, trackHash?: string[]}} options
 */
async function createPlayerSession(db, playerId, { origin, mobile = "919876543210", trackHash } = {}) {
  if (!origin) throw new Error("createPlayerSession requires the test server origin");
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
  if (Array.isArray(trackHash)) trackHash.push(tokenHash);
  const now = new Date();
  await db.query(
    "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL)",
    [tokenHash, playerId, mobile, now.toISOString(), new Date(now.getTime() + 60 * 60 * 1000).toISOString()]
  );
  return { tokenHash, headers: { Origin: origin, Cookie: `${PLAYER_SESSION_COOKIE}=${sessionToken}` } };
}

/** Removes session rows created by createPlayerSession. */
async function deletePlayerSessions(db, tokenHashes) {
  for (const hash of tokenHashes) {
    await db.query("DELETE FROM player_sessions WHERE session_token_hash = $1", [hash]);
  }
}

/**
 * Inserts a player row so direct leaderboard/analytics inserts satisfy foreign keys.
 * Uses ON CONFLICT so repeated test runs are safe.
 */
async function ensurePlayer(db, playerId, displayName = "Test Player") {
  const nowIso = new Date().toISOString();
  await db.query(
    `INSERT INTO players (player_id, display_name, highest_score, total_games, created_at, updated_at)
     VALUES ($1, $2, 0, 0, $3, $3)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId, displayName, nowIso]
  );
}

/**
 * Signs a headless Chrome page in the same way a completed OTP login does: the browser gets the
 * HttpOnly session cookie for `baseUrl`. Call before navigating to the app so it boots authenticated.
 * @param {(method: string, params?: object) => Promise<any>} cdpSend  CDP send function for the page.
 */
async function signInBrowser(cdpSend, db, playerId, baseUrl, trackHash) {
  const { headers } = await createPlayerSession(db, playerId, { origin: baseUrl, trackHash });
  const token = headers.Cookie.slice(`${PLAYER_SESSION_COOKIE}=`.length);
  await cdpSend("Network.enable");
  await cdpSend("Network.setCookie", {
    name: PLAYER_SESSION_COOKIE,
    value: token,
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax"
  });
  return token;
}

/**
 * Polls until the game page has booted its hooks and restored the authenticated session.
 * Avoids fixed sleeps, which are flaky because the page also loads the external OTP widget script.
 * @param {(expression: string) => Promise<any>} evaluate  Evaluates an expression in the page.
 */
async function waitForAuthenticatedGame(evaluate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(`Boolean(window.__soofiGame && document.body.classList.contains("is-authenticated"))`);
      if (ready) return;
    } catch (_) {
      // Page may be mid-navigation; retry.
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Game page did not become ready and authenticated in time");
}

module.exports = { PLAYER_SESSION_COOKIE, createPlayerSession, deletePlayerSessions, ensurePlayer, signInBrowser, waitForAuthenticatedGame };
