/**
 * Dev Controls: localhost-only, blocked in production (client AND server).
 *
 * Production is simulated exactly as Netlify runs it: `NETLIFY=true` with NODE_ENV unset
 * (Netlify Functions do not set NODE_ENV=production). Local development is the in-process
 * server (NODE_ENV=test). Both use the dedicated test database.
 *
 *  HTTP  - production HTML has no Dev Controls markup; dev score injection (isDevTest) is
 *          refused with 403 in production and still works locally; source/tests/data/.env
 *          are never served; normal score submission, admin login, OTP and claim routes
 *          stay available.
 *  Browser (headless Chrome) - on localhost the panel is visible and its Score button works;
 *          on a non-local hostname served by the production server the panel and the
 *          window.__soofiGame test hooks do not exist, while the homepage renders normally
 *          (desktop and mobile).
 *
 * Requires TEST_DATABASE_URL (see tests/require_test_database.js) and Google Chrome.
 */
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
require("./require_test_database");

const DEV_PORT = 3089;
const PROD_PORT = 3088;
process.env.PORT = String(DEV_PORT);
const server = require("../server");
const db = require("../db");
const { createPlayerSession, deletePlayerSessions, ensurePlayer } = require("./pg_test_helpers");

const DEV_ORIGIN = `http://localhost:${DEV_PORT}`;
const PROD_ORIGIN = `https://localhost:${PROD_PORT}`; // production same-origin checks expect HTTPS
const PROD_HOSTNAME = "soofi-prod.test";             // non-local hostname mapped to 127.0.0.1 in Chrome
const PROD_ADMIN_PASSWORD = "prod_mode_admin_secret_2026";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9228;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function request(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: "localhost", port, path: urlPath, method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers } : headers
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, body: data, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForPort(port) {
  for (let i = 0; i < 60; i++) {
    try { await request(port, "GET", "/api/leaderboard"); return; } catch (_) { await wait(250); }
  }
  throw new Error(`server on ${port} did not start`);
}

