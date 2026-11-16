/**
 * Customer Offer Management (admin dashboard)
 *   GET  /api/admin/offers/customers   all eligible customers + mobile search
 *   POST /api/admin/offers/claim       staff "Claim" button ({ customerId: verified mobile })
 *
 * Verifies against the dedicated PostgreSQL test database that:
 *  1. both endpoints require an admin session (the claim also a same-origin request),
 *  2. only MSG91-verified mobiles (player_sessions) with a score >= 100 are customers;
 *     guest-only and unverified players never appear,
 *  3. games are grouped by verified mobile: several games, names and player identities of one
 *     mobile give ONE customer, and different mobiles are never merged even with the same name,
 *  4. the list shows claimed AND unclaimed customers (unclaimed first) with accurate totals;
 *     a mobile search finds either,
 *  5. Claim needs no extra input, updates PostgreSQL at once and the customer stays listed as
 *     CLAIMED; repeated and concurrent claims produce exactly one claim,
 *  6. existing customer and claim records are preserved.
 *
 * Requires TEST_DATABASE_URL (see tests/require_test_database.js).
 */
const http = require("node:http");
const assert = require("node:assert");
const path = require("node:path");
const crypto = require("node:crypto");
require("./require_test_database");

const PORT = 3094;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = "customer_offer_test_pw_2026";
const server = require(path.join(__dirname, "..", "server.js"));
const db = require(path.join(__dirname, "..", "db.js"));
const { DEFAULT_OFFER } = require(path.join(__dirname, "..", "offers.js"));
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(new URL(urlPath, BASE), {
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Origin: BASE, ...headers }
        : headers
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`• ${name}... `);
  try { await fn(); passed++; console.log("PASSED ✓"); }
  catch (e) { failed++; console.log("FAILED ✗"); console.log("  " + (e && e.stack || e)); }
}

// Test-only identities and numbers (never real customers).
const RUN = crypto.randomBytes(4).toString("hex");
const P = {
  raviMain: `test-com-ravi1-${RUN}`,  // verified M1: several games under different names
  raviOld: `test-com-ravi2-${RUN}`,   // a second identity first verified with M1
  raviOther: `test-com-ravi3-${RUN}`, // different mobile M2, SAME name "Ravi"
  guest: `test-com-guest-${RUN}`,     // guest-only: no verified session (score 500)
  typed: `test-com-typed-${RUN}`,     // legacy claim with a typed mobile but no verified session
  low: `test-com-low-${RUN}`,         // verified M3, best score 99
  unlocked: `test-com-unl-${RUN}`,    // verified M4 with an in-game 'unlocked' claim record
  claimed: `test-com-clm-${RUN}`      // verified M5, already staff-claimed
};
const M = {
  ravi: "919876533301", raviOther: "919876533302", low: "919876533303",
  unlocked: "919876533304", claimed: "919876533305", typed: "919876533306", unknown: "919876533399"
};
const allPlayers = Object.values(P);
const SEED_TIME = Date.now();
const iso = (offsetMs) => new Date(SEED_TIME + offsetMs).toISOString();

