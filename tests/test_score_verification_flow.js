/**
 * Game Over score verification — server (HTTP) + real browser (headless Chrome via CDP).
 *
 * Regression for: a score of 100 showed "Congratulations! You've unlocked a reward" and
 * UNLOCK MY OFFER, then "Score verification in progress. Please try again."
 * Root cause: POST /api/game/start failed with a foreign-key error for newly signed-in players
 * (no players row yet), so no game session existed, the score was never verified, and the
 * client showed the unlock UI from the browser's own score.
 *
 * Verifies:
 *  1. /api/game/start works for a brand-new OTP player and never overwrites an existing profile,
 *  2. scores 99 / 100 / 150 are verified server-side; only 100+ can be claimed,
 *  3. resending a submission for the same session is idempotent (stored score returned, payload
 *     ignored, no second leaderboard row or game count), also under concurrent duplicates,
 *  4. the browser shows a pending state until the server verifies; the unlock message and button
 *     appear only after verification; failures show an error and a Retry that reuses the same
 *     session (no duplicate score even when the first response was lost),
 *  5. after verification at 100 the offer can be claimed without the old error.
 *
 * Requires TEST_DATABASE_URL (see tests/require_test_database.js) and Google Chrome.
 */
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
require("./require_test_database");

const PORT = 3089;
process.env.PORT = String(PORT);
const server = require("../server");
const db = require("../db");
const BASE = `http://localhost:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9237;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`• ${name}... `);
  try { await fn(); passed++; console.log("PASSED ✓"); }
  catch (e) { failed++; console.log("FAILED ✗"); console.log("  " + (e && e.stack || e)); }
}

const createdPlayers = [];
async function newSignedInPlayer(mobileSuffix) {
  const playerId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  await db.query(
    "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
    [crypto.createHash("sha256").update(token).digest("hex"), playerId, `9198765666${mobileSuffix}`, now.toISOString(), new Date(now.getTime() + 864e5).toISOString()]);
  createdPlayers.push(playerId);
  return { playerId, cookie: `soofi_player_session=${token}`, token };
}

async function api(method, urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const submitBody = (sessionId, score, extra = {}) => ({
  displayName: "Tester", score, foodCaught: score, missedCount: 5, durationSeconds: Math.max(60, Math.ceil(score / 2)),
  events: [], gameSessionId: sessionId, ...extra
});
const rowsForSession = async (sessionId) => Number((await db.queryOne(
  "SELECT COUNT(*) AS n FROM leaderboard WHERE game_session_id = $1", [sessionId])).n);

async function cleanup() {
  if (!createdPlayers.length) return;
  await db.query("DELETE FROM offer_claims WHERE player_id = ANY($1)", [createdPlayers]);
  await db.query("DELETE FROM analytics_events WHERE player_id = ANY($1)", [createdPlayers]);
  await db.query("DELETE FROM leaderboard WHERE player_id = ANY($1)", [createdPlayers]);
  await db.query("DELETE FROM game_sessions WHERE player_id = ANY($1)", [createdPlayers]);
  await db.query("DELETE FROM player_sessions WHERE player_id = ANY($1)", [createdPlayers]);
  await db.query("DELETE FROM players WHERE player_id = ANY($1)", [createdPlayers]);
}

// ---------------------------------------------------------------------------
// Minimal CDP client with request interception (Fetch domain).
// ---------------------------------------------------------------------------
function getJson(u) {
  return new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
}

async function openBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "score-verify-"));
  const chrome = spawn(CHROME_PATH, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"]);
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`); break; } catch (_) { await wait(250); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  let id = 1;
  const callbacks = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) { callbacks.get(msg.id)(msg); callbacks.delete(msg.id); }
    if (msg.method) listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = id++; callbacks.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result ? r.result.result.value : undefined;
  };
  const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 100) { if (await evaluate(expr)) return true; await wait(100); } return false; };
  return { chrome, ws, send, evaluate, until, on: (fn) => listeners.push(fn) };
}

const UI = `(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.offsetParent !== null;
  const status = document.getElementById("score-verify-status");
  return {
    pendingVisible: vis(status) && !status.classList.contains("is-failed"),
    failedVisible: vis(status) && status.classList.contains("is-failed"),
    statusText: document.getElementById("score-verify-text").textContent,
    retryVisible: vis(document.getElementById("score-verify-retry")),
    unlockBannerVisible: vis(document.getElementById("reward-unlock-banner")),
    unlockBtnVisible: vis(document.getElementById("unlock-offer-btn")),
    lockedVisible: vis(document.getElementById("reward-locked-wrap")),
    summary: document.getElementById("reward-score-summary").textContent,
    score: document.getElementById("reward-score-number").textContent,
    unlockError: document.getElementById("unlock-offer-error").textContent,
    pageText: document.body.innerText
  };
})()`;