function cdpRequest(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}${endpoint}`, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(data); } });
    }).on("error", reject);
  });
}

function createCdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const callbacks = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      msg.error ? cb.reject(new Error(JSON.stringify(msg.error))) : cb.resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = id++;
    callbacks.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  const evalExpr = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("Eval failed: " + JSON.stringify(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, on, eval: evalExpr, close: () => { try { ws.close(); } catch (_) {} } });
    ws.onerror = reject;
  });
}

async function waitFor(page, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expression)) return; } catch (_) {}
    await wait(100);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    process.stdout.write(`• ${name}... `);
    try { await fn(); console.log("PASSED ✓"); passed++; }
    catch (err) { console.log("FAILED ✗"); console.error("  Error:", err.message); failed++; }
  }

  await server.dbReadyPromise;

  // Production-mode server exactly as Netlify runs it (no NODE_ENV=production).
  const prodEnv = { ...process.env, PORT: String(PROD_PORT), NETLIFY: "true", ADMIN_PASSWORD: PROD_ADMIN_PASSWORD };
  delete prodEnv.NODE_ENV;
  delete prodEnv.LOCAL_DEV;
  delete prodEnv.SERVERLESS;
  const prodServer = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: prodEnv, stdio: "ignore" });

  const sessionHashes = [];
  const playerIds = [];
  let chrome = null;
  let browser = null;

  try {
    await waitForPort(DEV_PORT);
    await waitForPort(PROD_PORT);

    async function signedInPlayer(origin) {
      const playerId = `test-devctl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      playerIds.push(playerId);
      await ensurePlayer(db, playerId, "DevCtl Tester");
      const { headers } = await createPlayerSession(db, playerId, { origin, trackHash: sessionHashes });
      return headers;
    }

    async function startGameSession(port, headers) {
      const res = await request(port, "POST", "/api/game/start", {}, headers);
      assert.strictEqual(res.status, 200, `game start failed: ${res.status} ${res.body}`);
      return res.json.gameSessionId;
    }

    // -------------------------------------------------------------------------
    // HTTP: production
    // -------------------------------------------------------------------------
    await test("Production HTML contains no Dev Controls markup (and the page is intact)", async () => {
      for (const p of ["/", "/index.html"]) {
        const res = await request(PROD_PORT, "GET", p);
        assert.strictEqual(res.status, 200);
        assert.ok(!res.body.includes("dev-test-panel"), `${p} must not contain the dev panel`);
        assert.ok(!res.body.includes("dev-btn-score-121"), `${p} must not contain dev score buttons`);
        assert.ok(!/DEV CONTROLS/i.test(res.body), `${p} must not mention Dev Controls`);
        assert.ok(res.body.includes("hud-pause-btn") && res.body.includes("login-screen") && res.body.includes("app.js"),
          "the normal page must be served whole");
      }
    });

    await test("Production refuses dev score injection (isDevTest) server-side with 403", async () => {
      const headers = await signedInPlayer(PROD_ORIGIN);
      const gameSessionId = await startGameSession(PROD_PORT, headers);
      const res = await request(PROD_PORT, "POST", "/api/leaderboard", {
        displayName: "Injector", score: 150, foodCaught: 150, missedCount: 5, durationSeconds: 60,
        isDevTest: true, gameSessionId
      }, headers);
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status} ${res.body}`);
      const row = await db.queryOne("SELECT 1 AS hit FROM leaderboard WHERE game_session_id = $1", [gameSessionId]);
      assert.ok(!row, "no leaderboard row may be written");
      const sess = await db.queryOne("SELECT used_at FROM game_sessions WHERE session_id = $1", [gameSessionId]);
      assert.ok(sess && sess.used_at === null, "the game session must not be consumed");
    });

    await test("Production still accepts a normal (non-dev) score submission", async () => {
      const headers = await signedInPlayer(PROD_ORIGIN);
      const gameSessionId = await startGameSession(PROD_PORT, headers);
      const res = await request(PROD_PORT, "POST", "/api/leaderboard", {
        displayName: "Legit", score: 3, foodCaught: 3, missedCount: 5, durationSeconds: 12, gameSessionId
      }, headers);
      assert.ok(res.status === 200 || res.status === 201, `expected success, got ${res.status} ${res.body}`);
    });

    await test("Production keeps admin login, OTP and claim routes available", async () => {
      const admin = await request(PROD_PORT, "POST", "/api/admin/login", { password: PROD_ADMIN_PASSWORD }, { Origin: PROD_ORIGIN });
      assert.strictEqual(admin.status, 200, `admin login: ${admin.status} ${admin.body}`);
      const setCookie = [].concat(admin.headers["set-cookie"] || []).find(c => c.startsWith("soofi_admin_session=")) || "";
      assert.ok(/;\s*Secure/i.test(setCookie), "production admin cookie must be Secure");
      const rawToken = setCookie.split(";")[0].split("=")[1];
      await db.query("DELETE FROM admin_sessions WHERE session_token = encode(sha256($1::bytea), 'hex')", [rawToken]);

      const otp = await request(PROD_PORT, "POST", "/api/auth/msg91", {}, { Origin: PROD_ORIGIN });
      assert.ok(otp.status !== 404 && otp.status < 500, `OTP route must be reachable (got ${otp.status})`);
      const claim = await request(PROD_PORT, "GET", "/api/offers/claim?gameSessionId=x");
      assert.strictEqual(claim.status, 401, "claim route must be reachable and require sign-in");
    });

    // -------------------------------------------------------------------------
    // HTTP: both modes - static allowlist
    // -------------------------------------------------------------------------
    await test("Source, tests, data, migrations and .env are never served (dev and production)", async () => {
      const blocked = [
        "/.env", "/server.js", "/db.js", "/package.json", "/package-lock.json", "/README.md",
        "/tests/test_game_server.js", "/tests/pg_test_helpers.js", "/scripts/test_postgres_connection.js",
        "/data/soofi_mandi.db", "/migrations/002_neon_schema.sql", "/netlify/functions/api.js",
        "/api/index.js", "/node_modules/pg/package.json", "/%2e%2e/.env", "/assets/../server.js",
        "/game_over_score_no_100_verified.png"
      ];
      for (const port of [DEV_PORT, PROD_PORT]) {
        for (const p of blocked) {
          const res = await request(port, "GET", p);
          assert.strictEqual(res.status, 404, `${p} on port ${port} returned ${res.status}`);
        }
        for (const p of ["/", "/app.js", "/styles.css", "/game_config.js", "/offers.js", "/assets/logo.png", "/assets/mandi-bucket.png"]) {
          const res = await request(port, "GET", p);
          assert.strictEqual(res.status, 200, `${p} on port ${port} returned ${res.status}`);
        }
      }
    });

    // -------------------------------------------------------------------------
    // HTTP: local development keeps dev tooling
    // -------------------------------------------------------------------------
    await test("Local development still accepts dev score injection (isDevTest)", async () => {
      const headers = await signedInPlayer(DEV_ORIGIN);
      const gameSessionId = await startGameSession(DEV_PORT, headers);
      const res = await request(DEV_PORT, "POST", "/api/leaderboard", {
        displayName: "Dev", score: 121, foodCaught: 121, missedCount: 5, durationSeconds: 60,
        isDevTest: true, gameSessionId
      }, headers);
      assert.ok(res.status === 200 || res.status === 201, `expected success, got ${res.status} ${res.body}`);
      assert.strictEqual(res.json.verifiedScore, 121);
    });

    // -------------------------------------------------------------------------
    // Browser
    // -------------------------------------------------------------------------
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "soofi-devctl-"));
    chrome = spawn(CHROME_PATH, [
      `--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-sandbox", "--disable-gpu",
      `--host-resolver-rules=MAP ${PROD_HOSTNAME} 127.0.0.1`,
      `--user-data-dir=${userDataDir}`
    ]);
    let versionInfo = null;
    for (let i = 0; i < 40 && !versionInfo; i++) {
      try { versionInfo = await cdpRequest("/json/version"); } catch (_) { await wait(250); }
    }
    if (!versionInfo) throw new Error("Chrome DevTools endpoint did not start");
    browser = await createCdpSession(versionInfo.webSocketDebuggerUrl);

    async function openSignedIn(baseUrl, origin, viewport) {
      const target = await browser.send("Target.createTarget", { url: "about:blank" });
      const page = await createCdpSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`);
      page.targetId = target.targetId;
      page.errors = [];
      page.on("Runtime.exceptionThrown", (p) => page.errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Network.enable");
      await page.send("Emulation.setDeviceMetricsOverride", viewport);
      const headers = await signedInPlayer(origin);
      await page.send("Network.setCookie", {
        name: "soofi_player_session", value: headers.Cookie.split("=")[1], url: baseUrl, httpOnly: true, sameSite: "Lax"
      });
      await page.send("Page.navigate", { url: baseUrl + "/?dev=true" });
      await waitFor(page, `document.body && document.body.classList.contains("is-authenticated") && !document.body.classList.contains("auth-pending")`);
      return page;
    }
    async function closePage(page) {
      page.close();
      await browser.send("Target.closeTarget", { targetId: page.targetId });
    }

    const viewports = {
      desktop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
      mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    };

    for (const [name, viewport] of Object.entries(viewports)) {
      await test(`[${name}] localhost: Dev Controls are visible and functional`, async () => {
        const page = await openSignedIn(DEV_ORIGIN, DEV_ORIGIN, viewport);
        await waitFor(page, `!!document.getElementById("dev-test-panel")`);
        const display = await page.eval(`getComputedStyle(document.getElementById("dev-test-panel")).display`);
        assert.strictEqual(display, "flex", "panel must be visible on localhost");
        assert.strictEqual(await page.eval(`typeof window.__soofiGame`), "object", "test hooks available locally");
        // Feature toggle works
        await page.eval(`document.getElementById("dev-btn-all-off").click()`);
        assert.strictEqual(await page.eval(`window.__soofiGame.getFeatures().bomb`), false, "All OFF toggles features");
        await page.eval(`document.getElementById("dev-btn-all-on").click()`);
        assert.strictEqual(await page.eval(`window.__soofiGame.getFeatures().bomb`), true, "All ON toggles features");
        // Score simulation reaches the results screen
        await page.eval(`document.getElementById("dev-btn-score-80").click()`);
        await waitFor(page, `window.__soofiGame.getState().gameState !== "playing" && window.__soofiGame.getState().score === 80`);
        assert.deepStrictEqual(page.errors, [], `page errors: ${page.errors.join(" | ")}`);
        await closePage(page);
      });

      await test(`[${name}] production host: no Dev Controls, no test hooks, homepage intact`, async () => {
        const base = `http://${PROD_HOSTNAME}:${PROD_PORT}`;
        const page = await openSignedIn(base, `https://${PROD_HOSTNAME}:${PROD_PORT}`, viewport);
        await wait(500);
        assert.strictEqual(await page.eval(`document.getElementById("dev-test-panel")`), null, "no #dev-test-panel in DOM");
        assert.strictEqual(await page.eval(`document.querySelectorAll(".dev-test-panel, .dev-btn").length`), 0, "no dev elements");
        assert.strictEqual(await page.eval(`typeof window.__soofiGame`), "undefined", "test hooks must not be exposed in production");
        assert.ok(!(await page.eval(`document.body.innerText`)).includes("DEV CONTROLS"), "no Dev Controls text visible");
        const startVisible = await page.eval(`(() => { const b = document.getElementById("start-game-btn") || document.querySelector(".intro-start-btn, [data-action='start']"); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
        assert.ok(startVisible, "homepage Start Game button must be visible");
        assert.deepStrictEqual(page.errors, [], `page errors: ${page.errors.join(" | ")}`);
        await closePage(page);
      });
    }
  } catch (err) {
    console.error("Test error:", err.message);
    failed++;
  } finally {
    if (browser) browser.close();
    if (chrome) { try { process.kill(chrome.pid); } catch (_) {} }
    try { process.kill(prodServer.pid); } catch (_) {}
    try {
      await deletePlayerSessions(db, sessionHashes);
      for (const id of playerIds) {
        await db.query("DELETE FROM offer_claims WHERE player_id = $1", [id]);
        await db.query("DELETE FROM leaderboard WHERE player_id = $1", [id]);
        await db.query("DELETE FROM game_sessions WHERE player_id = $1", [id]);
        await db.query("DELETE FROM analytics_events WHERE player_id = $1", [id]);
        await db.query("DELETE FROM players WHERE player_id = $1", [id]);
      }
    } catch (err) {
      console.error("cleanup error:", err.message);
    }
  }

  console.log("\n=================================================");
  console.log(`DEV CONTROLS TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
