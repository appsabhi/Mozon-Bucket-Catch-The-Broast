/**
 * Comprehensive Offer Unlock & Claim Flow Test Suite
 * Tests eligibility, server-side score verification, PostgreSQL persistence,
 * authenticated claim ownership, validation errors, and idempotency.
 *
 * Claims are bound to the OTP-verified player session: the mobile number comes from
 * the session, never from the request body, and email is not accepted from the client.
 */
const http = require("http");
const crypto = require("crypto");
require("./require_test_database");

process.env.PORT = "3199";

const server = require("../server");
const db = require("../db");
const { createPlayerSession, deletePlayerSessions } = require("./pg_test_helpers");

const BASE_URL = "http://127.0.0.1:3199";
const VERIFIED_MOBILE = "919876543210";
const VERIFIED_MOBILE_E164 = "+919876543210";

function postJson(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(BASE_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        ...headers
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function getJson(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + path, {
      method: "GET",
      headers
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function runTests() {
  console.log("=================================================");
  console.log("SOOFI MANDI OFFER UNLOCK FLOW — AUTOMATED TESTS");
  console.log("=================================================");

  await server.dbReadyPromise;

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`• ${testName}... PASSED ✓`);
      passed++;
    } else {
      console.error(`• ${testName}... FAILED ✗`);
      failed++;
    }
  }

  const playerUnder100 = "player_sub99_" + crypto.randomUUID().substring(0, 8);
  const playerOver100 = "player_sub105_" + crypto.randomUUID().substring(0, 8);
  const sessionHashes = [];

  try {
    const underSession = await createPlayerSession(db, playerUnder100, { origin: BASE_URL, trackHash: sessionHashes });
    const overSession = await createPlayerSession(db, playerOver100, { origin: BASE_URL, trackHash: sessionHashes });
    const underHeaders = underSession.headers;
    const overHeaders = overSession.headers;

    // TEST 1: Score 99 cannot unlock the offer
    const sub99 = await postJson("/api/leaderboard", {
      displayName: "UnderHundredPlayer",
      score: 99,
      foodCaught: 99,
      missedCount: 5,
      durationSeconds: 50
    }, underHeaders);

    assert((sub99.status === 200 || sub99.status === 201) && sub99.body.gameSessionId, "Score 99 leaderboard submission returns gameSessionId");
    const session99Id = sub99.body.gameSessionId;

    const claim99 = await postJson("/api/offers/claim", {
      gameSessionId: session99Id,
      fullName: "Zayd Al-Harbi"
    }, underHeaders);

    assert(claim99.status === 403 && claim99.body.success === false, "Claim with score 99 rejected with HTTP 403 Forbidden");

    // TEST 2: Score 105 eligible session
    const sub105 = await postJson("/api/leaderboard", {
      displayName: "FeastChampion",
      score: 105,
      foodCaught: 105,
      missedCount: 5,
      durationSeconds: 60
    }, overHeaders);

    assert((sub105.status === 200 || sub105.status === 201) && sub105.body.gameSessionId, "Score 105 leaderboard submission returns gameSessionId");
    const session105Id = sub105.body.gameSessionId;

    // TEST 3: A player without a saved profile name must be prompted first.
    const claimMissingName = await postJson("/api/offers/claim", {
      gameSessionId: session105Id
    }, overHeaders);
    assert(
      claimMissingName.status === 428 &&
      claimMissingName.body.code === "player_name_required",
      "Claim without a saved or submitted name asks for the first name"
    );

    // TEST 4: Validation - short / empty full name
    const claimBadName = await postJson("/api/offers/claim", {
      gameSessionId: session105Id,
      fullName: "A"
    }, overHeaders);
    assert(claimBadName.status === 400 && claimBadName.body.success === false, "Short/empty full name rejected with HTTP 400");

    // TEST 5: Ownership - another player's session cannot claim this verified game
    const claimOtherOwner = await postJson("/api/offers/claim", {
      gameSessionId: session105Id,
      fullName: "Tariq Mansoor"
    }, underHeaders);
    assert(claimOtherOwner.status === 404 && claimOtherOwner.body.success === false, "Another player's session cannot claim a game it does not own (HTTP 404)");

    // TEST 6: Unauthenticated claim is rejected
    const claimNoAuth = await postJson("/api/offers/claim", {
      gameSessionId: session105Id,
      fullName: "Tariq Mansoor"
    }, { Origin: BASE_URL });
    assert(claimNoAuth.status === 401 && claimNoAuth.body.success === false, "Claim without a verified player session rejected with HTTP 401");

    // TEST 7: Successful first claim saves the name to the authenticated player profile.
    const claimSuccess = await postJson("/api/offers/claim", {
      gameSessionId: session105Id,
      fullName: "Tariq Al-Mansoor",
      mobileNumber: "+91 00000 00000",
      email: "spoofed@example.com"
    }, overHeaders);

    assert(
      claimSuccess.status === 201 &&
      claimSuccess.body.success === true &&
      claimSuccess.body.claim &&
      claimSuccess.body.claim.claimId &&
      claimSuccess.body.claim.verifiedScore === 105,
      "Valid claim succeeds with HTTP 201, returns claimId and verifiedScore: 105"
    );

    const createdClaimId = claimSuccess.body.claim.claimId;

    // TEST 8: PostgreSQL direct verification
    const dbClaim = await db.queryOne(
      "SELECT claim_id, game_session_id, player_id, full_name, mobile_number, email, verified_score, claim_status FROM offer_claims WHERE claim_id = $1",
      [createdClaimId]
    );

    assert(
      dbClaim &&
      dbClaim.full_name === "Tariq Al-Mansoor" &&
      dbClaim.mobile_number === VERIFIED_MOBILE_E164 &&
      dbClaim.email === null &&
      parseInt(dbClaim.verified_score, 10) === 105,
      "Claim record in PostgreSQL uses verified session mobile, ignores client email, and stores verified score"
    );

    const savedProfile = await db.queryOne(
      "SELECT profile_name FROM players WHERE player_id = $1",
      [playerOver100]
    );
    assert(savedProfile && savedProfile.profile_name === "Tariq Al-Mansoor",
      "First successful claim permanently saves the name in the PostgreSQL player profile");

    // TEST 8: Idempotency (duplicate claim for the same gameSessionId)
    const claimDuplicate = await postJson("/api/offers/claim", {
      gameSessionId: session105Id
    }, overHeaders);

    assert(
      claimDuplicate.status === 200 &&
      claimDuplicate.body.success === true &&
      claimDuplicate.body.alreadyClaimed === true &&
      claimDuplicate.body.claim.claimId === createdClaimId,
      "Duplicate claim returns existing claim with HTTP 200 (idempotent)"
    );

    // TEST 9: A separate eligible game session reuses the saved name without asking again.
    await new Promise(resolve => setTimeout(resolve, 850));
    const repeatLogin = await createPlayerSession(db, playerOver100, {
      origin: BASE_URL,
      mobile: VERIFIED_MOBILE,
      trackHash: sessionHashes
    });
    const subNewSession = await postJson("/api/leaderboard", {
      displayName: "MandiGuest_1234",
      score: 110,
      foodCaught: 110,
      missedCount: 5,
      durationSeconds: 60
    }, repeatLogin.headers);
    const newSessionId = subNewSession.body.gameSessionId;
    const claimNewSession = await postJson("/api/offers/claim", {
      gameSessionId: newSessionId
    }, repeatLogin.headers);
    assert(
      subNewSession.status === 201 &&
      claimNewSession.status === 201 &&
      claimNewSession.body.claim.fullName === "Tariq Al-Mansoor" &&
      claimNewSession.body.claim.claimId !== createdClaimId,
      "A new eligible game session claims with the saved name without sending a browser name"
    );

    const spoofCheckSessionId = "sess_claim_profile_" + crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    await db.query(`
      INSERT INTO leaderboard (game_session_id, player_id, display_name, score, food_caught, missed_count, duration_seconds, submitted_at)
      VALUES ($1, $2, $3, 120, 120, 0, 60, $4)
    `, [spoofCheckSessionId, playerOver100, "MandiGuest_1234", submittedAt]);
    const spoofedClaim = await postJson("/api/offers/claim", {
      gameSessionId: spoofCheckSessionId,
      fullName: "Untrusted Browser Name"
    }, repeatLogin.headers);
    assert(
      spoofedClaim.status === 201 &&
      spoofedClaim.body.claim.fullName === "Tariq Al-Mansoor",
      "A browser-supplied name cannot override the authenticated player's saved profile"
    );

    const claimsForPlayer = await db.queryOne(
      "SELECT COUNT(*) AS count FROM offer_claims WHERE player_id = $1",
      [playerOver100]
    );
    assert(parseInt(claimsForPlayer.count, 10) === 3,
      "Claims remain unique per game session while separate eligible sessions can each be claimed");

    // TEST 10: GET /api/offers/claim (session retrieval)
    const getClaim = await getJson(`/api/offers/claim?gameSessionId=${encodeURIComponent(session105Id)}`, overHeaders);
    assert(
      getClaim.status === 200 &&
      getClaim.body.success === true &&
      getClaim.body.claim.claimId === createdClaimId,
      "GET /api/offers/claim retrieves claim for session"
    );

    // TEST 11: Admin analytics overview reflects offersClaimed
    const loginRes = await postJson("/api/admin/login", { password: process.env.ADMIN_PASSWORD || "soofi_admin_2026" }, { Origin: BASE_URL });
    const adminSetCookie = [].concat(loginRes.headers["set-cookie"] || []).find(c => c.startsWith("soofi_admin_session=")) || "";
    assert(loginRes.status === 200 && adminSetCookie && !loginRes.body.token, "Admin login succeeds with an HttpOnly cookie only");
    const adminCookie = adminSetCookie.split(";")[0];

    const overviewRes = await getJson("/api/admin/analytics/overview", {
      "Cookie": adminCookie
    });

    assert(
      overviewRes.status === 200 &&
      overviewRes.body.metrics &&
      overviewRes.body.metrics.offersClaimed >= 2,
      "Admin analytics overview reports at least 2 offersClaimed"
    );

  } catch (err) {
    console.error("Test execution exception:", err);
    failed++;
  }

  console.log("\n=================================================");
  console.log(`OFFER FLOW TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");

  // Cleanup test data
  try {
    await db.query("DELETE FROM offer_claims WHERE player_id IN ($1, $2)", [playerUnder100, playerOver100]);
    await db.query("DELETE FROM analytics_events WHERE player_id IN ($1, $2)", [playerUnder100, playerOver100]);
    await db.query("DELETE FROM leaderboard WHERE player_id IN ($1, $2)", [playerUnder100, playerOver100]);
    await db.query("DELETE FROM players WHERE player_id IN ($1, $2)", [playerUnder100, playerOver100]);
    await deletePlayerSessions(db, sessionHashes);
    console.log("✓ Test records cleaned up successfully.");
  } catch (_) {}

  server.close(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

runTests();