(async () => {
  console.log("=================================================");
  console.log("GAME OVER SCORE VERIFICATION TESTS");
  console.log("=================================================");
  await server.dbReadyPromise;

  try {
    // -------------------------------------------------------------------------
    // Server
    // -------------------------------------------------------------------------
    await test("POST /api/game/start works for a brand-new OTP player (no players row yet)", async () => {
      const p = await newSignedInPlayer("01");
      assert.strictEqual(await db.queryOne("SELECT 1 FROM players WHERE player_id = $1", [p.playerId]), null);
      const res = await api("POST", "/api/game/start", {}, p.cookie);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.ok(res.json.gameSessionId);
      const row = await db.queryOne("SELECT display_name, profile_name, highest_score, total_games FROM players WHERE player_id = $1", [p.playerId]);
      assert.deepStrictEqual([row.profile_name, row.highest_score, row.total_games], [null, 0, 0]);
    });

    await test("Game start never overwrites an existing player profile", async () => {
      const p = await newSignedInPlayer("02");
      const t = new Date().toISOString();
      await db.query("INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at) VALUES ($1,'Zara','Zara',140,3,$2,$2)", [p.playerId, t]);
      assert.strictEqual((await api("POST", "/api/game/start", {}, p.cookie)).status, 200);
      const row = await db.queryOne("SELECT display_name, profile_name, highest_score, total_games FROM players WHERE player_id = $1", [p.playerId]);
      assert.deepStrictEqual([row.display_name, row.profile_name, row.highest_score, row.total_games], ["Zara", "Zara", 140, 3]);
    });

    for (const [score, claimable] of [[99, false], [100, true], [150, true]]) {
      await test(`Score ${score}: verified by the server; offer claim ${claimable ? "allowed" : "refused"}`, async () => {
        const p = await newSignedInPlayer(String(score).padStart(2, "0").slice(-2) === "00" ? "10" : String(score).slice(-2));
        const start = await api("POST", "/api/game/start", {}, p.cookie);
        const sid = start.json.gameSessionId;
        const sub = await api("POST", "/api/leaderboard", submitBody(sid, score), p.cookie);
        assert.strictEqual(sub.status, 201, JSON.stringify(sub.json));
        assert.strictEqual(sub.json.verifiedScore, score);
        const claim = await api("POST", "/api/offers/claim", { gameSessionId: sid, fullName: "Tester Name" }, p.cookie);
        if (claimable) assert.ok([200, 201].includes(claim.status), JSON.stringify(claim.json));
        else assert.strictEqual(claim.status, 403);
      });
    }

    await test("Resending a submission is idempotent: stored score returned, payload ignored, nothing duplicated", async () => {
      const p = await newSignedInPlayer("20");
      const sid = (await api("POST", "/api/game/start", {}, p.cookie)).json.gameSessionId;
      assert.strictEqual((await api("POST", "/api/leaderboard", submitBody(sid, 100), p.cookie)).status, 201);
      const before = await db.queryOne("SELECT highest_score, total_games FROM players WHERE player_id = $1", [p.playerId]);
      const again = await api("POST", "/api/leaderboard", submitBody(sid, 100), p.cookie);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual([again.json.alreadySubmitted, again.json.verifiedScore, again.json.gameSessionId], [true, 100, sid]);
      const tampered = await api("POST", "/api/leaderboard", submitBody(sid, 900), p.cookie);
      assert.strictEqual(tampered.json.verifiedScore, 100, "a resend can never change the verified score");
      assert.strictEqual(await rowsForSession(sid), 1);
      const after = await db.queryOne("SELECT highest_score, total_games FROM players WHERE player_id = $1", [p.playerId]);
      assert.deepStrictEqual(after, before, "games count and best score unchanged by resends");
    });

    await test("Concurrent duplicate submissions store exactly one score", async () => {
      const p = await newSignedInPlayer("30");
      const sid = (await api("POST", "/api/game/start", {}, p.cookie)).json.gameSessionId;
      const results = await Promise.all(Array.from({ length: 6 }, () => api("POST", "/api/leaderboard", submitBody(sid, 120), p.cookie)));
      results.forEach((r) => assert.ok([200, 201, 429].includes(r.status), `unexpected ${r.status}`));
      assert.strictEqual(results.filter((r) => r.status === 201).length, 1, "exactly one stored submission");
      assert.strictEqual(await rowsForSession(sid), 1);
      const confirm = await api("POST", "/api/leaderboard", submitBody(sid, 120), p.cookie);
      assert.deepStrictEqual([confirm.status, confirm.json.verifiedScore], [200, 120]);
    });

    await test("A game session cannot be used by another player", async () => {
      const owner = await newSignedInPlayer("40");
      const other = await newSignedInPlayer("41");
      const sid = (await api("POST", "/api/game/start", {}, owner.cookie)).json.gameSessionId;
      await api("POST", "/api/game/start", {}, other.cookie); // other has a players row too
      const res = await api("POST", "/api/leaderboard", submitBody(sid, 150), other.cookie);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(await rowsForSession(sid), 0);
    });

    // -------------------------------------------------------------------------
    // Browser
    // -------------------------------------------------------------------------
    const b = await openBrowser();
    try {
      // Interception of POST /api/leaderboard: "pass" | "hold" | "fail" | "dropResponse".
      let mode = "pass";
      const held = [];
      b.on((msg) => {
        if (msg.method !== "Fetch.requestPaused") return;
        const { requestId, responseStatusCode } = msg.params;
        const isResponseStage = responseStatusCode !== undefined;
        if (mode === "fail" && !isResponseStage) return b.send("Fetch.failRequest", { requestId, errorReason: "ConnectionFailed" });
        if (mode === "dropResponse" && isResponseStage) return b.send("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" });
        if (mode === "hold" && !isResponseStage) { held.push(requestId); return; }
        return b.send("Fetch.continueRequest", { requestId });
      });
      await b.send("Page.enable");
      await b.send("Network.enable");
      await b.send("Fetch.enable", { patterns: [
        { urlPattern: "*/api/leaderboard", requestStage: "Request" },
        { urlPattern: "*/api/leaderboard", requestStage: "Response" }
      ] });
      await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

      const signInBrowser = async (suffix) => {
        const p = await newSignedInPlayer(suffix);
        await b.send("Network.clearBrowserCookies");
        await b.send("Network.setCookie", { name: "soofi_player_session", value: p.token, url: BASE });
        await b.send("Page.navigate", { url: BASE + "/" });
        await b.until(`!!window.__soofiGame && document.body.classList.contains("is-authenticated")`);
        await b.evaluate(`try { sessionStorage.clear(); } catch (_) {}`);
        return p;
      };
      // Plays a round ending at the given score through the real end-of-game path (dev hook).
      const playRound = (target) => b.evaluate(`window.__soofiGame.testOfferUnlock(${target})`);
      const sessionOf = async () => b.evaluate(`window.__soofiGame.getState().currentGameSessionId`);

      await test("Browser, score 100 (new player's first game): pending state first, unlock only after verification", async () => {
        const p = await signInBrowser("50");
        mode = "hold";
        await playRound(100);
        await b.until(`document.getElementById("score-verify-status").offsetParent !== null`);
        await wait(300);
        const pending = await b.evaluate(UI);
        assert.strictEqual(pending.pendingVisible, true, "loading state while verification is pending");
        assert.strictEqual(pending.unlockBannerVisible, false, "no unlock message before verification");
        assert.strictEqual(pending.unlockBtnVisible, false, "no UNLOCK MY OFFER before verification");
        assert.ok(!/unlocked a reward/i.test(pending.pageText));
        assert.ok(!/verification in progress/i.test(pending.pageText));
        mode = "pass";
        while (held.length) await b.send("Fetch.continueRequest", { requestId: held.shift() });
        await b.until(`document.getElementById("unlock-offer-btn").offsetParent !== null`);
        const done = await b.evaluate(UI);
        assert.deepStrictEqual([done.pendingVisible, done.failedVisible, done.unlockBannerVisible, done.unlockBtnVisible, done.score],
          [false, false, true, true, "100"]);
        assert.strictEqual(done.summary, "Congratulations! You've unlocked a reward.");
        assert.ok(!/verification in progress/i.test(done.pageText), "the old error never appears");
        assert.strictEqual(await rowsForSession(await sessionOf()), 1);
        assert.ok(await db.queryOne("SELECT 1 FROM players WHERE player_id = $1", [p.playerId]));
      });

      await test("Browser, score 100: UNLOCK MY OFFER claims the offer (no verification error)", async () => {
        await b.evaluate(`document.getElementById("unlock-offer-btn").click()`);
        await b.until(`document.getElementById("claim-modal").classList.contains("is-open") || document.getElementById("reward-offer-card").style.display === "flex"`);
        if (await b.evaluate(`document.getElementById("claim-modal").classList.contains("is-open")`)) {
          await b.evaluate(`(() => { document.getElementById("claim-name").value = "Verified Tester"; document.getElementById("claim-form").requestSubmit(); })()`);
        }
        assert.ok(await b.until(`document.getElementById("reward-offer-card").style.display === "flex"`), "offer revealed");
        const ui = await b.evaluate(UI);
        assert.ok(!/verification in progress/i.test(ui.pageText));
        assert.ok(/YOUR OFFER IS UNLOCKED/i.test(ui.pageText));
      });

      await test("Browser, score 99: locked result only after verification", async () => {
        await signInBrowser("51");
        await playRound(99);
        await b.until(`document.getElementById("reward-locked-wrap").offsetParent !== null`);
        const ui = await b.evaluate(UI);
        assert.deepStrictEqual([ui.lockedVisible, ui.unlockBannerVisible, ui.pendingVisible, ui.score], [true, false, false, "99"]);
        assert.strictEqual(ui.summary, "Reach 100 points to unlock your reward!");
      });

      await test("Browser, score 150: unlocked after verification", async () => {
        await signInBrowser("52");
        await playRound(150);
        await b.until(`document.getElementById("unlock-offer-btn").offsetParent !== null`);
        const ui = await b.evaluate(UI);
        assert.deepStrictEqual([ui.unlockBtnVisible, ui.lockedVisible, ui.score], [true, false, "150"]);
      });

      await test("Browser, network failure: clear error + Retry; retry verifies with the same session", async () => {
        await signInBrowser("53");
        mode = "fail";
        await playRound(120);
        await b.until(`document.getElementById("score-verify-status").classList.contains("is-failed")`);
        const failedUi = await b.evaluate(UI);
        assert.deepStrictEqual([failedUi.failedVisible, failedUi.retryVisible, failedUi.unlockBtnVisible, failedUi.lockedVisible], [true, true, false, false]);
        assert.ok(/network error/i.test(failedUi.statusText), failedUi.statusText);
        const sid = await sessionOf();
        assert.strictEqual(await rowsForSession(sid), 0);
        mode = "pass";
        await b.evaluate(`document.getElementById("score-verify-retry").click()`);
        await b.until(`document.getElementById("unlock-offer-btn").offsetParent !== null`);
        assert.strictEqual(await sessionOf(), sid, "retry reused the round's session");
        assert.strictEqual(await rowsForSession(sid), 1);
        const sessions = Number((await db.queryOne("SELECT COUNT(*) n FROM game_sessions WHERE session_id = $1 AND used_at IS NOT NULL", [sid])).n);
        assert.strictEqual(sessions, 1);
      });

      await test("Browser, response lost after the server saved the score: Retry shows it without a duplicate", async () => {
        const p = await signInBrowser("54");
        mode = "dropResponse";
        await playRound(130);
        await b.until(`document.getElementById("score-verify-status").classList.contains("is-failed")`);
        const sid = await sessionOf();
        assert.strictEqual(await rowsForSession(sid), 1, "server already stored the score");
        mode = "pass";
        await b.evaluate(`document.getElementById("score-verify-retry").click()`);
        await b.until(`document.getElementById("unlock-offer-btn").offsetParent !== null`);
        const ui = await b.evaluate(UI);
        assert.strictEqual(ui.score, "130");
        assert.strictEqual(await rowsForSession(sid), 1, "no duplicate score");
        const total = Number((await db.queryOne("SELECT total_games FROM players WHERE player_id = $1", [p.playerId])).total_games);
        assert.strictEqual(total, 1);
      });

      await test("Browser, double-clicking Retry sends one verification at a time", async () => {
        await signInBrowser("55");
        mode = "fail";
        await playRound(110);
        await b.until(`document.getElementById("score-verify-status").classList.contains("is-failed")`);
        mode = "pass";
        await b.evaluate(`(() => { const r = document.getElementById("score-verify-retry"); r.click(); r.click(); r.click(); })()`);
        await b.until(`document.getElementById("unlock-offer-btn").offsetParent !== null`);
        assert.strictEqual(await rowsForSession(await sessionOf()), 1);
      });

      await test("Browser, refresh on the result screen re-confirms with the server (no duplicate)", async () => {
        const sid = await sessionOf();
        await b.send("Page.reload");
        await b.until(`!!window.__soofiGame && document.body.classList.contains("is-authenticated") && document.getElementById("unlock-offer-btn").offsetParent !== null`);
        const ui = await b.evaluate(UI);
        assert.deepStrictEqual([ui.unlockBtnVisible, ui.score], [true, "110"]);
        assert.strictEqual(await rowsForSession(sid), 1);
      });
    } finally {
      try { b.ws.close(); } catch (_) {}
      try { b.chrome.kill(); } catch (_) {}
    }
  } finally {
    await cleanup();
  }

  console.log("=================================================");
  console.log(`SCORE VERIFICATION TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch (_) {}
  process.exit(1);
});