async function seed() {
  const addPlayer = (id, name, profile) => db.query(
    "INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at) VALUES ($1,$2,$3,0,0,$4,$4)",
    [id, name, profile, iso(-100000)]);
  const addGame = async (playerId, score, name, at) => {
    const gsid = `gs-${playerId}-${crypto.randomBytes(3).toString("hex")}`;
    await db.query(
      "INSERT INTO game_sessions (session_id, player_id, created_at, expires_at, used_at, score, food_caught) VALUES ($1,$2,$3,$4,$3,$5,$5)",
      [gsid, playerId, iso(at), iso(3600000), score]);
    await db.query(
      "INSERT INTO leaderboard (game_session_id, player_id, display_name, score, food_caught, missed_count, duration_seconds, submitted_at) VALUES ($1,$2,$3,$4,$4,5,60,$5)",
      [gsid, playerId, name, score, iso(at)]);
    return gsid;
  };
  const addSession = (playerId, mobile, at) => db.query(
    "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,NULL)",
    [crypto.createHash("sha256").update(`${playerId}-${mobile}-${at}`).digest("hex"), playerId, mobile, iso(at), iso(86400000)]);
  const addClaim = (id, gsid, playerId, name, mobile, score, status, at, redeemedAt = null) => db.query(`
    INSERT INTO offer_claims (claim_id, game_session_id, player_id, full_name, mobile_number, email, verified_score,
      offer_id, offer_title, offer_badge, claim_status, created_at, redeemed_at)
    VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12)`,
    [id, gsid, playerId, name, mobile, score, DEFAULT_OFFER.id, DEFAULT_OFFER.title, DEFAULT_OFFER.badge, status, at, redeemedAt]);

  await addPlayer(P.raviMain, "Ravi K", null);
  await addPlayer(P.raviOld, "Raviraj", "Raviraj");
  await addPlayer(P.raviOther, "Ravi", "Ravi");
  await addPlayer(P.guest, "MandiGuest_5000", null);
  await addPlayer(P.typed, "Typed Name", "Typed Name");
  await addPlayer(P.low, "Low Test", "Low Test");
  await addPlayer(P.unlocked, "Meera Test", "Meera Test");
  await addPlayer(P.claimed, "Farah Test", "Farah Test");

  // M1: three games under three names on one identity, plus an older identity of the same mobile.
  await addGame(P.raviMain, 120, "Ravi", -50000);
  await addGame(P.raviMain, 150, "Ravi K", -40000);
  await addGame(P.raviMain, 95, "R", -35000);
  await addGame(P.raviMain, 105, "MandiGuest_1111", -34000);
  await addGame(P.raviOld, 130, "Raviraj", -60000);
  await addSession(P.raviOld, M.ravi, -70000);
  await addSession(P.raviMain, M.ravi, -55000);
  await addSession(P.raviMain, M.ravi, -30000); // repeat login, same mobile
  // M2: a different person who also calls themself "Ravi".
  await addGame(P.raviOther, 110, "Ravi", -45000);
  await addSession(P.raviOther, M.raviOther, -46000);
  // Guest-only and unverified players with high scores.
  await addGame(P.guest, 500, "MandiGuest_5000", -44000);
  const typedGame = await addGame(P.typed, 200, "Typed Name", -43000);
  await addClaim(`claim-com-typed-${RUN}`, typedGame, P.typed, "Typed Name", `+${M.typed}`, 200, "unlocked", iso(-42000));
  // Verified but below the threshold.
  await addGame(P.low, 99, "Low Test", -41000);
  await addSession(P.low, M.low, -41500);
  // Verified with an in-game claim record.
  const unlockedGame = await addGame(P.unlocked, 140, "Meera Test", -39000);
  await addSession(P.unlocked, M.unlocked, -39500);
  await addClaim(`claim-com-unl-${RUN}`, unlockedGame, P.unlocked, "Meera Test", `+${M.unlocked}`, 140, "unlocked", iso(-38000));
  // Verified and already claimed by staff.
  const claimedGame = await addGame(P.claimed, 160, "Farah Test", -37000);
  await addSession(P.claimed, M.claimed, -37500);
  await addClaim(`claim-com-clm-${RUN}`, claimedGame, P.claimed, "Farah Test", `+${M.claimed}`, 160, "claimed", iso(-36000), iso(-35500));
}

async function cleanup() {
  await db.query("DELETE FROM offer_claims WHERE player_id = ANY($1)", [allPlayers]);
  await db.query("DELETE FROM player_sessions WHERE player_id = ANY($1)", [allPlayers]);
  await db.query("DELETE FROM leaderboard WHERE player_id = ANY($1)", [allPlayers]);
  await db.query("DELETE FROM game_sessions WHERE player_id = ANY($1)", [allPlayers]);
  await db.query("DELETE FROM players WHERE player_id = ANY($1)", [allPlayers]);
}

