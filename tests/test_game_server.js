/**
 * Automated Test Suite for Soofi Mandi "Catch the Feast" Server
 * Tests:
 * 1. Leaderboard retrieval (GET /api/leaderboard)
 * 2. Verified score submission (POST /api/leaderboard)
 * 3. Anti-abuse validation & tie-breaking rules
 * 4. Privacy-conscious analytics event tracking & deduplication
 * 5. Admin authentication & overview metrics aggregation
 * 6. Admin event history filtering & player timeline inspector
 * 7. Admin dashboard HTML serving
 */

const http = require("node:http");
const assert = require("node:assert");
const path = require("node:path");
const crypto = require("node:crypto");
require("./require_test_database");

// Launch server on a test port
process.env.PORT = "3099";
process.env.ADMIN_PASSWORD = "test_admin_password_2026";

// Require server to start it
const server = require(path.join(__dirname, "..", "server.js"));
const db = require(path.join(__dirname, "..", "db.js"));

const BASE_URL = "http://127.0.0.1:3099";
const testSessionHashes = [];
const testPlayerIds = [];
const testGameSessionIds = [];
const testAnalyticsSessionIds = [];

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    let postData = null;

    if (body !== null) {
      postData = typeof body === "string" ? body : JSON.stringify(body);
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(postData);
      if (method !== "GET" && !reqHeaders.Origin) reqHeaders.Origin = BASE_URL;
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders
      },
      (res) => {
        let resData = "";
        res.on("data", (chunk) => {
          resData += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(resData);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: resData,
            json
          });
        });
      }
    );

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function createPlayerSession(playerId) {
  await server.dbReadyPromise;
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
  testSessionHashes.push(tokenHash);
  const now = new Date();
  await db.query(
    "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL)",
    [tokenHash, playerId, "919876543210", now.toISOString(), new Date(now.getTime() + 60 * 60 * 1000).toISOString()]
  );
  return { Origin: BASE_URL, Cookie: `soofi_player_session=${sessionToken}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("=================================================");
  console.log("SOOFI MANDI CATCH THE FEAST — AUTOMATED TESTS");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• ${name}... `);
    try {
      await fn();
      console.log("PASSED ✓");
      passed++;
    } catch (err) {
      console.log("FAILED ✗");
      console.error("  Error:", err.message);
      failed++;
    }
  }

  // Allow server to bind socket
  await sleep(250);
  await server.dbReadyPromise;

  // 1. Leaderboard Initial State
  await test("GET /api/leaderboard returns 200 and leaderboard array", async () => {
    const res = await request("GET", "/api/leaderboard");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.success, true);
    assert.strictEqual(Array.isArray(res.json.leaderboard), true);
    assert.strictEqual(res.json.tieBreakingRule, "Score DESC, submitted_at ASC");
  });

  await test("GET /api/player/session restores a valid cookie session without changing it", async () => {
    const playerId = `test-session-restore-${Date.now()}`;
    const authHeaders = await createPlayerSession(playerId);
    const res = await request("GET", "/api/player/session", null, authHeaders);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.success, true);
    assert.strictEqual(res.json.authenticated, true);
    assert.strictEqual(res.json.playerId, playerId);
    assert.strictEqual(res.headers["cache-control"], "no-store");
    assert.strictEqual(res.headers["set-cookie"], undefined);
  });

  await test("GET /api/player/session clears expired and revoked session cookies", async () => {
    const revokedHeaders = await createPlayerSession(`test-session-revoked-${Date.now()}`);
    const revokedToken = revokedHeaders.Cookie.split("=")[1];
    const revokedHash = crypto.createHash("sha256").update(revokedToken).digest("hex");
    await db.query("UPDATE player_sessions SET revoked_at = $1 WHERE session_token_hash = $2", [new Date().toISOString(), revokedHash]);
    const revoked = await request("GET", "/api/player/session", null, revokedHeaders);
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual(revoked.json.authenticated, false);
    assert.ok(String(revoked.headers["set-cookie"]).includes("Max-Age=0"));

    const expiredHeaders = await createPlayerSession(`test-session-expired-${Date.now()}`);
    const expiredToken = expiredHeaders.Cookie.split("=")[1];
    const expiredHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
    await db.query("UPDATE player_sessions SET expires_at = $1 WHERE session_token_hash = $2", ["2000-01-01T00:00:00.000Z", expiredHash]);
    const expired = await request("GET", "/api/player/session", null, expiredHeaders);
    assert.strictEqual(expired.status, 200);
    assert.strictEqual(expired.json.authenticated, false);
    assert.ok(String(expired.headers["set-cookie"]).includes("Max-Age=0"));
  });

  await test("GET /api/player/session preserves the cookie when its database lookup fails", async () => {
    const authHeaders = await createPlayerSession(`test-session-db-error-${Date.now()}`);
    const originalQueryOne = db.queryOne;
    db.queryOne = async (query, params) => {
      if (String(query).includes("FROM player_sessions")) throw new Error("simulated database outage");
      return originalQueryOne.call(db, query, params);
    };
    try {
      const res = await request("GET", "/api/player/session", null, authHeaders);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.json.authenticated, false);
      assert.strictEqual(res.headers["set-cookie"], undefined);
    } finally {
      db.queryOne = originalQueryOne;
    }
  });

  await test("POST /api/auth/logout revokes the session and clears its cookie", async () => {
    const authHeaders = await createPlayerSession(`test-session-logout-${Date.now()}`);
    const logout = await request("POST", "/api/auth/logout", {}, authHeaders);
    assert.strictEqual(logout.status, 200);
    assert.strictEqual(logout.json.success, true);
    assert.ok(String(logout.headers["set-cookie"]).includes("Max-Age=0"));

    const session = await request("GET", "/api/player/session", null, authHeaders);
    assert.strictEqual(session.status, 200);
    assert.strictEqual(session.json.authenticated, false);
  });

  await test("MSG91 token exchange trusts only the server-verified mobile and fails closed otherwise", async () => {
    process.env.MSG91_AUTHKEY = process.env.MSG91_AUTHKEY || "test-only-authkey-placeholder";
    // Test-only numbers (never real users). The verified number always comes from MSG91's response.
    const VERIFIED = "919876500001";
    const OTHER = "919876500002";
    const originalFetch = global.fetch;
    const originalConsoleError = console.error;
    let upstreamReply = null;
    global.fetch = async (url, options) => {
      assert.strictEqual(url, "https://control.msg91.com/api/v5/widget/verifyAccessToken");
      const body = JSON.parse(options.body);
      assert.strictEqual(body["access-token"], "test-only-access-token");
      assert.ok(body.authkey, "Authkey must be sent server-side");
      return new Response(JSON.stringify(upstreamReply), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const countSessions = async () => Number((await db.queryOne(
      "SELECT COUNT(*) AS count FROM player_sessions WHERE mobile_number IN ($1, $2)", [VERIFIED, OTHER])).count);
    const exchange = (mobileNumber) => request("POST", "/api/auth/msg91", { accessToken: "test-only-access-token", mobileNumber });
    try {
      const logged = [];
      console.error = (...args) => { logged.push(args.join(" ")); }; // capture expected diagnostics
      await db.query("DELETE FROM player_sessions WHERE mobile_number IN ($1, $2)", [VERIFIED, OTHER]);

      // 0) Deployment without MSG91_AUTHKEY (the live Vercel failure) -> 503 before contacting MSG91,
      //    a log line naming the variable (never a value), and no session.
      const configuredAuthkey = process.env.MSG91_AUTHKEY;
      delete process.env.MSG91_AUTHKEY;
      upstreamReply = { type: "success", message: VERIFIED };
      let missingKeyRes;
      try {
        missingKeyRes = await exchange(VERIFIED);
      } finally {
        process.env.MSG91_AUTHKEY = configuredAuthkey;
      }
      assert.strictEqual(missingKeyRes.status, 503);
      assert.strictEqual(missingKeyRes.headers["set-cookie"], undefined);
      assert.ok(logged.some((line) => line.includes("MSG91_AUTHKEY environment variable is not set")),
        "missing Authkey must be logged by name");
      assert.ok(!logged.some((line) => line.includes(configuredAuthkey)), "Authkey value must never be logged");
      assert.strictEqual(await countSessions(), 0);

      // a) MSG91 rejects the token -> 401, no session
      upstreamReply = { type: "error", message: "invalid access-token", code: 701 };
      let res = await exchange(VERIFIED);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.headers["set-cookie"], undefined);

      // b) Success but message is not a mobile (e.g. a request id) -> fail closed 503, no session
      upstreamReply = { type: "success", message: "3566656c6f6e67726571" };
      res = await exchange(VERIFIED);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.json.code, "verified_identifier_contract_unconfirmed");
      assert.strictEqual(res.headers["set-cookie"], undefined);

      // c) MSG91 verified a different number than the client claims -> 401, no session
      upstreamReply = { type: "success", message: OTHER };
      res = await exchange(VERIFIED);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.headers["set-cookie"], undefined);
      assert.strictEqual(await countSessions(), 0);

      // d) MSG91 verified the requested number -> 200, HttpOnly session cookie, session stored with verified mobile
      upstreamReply = { type: "success", message: VERIFIED };
      res = await exchange(VERIFIED);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(res.json.playerId);
      const cookie = String(res.headers["set-cookie"] || "");
      assert.ok(cookie.includes("soofi_player_session=") && cookie.includes("HttpOnly"), "session cookie must be HttpOnly");
      const stored = await db.queryOne("SELECT player_id, mobile_number FROM player_sessions WHERE mobile_number = $1", [VERIFIED]);
      assert.ok(stored && stored.player_id === res.json.playerId);
      testPlayerIds.push(res.json.playerId);
    } finally {
      global.fetch = originalFetch;
      console.error = originalConsoleError;
      await db.query("DELETE FROM player_sessions WHERE mobile_number IN ($1, $2)", [VERIFIED, OTHER]);
    }
  });

  // 2. Score Submission Validation
  await test("POST /api/leaderboard validates required fields and score-caught match", async () => {
    const unauthenticated = await request("POST", "/api/leaderboard", {
      score: 10,
      foodCaught: 8
    });
    assert.strictEqual(unauthenticated.status, 401);

    const authHeaders = await createPlayerSession(`test-score-validation-${Date.now()}`);
    // Score & caught mismatch
    const badRes1 = await request("POST", "/api/leaderboard", {
      displayName: "Tester One",
      score: 10,
      foodCaught: 8, // mismatch!
      missedCount: 5,
      durationSeconds: 12
    }, authHeaders);
    assert.strictEqual(badRes1.status, 400);

    // Invalid player ID
    const badRes2 = await request("POST", "/api/leaderboard", {
      playerId: "short", // client identity is ignored; session is authoritative
      displayName: "Tester",
      score: 5,
      foodCaught: 5,
      missedCount: 5,
      durationSeconds: 10
    }, { ...authHeaders, Origin: "http://attacker.example" });
    assert.strictEqual(badRes2.status, 403);

    // Physical sanity check failure (e.g. 50 items in 2 seconds)
    const badRes3 = await request("POST", "/api/leaderboard", {
      displayName: "Cheater",
      score: 50,
      foodCaught: 50,
      missedCount: 5,
      durationSeconds: 2 // 25 catches/sec is impossible
    }, authHeaders);
    assert.strictEqual(badRes3.status, 400);
  });

  // 3. Valid Score Submission & Deterministic Tie-Breaking
  await test("POST /api/leaderboard accepts valid scores and applies deterministic tie-breaking", async () => {
    const ts = Date.now();
    const p1 = `test-player-uuid-alpha-${ts}`;
    const p2 = `test-player-uuid-beta-${ts}`;
    const testScore = 998;
    testPlayerIds.push(p1, p2);
    const p1Auth = await createPlayerSession(p1);
    const p2Auth = await createPlayerSession(p2);

    // Player 1 submits high score
    const res1 = await request("POST", "/api/leaderboard", {
      playerId: "spoofed-player-identity",
      displayName: "Alpha Feaster",
      score: testScore,
      foodCaught: testScore,
      missedCount: 5,
      durationSeconds: 350
    }, p1Auth);
    assert.strictEqual(res1.status, 201);
    assert.strictEqual(res1.json.success, true);
    testGameSessionIds.push(res1.json.gameSessionId);

    await sleep(60); // slight time difference for submission date

    // Player 2 submits identical score
    const res2 = await request("POST", "/api/leaderboard", {
      playerId: p2,
      displayName: "Beta Feaster",
      score: testScore,
      foodCaught: testScore,
      missedCount: 5,
      durationSeconds: 350
    }, p2Auth);
    assert.strictEqual(res2.status, 201);
    testGameSessionIds.push(res2.json.gameSessionId);

    const storedIdentity = await db.queryOne(
      "SELECT player_id FROM leaderboard WHERE game_session_id = $1",
      [res1.json.gameSessionId]
    );
    assert.strictEqual(storedIdentity.player_id, p1);

    // Verify tie breaking: Alpha submitted earlier, so Alpha must rank ahead of Beta!
    const lbRes = await request("GET", "/api/leaderboard");
    const top2 = lbRes.json.leaderboard.filter(e => e.player_id === p1 || e.player_id === p2);
    assert.strictEqual(top2.length >= 2, true);
    assert.strictEqual(top2[0].player_id, p1);
    assert.strictEqual(top2[1].player_id, p2);
  });

  // 4. Analytics Tracking & Deduplication
  await test("POST /api/analytics/events tracks events and deduplicates rapid duplicates", async () => {
    const p = "test-player-uuid-analytics";
    const s = `test-session-${Date.now()}`;
    testAnalyticsSessionIds.push(s);
    const unauthenticated = await request("POST", "/api/analytics/events", {
      playerId: p,
      sessionId: s,
      eventName: "game_start"
    });
    assert.strictEqual(unauthenticated.status, 401);
    const authHeaders = await createPlayerSession(p);

    const res1 = await request("POST", "/api/analytics/events", {
      playerId: "spoofed-player-identity",
      sessionId: s,
      eventName: "game_start",
      metadata: { isReplay: false }
    }, authHeaders);
    assert.strictEqual(res1.status, 201);

    // Rapid duplicate within 500ms
    const res2 = await request("POST", "/api/analytics/events", {
      playerId: p,
      sessionId: s,
      eventName: "game_start",
      metadata: { isReplay: false }
    }, authHeaders);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.json.deduplicated, true);

    // Track different event name
    const res3 = await request("POST", "/api/analytics/events", {
      playerId: p,
      sessionId: s,
      eventName: "cta_click",
      metadata: { target: "leaderboard_button" }
    }, authHeaders);
    assert.strictEqual(res3.status, 201);
    const storedIdentity = await db.queryOne(
      "SELECT player_id FROM analytics_events WHERE session_id = $1 AND event_name = $2 ORDER BY id DESC LIMIT 1",
      [s, "cta_click"]
    );
    assert.strictEqual(storedIdentity.player_id, p);
  });

  await test("claims require an authenticated owner, retain the 100-point rule, and use session mobile", async () => {
    const playerId = `test-claim-player-${Date.now()}`;
    testPlayerIds.push(playerId);
    const authHeaders = await createPlayerSession(playerId);
    const now = new Date().toISOString();
    const eligibleSession = `test_claim_${crypto.randomUUID()}`;
    const ineligibleSession = `test_claim_${crypto.randomUUID()}`;
    testGameSessionIds.push(eligibleSession, ineligibleSession);
    await db.query(`
      INSERT INTO players (player_id, display_name, highest_score, total_games, created_at, updated_at)
      VALUES ($1, $2, 100, 1, $3, $4)
      ON CONFLICT(player_id) DO NOTHING
    `, [playerId, "Claim Test", now, now]);
    await db.query(`
      INSERT INTO leaderboard (game_session_id, player_id, display_name, score, food_caught, missed_count, duration_seconds, submitted_at)
      VALUES ($1, $2, $3, 100, 100, 0, 100, $4), ($5, $6, $7, 99, 99, 0, 100, $8)
    `, [eligibleSession, playerId, "Claim Test", now, ineligibleSession, playerId, "Claim Test", now]);

    const unauthenticated = await request("POST", "/api/offers/claim", {
      gameSessionId: eligibleSession,
      fullName: "Claim Test"
    });
    assert.strictEqual(unauthenticated.status, 401);

    const underThreshold = await request("POST", "/api/offers/claim", {
      gameSessionId: ineligibleSession,
      fullName: "Claim Test"
    }, authHeaders);
    assert.strictEqual(underThreshold.status, 403);

    const claimResponse = await request("POST", "/api/offers/claim", {
      gameSessionId: eligibleSession,
      playerId: "spoofed-player-identity",
      fullName: "Claim Test",
      mobileNumber: "+919111111111",
      email: "ignored@example.test"
    }, authHeaders);
    assert.strictEqual(claimResponse.status, 201);
    assert.strictEqual(claimResponse.json.success, true);
    assert.strictEqual(Object.hasOwn(claimResponse.json.claim, "mobileNumber"), false);

    const storedClaim = await db.queryOne(
      "SELECT player_id, mobile_number, email, verified_score FROM offer_claims WHERE game_session_id = $1",
      [eligibleSession]
    );
    assert.strictEqual(storedClaim.player_id, playerId);
    assert.strictEqual(storedClaim.mobile_number, "+919876543210");
    assert.strictEqual(storedClaim.email, null);
    assert.strictEqual(Number(storedClaim.verified_score), 100);

    const idempotent = await request("POST", "/api/offers/claim", {
      gameSessionId: eligibleSession,
      fullName: "Claim Test"
    }, authHeaders);
    assert.strictEqual(idempotent.status, 200);
    assert.strictEqual(idempotent.json.alreadyClaimed, true);

    const otherPlayer = await createPlayerSession(`test-other-claimant-${Date.now()}`);
    const otherClaim = await request("GET", `/api/offers/claim?gameSessionId=${encodeURIComponent(eligibleSession)}`, null, otherPlayer);
    assert.strictEqual(otherClaim.status, 404);
  });

  // 5. Admin Authentication (cookie-only HttpOnly session)
  let adminCookie = "";
  const adminCookieHeader = () => ({ Cookie: adminCookie });
  const extractAdminCookie = (res) => {
    const setCookie = [].concat(res.headers["set-cookie"] || []).find(c => c.startsWith("soofi_admin_session="));
    return setCookie || "";
  };
  await test("POST /api/admin/login validates password and issues an HttpOnly session cookie", async () => {
    // Bad password
    const badLogin = await request("POST", "/api/admin/login", {
      password: "incorrect_password"
    });
    assert.strictEqual(badLogin.status, 401);
    assert.strictEqual(extractAdminCookie(badLogin), "");

    // Cross-origin login is refused
    const crossOrigin = await request("POST", "/api/admin/login", { password: "test_admin_password_2026" }, { Origin: "https://evil.example" });
    assert.strictEqual(crossOrigin.status, 403);

    // Good password
    const goodLogin = await request("POST", "/api/admin/login", {
      password: "test_admin_password_2026"
    });
    assert.strictEqual(goodLogin.status, 200);
    assert.strictEqual(goodLogin.json.success, true);
    assert.strictEqual(goodLogin.json.token, undefined, "token must not be exposed in the JSON body");
    const setCookie = extractAdminCookie(goodLogin);
    assert.ok(/;\s*HttpOnly/i.test(setCookie), "cookie must be HttpOnly");
    assert.ok(/;\s*SameSite=Strict/i.test(setCookie), "cookie must be SameSite=Strict");
    assert.ok(/;\s*Path=\//i.test(setCookie), "cookie must be scoped to /");
    assert.ok(/;\s*Max-Age=86400/i.test(setCookie), "cookie must persist across browser restarts for 24h");
    adminCookie = setCookie.split(";")[0];

    // Only the SHA-256 hash of the token is stored server-side
    const rawToken = adminCookie.split("=")[1];
    const plain = await db.queryOne("SELECT 1 AS hit FROM admin_sessions WHERE session_token = $1", [rawToken]);
    assert.ok(!plain, "raw token must not be stored");
    const hashed = await db.queryOne("SELECT 1 AS hit FROM admin_sessions WHERE session_token = $1",
      [crypto.createHash("sha256").update(rawToken).digest("hex")]);
    assert.ok(hashed, "hashed token must be stored");
  });

  await test("GET /api/admin/session restores the session on refresh / new tab and rejects bad sessions", async () => {
    // Refresh or a new tab: the browser only re-sends the cookie
    const restored = await request("GET", "/api/admin/session", null, adminCookieHeader());
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.json.authenticated, true);
    assert.strictEqual(restored.headers["cache-control"], "no-store");
    const restoredAgain = await request("GET", "/api/admin/session", null, adminCookieHeader());
    assert.strictEqual(restoredAgain.status, 200, "session stays valid across repeated page loads");

    // No cookie
    const none = await request("GET", "/api/admin/session");
    assert.strictEqual(none.status, 401);
    assert.strictEqual(none.json.authenticated, false);

    // Invalid (well-formed but unknown) and malformed cookies are rejected and cleared
    for (const bogus of [crypto.randomBytes(32).toString("hex"), "not-a-token"]) {
      const invalid = await request("GET", "/api/admin/session", null, { Cookie: `soofi_admin_session=${bogus}` });
      assert.strictEqual(invalid.status, 401);
      assert.ok(/Max-Age=0/.test(extractAdminCookie(invalid)), "invalid cookie must be cleared");
      const invalidApi = await request("GET", "/api/admin/analytics/overview", null, { Cookie: `soofi_admin_session=${bogus}` });
      assert.strictEqual(invalidApi.status, 401);
    }

    // Expired session
    const expiredToken = crypto.randomBytes(32).toString("hex");
    const expiredHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await db.query("INSERT INTO admin_sessions (session_token, created_at, expires_at) VALUES ($1, $2, $3)",
      [expiredHash, new Date(past.getTime() - 1000).toISOString(), past.toISOString()]);
    try {
      const expired = await request("GET", "/api/admin/session", null, { Cookie: `soofi_admin_session=${expiredToken}` });
      assert.strictEqual(expired.status, 401);
      const expiredApi = await request("GET", "/api/admin/analytics/overview", null, { Cookie: `soofi_admin_session=${expiredToken}` });
      assert.strictEqual(expiredApi.status, 401);
    } finally {
      await db.query("DELETE FROM admin_sessions WHERE session_token = $1", [expiredHash]);
    }
  });

  // 6. Admin Overview Metrics
  await test("GET /api/admin/analytics/overview aggregates metrics under admin auth", async () => {
    // Unauthorized without a session
    const unauth = await request("GET", "/api/admin/analytics/overview");
    assert.strictEqual(unauth.status, 401);

    // Bearer tokens are no longer accepted; only the HttpOnly cookie authorizes
    const rawToken = adminCookie.split("=")[1];
    const bearer = await request("GET", "/api/admin/analytics/overview", null, { Authorization: `Bearer ${rawToken}` });
    assert.strictEqual(bearer.status, 401);

    // Authorized with the cookie
    const auth = await request("GET", "/api/admin/analytics/overview", null, adminCookieHeader());
    assert.strictEqual(auth.status, 200);
    assert.strictEqual(auth.json.success, true);
    assert.strictEqual(typeof auth.json.metrics.uniquePlayers, "number");
    assert.strictEqual(typeof auth.json.metrics.highestScore, "number");
    assert.strictEqual(auth.json.metrics.highestScore >= 15, true);
  });

  // 7. Admin Events History Filtering & Player Timeline
  await test("GET /api/admin/analytics/events and player timeline filter correctly", async () => {
    const eventsUnauth = await request("GET", "/api/admin/analytics/events?eventType=cta_click");
    assert.strictEqual(eventsUnauth.status, 401);
    const timelineUnauth = await request("GET", "/api/admin/analytics/player/test-player-uuid-analytics");
    assert.strictEqual(timelineUnauth.status, 401);
    const featuresUnauth = await request("POST", "/api/config/features", { features: {} });
    assert.strictEqual(featuresUnauth.status, 401);

    const eventsRes = await request("GET", "/api/admin/analytics/events?eventType=cta_click", null, adminCookieHeader());
    assert.strictEqual(eventsRes.status, 200);
    assert.strictEqual(eventsRes.json.success, true);
    assert.strictEqual(eventsRes.json.events.length > 0, true);
    assert.strictEqual(eventsRes.json.events.every(e => e.event_name === "cta_click"), true);

    const timelineRes = await request("GET", "/api/admin/analytics/player/test-player-uuid-analytics", null, adminCookieHeader());
    assert.strictEqual(timelineRes.status, 200);
    assert.strictEqual(timelineRes.json.success, true);
    assert.strictEqual(timelineRes.json.events.length >= 2, true);
  });

  await test("POST /api/admin/logout revokes the session server-side and clears the cookie", async () => {
    const crossOrigin = await request("POST", "/api/admin/logout", {}, { ...adminCookieHeader(), Origin: "https://evil.example" });
    assert.strictEqual(crossOrigin.status, 403);
    const stillValid = await request("GET", "/api/admin/session", null, adminCookieHeader());
    assert.strictEqual(stillValid.status, 200, "cross-origin logout must not revoke");

    const logout = await request("POST", "/api/admin/logout", {}, adminCookieHeader());
    assert.strictEqual(logout.status, 200);
    assert.ok(/Max-Age=0/.test(extractAdminCookie(logout)), "logout must clear the cookie");

    // Replaying the old cookie after logout fails everywhere
    const afterSession = await request("GET", "/api/admin/session", null, adminCookieHeader());
    assert.strictEqual(afterSession.status, 401);
    const afterApi = await request("GET", "/api/admin/analytics/overview", null, adminCookieHeader());
    assert.strictEqual(afterApi.status, 401);
    const rawToken = adminCookie.split("=")[1];
    const row = await db.queryOne("SELECT 1 AS hit FROM admin_sessions WHERE session_token = $1",
      [crypto.createHash("sha256").update(rawToken).digest("hex")]);
    assert.ok(!row, "session row must be deleted");

    // Logout without a session is a harmless no-op
    const anonLogout = await request("POST", "/api/admin/logout", {});
    assert.strictEqual(anonLogout.status, 200);
  });

  // 8. Admin Dashboard HTML Serving
  await test("GET /admin/game-analytics serves the Owner Dashboard HTML", async () => {
    const dashRes = await request("GET", "/admin/game-analytics");
    assert.strictEqual(dashRes.status, 200);
    assert.strictEqual(dashRes.headers["content-type"].includes("text/html"), true);
    assert.strictEqual(dashRes.data.includes("Game Analytics Dashboard"), true);
    assert.strictEqual(dashRes.data.includes("Soofi Mandi"), true);
    assert.ok(dashRes.data.includes("/api/admin/session"), "dashboard must verify the session with the backend on load");
    assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(dashRes.data), "dashboard must not persist tokens in web storage");
    assert.ok(!dashRes.data.includes("Bearer "), "dashboard must not send bearer tokens");
  });

  for (const sessionHash of testSessionHashes) {
    await db.query("DELETE FROM player_sessions WHERE session_token_hash = $1", [sessionHash]);
  }
  for (const gameSessionId of testGameSessionIds) {
    await db.query("DELETE FROM offer_claims WHERE game_session_id = $1", [gameSessionId]);
    await db.query("DELETE FROM analytics_events WHERE session_id = $1", [gameSessionId]);
    await db.query("DELETE FROM leaderboard WHERE game_session_id = $1", [gameSessionId]);
  }
  for (const sessionId of testAnalyticsSessionIds) {
    await db.query("DELETE FROM analytics_events WHERE session_id = $1", [sessionId]);
  }
  for (const playerId of testPlayerIds) {
    await db.query("DELETE FROM players WHERE player_id = $1", [playerId]);
  }
  if (adminCookie) {
    const rawAdminToken = adminCookie.split("=")[1];
    await db.query("DELETE FROM admin_sessions WHERE session_token = $1",
      [crypto.createHash("sha256").update(rawAdminToken).digest("hex")]);
  }

  console.log("\n=================================================");
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