const claimsFor = (playerIds) => db.query(
  "SELECT * FROM offer_claims WHERE player_id = ANY($1) ORDER BY created_at, claim_id", [playerIds]);
const strip = (row) => { const { claim_status, redeemed_at, ...rest } = row; return JSON.stringify(rest); };

(async () => {
  console.log("=================================================");
  console.log("CUSTOMER OFFER MANAGEMENT TESTS");
  console.log("=================================================");
  await server.dbReadyPromise;
  await cleanup();
  await seed();

  const foreignBefore = JSON.stringify(await db.query(
    "SELECT * FROM offer_claims WHERE NOT (player_id = ANY($1)) ORDER BY claim_id", [allPlayers]));
  const playersBefore = JSON.stringify(await db.query("SELECT * FROM players ORDER BY player_id"));

  let cookie = "";
  const auth = () => ({ Cookie: cookie });
  const list = async (mobile) => {
    const res = await request("GET", "/api/admin/offers/customers" + (mobile ? `?mobile=${encodeURIComponent(mobile)}` : ""), null, auth());
    assert.strictEqual(res.status, 200, res.text);
    return res.json;
  };
  const mine = (data) => data.customers.filter((c) => Object.values(M).includes(c.customerId));
  const byId = (data, mobile) => data.customers.find((c) => c.customerId === mobile);
  const claim = (customerId, headers = {}) => request("POST", "/api/admin/offers/claim", { customerId }, { ...auth(), ...headers });

  try {
    await test("Both endpoints reject requests without a valid admin session; claim rejects cross-origin", async () => {
      assert.strictEqual((await request("GET", "/api/admin/offers/customers")).status, 401);
      assert.strictEqual((await request("GET", "/api/admin/offers/customers", null, { Cookie: `soofi_admin_session=${"0".repeat(64)}` })).status, 401);
      assert.strictEqual((await request("POST", "/api/admin/offers/claim", { customerId: M.ravi })).status, 401);
      const login = await request("POST", "/api/admin/login", { password: process.env.ADMIN_PASSWORD });
      cookie = String(login.headers["set-cookie"]).split(";")[0];
      assert.strictEqual((await claim(M.ravi, { Origin: "https://evil.example" })).status, 403);
      assert.strictEqual((await claimsFor([P.raviMain, P.raviOld])).length, 0);
    });

    let main;
    await test("List: every verified mobile with 100+, claimed and unclaimed, one row per mobile", async () => {
      main = await list();
      const ids = mine(main).map((c) => c.customerId).sort();
      assert.deepStrictEqual(ids, [M.ravi, M.raviOther, M.unlocked, M.claimed].sort(),
        "guest-only, typed-mobile and below-100 players are excluded; claimed customers stay visible");
      assert.strictEqual(new Set(main.customers.map((c) => c.customerId)).size, main.customers.length, "no duplicate customers");
      assert.ok(main.customers.every((c) => /^91[6-9]\d{9}$/.test(c.customerId)), "every customer is a verified mobile");
      assert.strictEqual(byId(main, M.claimed).claimStatus, "claimed");
      const firstClaimed = main.customers.findIndex((c) => c.claimed);
      assert.ok(firstClaimed === -1 || main.customers.slice(firstClaimed).every((c) => c.claimed), "unclaimed customers listed first");
    });

    await test("Totals: eligible = claimed + unclaimed, matching the full list", async () => {
      const t = main.totals;
      assert.strictEqual(t.eligible, main.customers.length);
      assert.strictEqual(t.claimed, main.customers.filter((c) => c.claimed).length);
      assert.strictEqual(t.unclaimed, main.customers.filter((c) => !c.claimed).length);
      assert.strictEqual(t.claimed + t.unclaimed, t.eligible);
      const search = await list(M.ravi);
      assert.deepStrictEqual(search.totals, t, "totals describe all eligible customers, not just search results");
    });

    await test("Several games, names and identities of one mobile are grouped into ONE customer", async () => {
      const ravi = byId(main, M.ravi);
      assert.strictEqual(ravi.mobileNumber, "+91 98765 33301");
      assert.strictEqual(ravi.score, 150, "highest qualifying score across all games of the mobile");
      assert.strictEqual(ravi.qualifyingGames, 4, "120, 150, 105 and 130 (the 95 game does not qualify)");
      assert.strictEqual(ravi.name, "Raviraj", "saved profile name first");
      assert.deepStrictEqual(ravi.otherNames, ["Ravi K", "Ravi"], "other names used, guest placeholders skipped");
      assert.strictEqual(ravi.claimStatus, "unclaimed");
      assert.strictEqual(ravi.offer.title, DEFAULT_OFFER.title);
    });

    await test("Different mobiles are never merged, even when the names match", async () => {
      const other = byId(main, M.raviOther);
      assert.deepStrictEqual([other.name, other.score, other.qualifyingGames], ["Ravi", 110, 1]);
      assert.notStrictEqual(other.customerId, M.ravi);
    });

    await test("Guest-only and unverified players are never customers, even by search", async () => {
      assert.strictEqual((await list(M.typed)).customers.length, 0, "typed claim mobile is not a verified login");
      assert.strictEqual((await list(M.low)).customers.length, 0, "below 100");
      assert.ok(!main.customers.some((c) => c.score === 500 && c.name === null), "guest score 500 absent");
      assert.strictEqual((await claim(M.typed)).status, 404);
      assert.strictEqual((await claim(M.low)).status, 404);
      assert.strictEqual((await claim(M.unknown)).status, 404);
      assert.strictEqual((await request("POST", "/api/admin/offers/claim", { customerId: "12345" }, auth())).status, 400);
      assert.strictEqual((await request("POST", "/api/admin/offers/claim", {}, auth())).status, 400);
    });

    await test("Mobile search finds a previously claimed customer with CLAIMED status; no second claim", async () => {
      for (const q of [M.claimed, M.claimed.slice(2), "+91 98765-33305", "33305"]) {
        const r = await list(q);
        assert.deepStrictEqual(r.customers.map((c) => [c.customerId, c.claimStatus]), [[M.claimed, "claimed"]], `query ${q}`);
        assert.strictEqual(new Date(r.customers[0].claimedAt).toISOString(), iso(-35500));
      }
      const again = await claim(M.claimed);
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.json.alreadyClaimed, true, "claiming again is refused as a duplicate");
      assert.strictEqual((await claimsFor([P.claimed])).filter((r) => r.claim_status === "claimed").length, 1);
    });

    await test("Claim with no extra input reuses the in-game record; customer stays listed as CLAIMED", async () => {
      const totalsBefore = (await list()).totals;
      const before = await claimsFor([P.unlocked]);
      const res = await claim(M.unlocked);
      assert.strictEqual(res.status, 200, res.text);
      assert.deepStrictEqual([res.json.alreadyClaimed, res.json.claim.claimStatus, res.json.claim.mobileNumber], [false, "claimed", "+91 98765 33304"]);
      const after = await claimsFor([P.unlocked]);
      assert.strictEqual(after.length, 1, "no new record");
      assert.strictEqual(after[0].claim_status, "claimed");
      assert.ok(after[0].redeemed_at);
      assert.strictEqual(strip(after[0]), strip(before[0]), "all other fields preserved");
      const afterList = await list();
      assert.strictEqual(byId(afterList, M.unlocked).claimStatus, "claimed", "still listed, now CLAIMED");
      assert.deepStrictEqual(afterList.totals, {
        eligible: totalsBefore.eligible, claimed: totalsBefore.claimed + 1, unclaimed: totalsBefore.unclaimed - 1
      }, "counts move one customer from unclaimed to claimed");
      assert.strictEqual(byId(await list(M.unlocked), M.unlocked).claimStatus, "claimed", "search shows CLAIMED");
    });

    await test("12 concurrent claims for the grouped customer produce exactly one claim", async () => {
      const totalsBefore = (await list()).totals;
      const results = await Promise.all(Array.from({ length: 12 }, () => claim(M.ravi)));
      results.forEach((r) => assert.strictEqual(r.status, 200, r.text));
      assert.strictEqual(results.filter((r) => r.json.alreadyClaimed === false).length, 1);
      const rows = await claimsFor([P.raviMain, P.raviOld]);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].claim_status, rows[0].mobile_number, rows[0].verified_score, rows[0].full_name],
        ["claimed", `+${M.ravi}`, 150, "Raviraj"]);
      const afterList = await list();
      assert.strictEqual(byId(afterList, M.ravi).claimStatus, "claimed", "still listed, now CLAIMED");
      assert.strictEqual(afterList.totals.claimed, totalsBefore.claimed + 1, "counted once despite 12 requests");
      assert.strictEqual(afterList.totals.eligible, totalsBefore.eligible);
      const search = await list(M.ravi);
      assert.deepStrictEqual(search.customers.map((c) => [c.customerId, c.claimStatus]), [[M.ravi, "claimed"]]);
      assert.strictEqual((await claim(M.ravi)).json.alreadyClaimed, true);
    });

    await test("The same-name customer on another mobile is still unclaimed", async () => {
      const other = byId(await list(), M.raviOther);
      assert.ok(other && other.claimStatus === "unclaimed");
      assert.strictEqual((await claimsFor([P.raviOther])).length, 0);
    });

    await test("The database rejects a second CLAIMED record for the same verified mobile and offer", async () => {
      const spare = await db.queryOne(
        "SELECT game_session_id FROM leaderboard WHERE player_id = $1 AND game_session_id NOT IN (SELECT game_session_id FROM offer_claims)", [P.raviMain]);
      await assert.rejects(
        db.query(`INSERT INTO offer_claims (claim_id, game_session_id, player_id, full_name, mobile_number, verified_score,
          offer_id, offer_title, offer_badge, claim_status, created_at) VALUES ($1,$2,$3,'x',$4,120,$5,'t','b','claimed',$6)`,
          [`claim-dup-${RUN}`, spare.game_session_id, P.raviMain, M.ravi, DEFAULT_OFFER.id, iso(0)]),
        (err) => err.code === "23505");
    });

    await test("Existing records outside the claimed customers are preserved exactly", async () => {
      const foreignAfter = JSON.stringify(await db.query(
        "SELECT * FROM offer_claims WHERE NOT (player_id = ANY($1)) ORDER BY claim_id", [allPlayers]));
      assert.strictEqual(foreignAfter, foreignBefore);
      assert.strictEqual(JSON.stringify(await db.query("SELECT * FROM players ORDER BY player_id")), playersBefore, "no customer created or changed");
      const typed = await claimsFor([P.typed]);
      assert.deepStrictEqual([typed.length, typed[0].claim_status], [1, "unlocked"], "unverified legacy claim untouched");
    });

    await test("Dashboard: one mobile search bar, Claim buttons without extra inputs, script parses", async () => {
      const res = await request("GET", "/admin/game-analytics");
      assert.strictEqual(res.status, 200);
      const html = res.text;
      const section = html.slice(html.indexOf('id="customer-offers-panel"'), html.indexOf("Global Top 10 Leaderboard"));
      assert.strictEqual((section.match(/<input/g) || []).length, 1, "exactly one input: the mobile search");
      assert.ok(section.includes('placeholder="Search by mobile number..."'));
      assert.ok(!section.includes("<select"), "no status dropdown");
      assert.ok(!html.includes("claim-mobile"), "no mobile input beside Claim");
      assert.ok(html.includes("data-claim-customer") && html.includes("/api/admin/offers/claim"));
      [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m) => new Function(m[1]));
    });
  } finally {
    await cleanup();
  }

  console.log("=================================================");
  console.log(`CUSTOMER OFFER TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch (_) {}
  process.exit(1);
});
