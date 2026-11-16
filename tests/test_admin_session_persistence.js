/**
 * Admin Panel session persistence — real browser (headless Chrome via CDP) + HTTP checks.
 *
 * Verifies that the cookie-based admin session:
 *  1. survives a page refresh and opening the dashboard in a new tab,
 *  2. is never readable from JavaScript nor stored in localStorage/sessionStorage,
 *  3. falls back to the password screen when expired, invalid or revoked mid-session,
 *  4. is revoked server-side by Log Out (old cookie cannot be replayed),
 *  5. never authorizes admin-only APIs without a valid session.
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

const PORT = 3092;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = "admin_session_test_pw_2026";
const server = require("../server");
const db = require("../db");

const BASE = `http://localhost:${PORT}`;
const ADMIN_URL = `${BASE}/admin/game-analytics`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9226;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

function httpRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(new URL(urlPath, BASE), {
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers }
        : headers
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      msg.error ? cb.reject(new Error(JSON.stringify(msg.error))) : cb.resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = id++;
    callbacks.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const evalExpr = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("Eval failed: " + JSON.stringify(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, eval: evalExpr, close: () => { try { ws.close(); } catch (_) {} } });
    ws.onerror = reject;
  });
}

async function openPage(browser, url) {
  const target = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await createCdpSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  page.targetId = target.targetId;
  await page.send("Page.navigate", { url });
  return page;
}

// Polls until the dashboard settles on "login" or "dashboard".
async function waitForView(page, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let view = "";
  while (Date.now() < deadline) {
    try {
      view = await page.eval(`(() => {
        const l = document.getElementById("login-section");
        const d = document.getElementById("dashboard-section");
        if (!l || !d) return "loading";
        if (d.style.display === "block" && l.style.display === "none") return "dashboard";
        if (l.style.display === "flex" && d.style.display === "none") return "login";
        return "pending";
      })()`);
    } catch (_) { view = "loading"; }
    if (view === expected) return view;
    await wait(100);
  }
  throw new Error(`Expected "${expected}" view, still "${view}"`);
}

async function loginViaUi(page, password) {
  await page.eval(`(() => {
    document.getElementById("admin-pass-input").value = ${JSON.stringify(password)};
    document.getElementById("admin-login-btn").click();
  })()`);
}

async function getAdminCookie(page) {
  const { cookies } = await page.send("Network.getCookies", { urls: [BASE] });
  return cookies.find(c => c.name === "soofi_admin_session") || null;
}

async function reload(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await wait(300);
}

async function main() {
  let passed = 0;
  let failed = 0;
  const createdHashes = new Set();
  async function test(name, fn) {
    process.stdout.write(`• ${name}... `);
    try { await fn(); console.log("PASSED ✓"); passed++; }
    catch (err) { console.log("FAILED ✗"); console.error("  Error:", err.message); failed++; }
  }

  await server.dbReadyPromise;
  await wait(250);

  // ---------------------------------------------------------------------------
  // HTTP-level: unauthorized access to every admin-only API
  // ---------------------------------------------------------------------------
  await test("Admin-only APIs reject requests without a valid session", async () => {
    const bogus = { Cookie: `soofi_admin_session=${crypto.randomBytes(32).toString("hex")}` };
    for (const headers of [{}, bogus, { Authorization: "Bearer " + crypto.randomBytes(32).toString("hex") }]) {
      assert.strictEqual((await httpRequest("GET", "/api/admin/analytics/overview", null, headers)).status, 401);
      assert.strictEqual((await httpRequest("GET", "/api/admin/analytics/events", null, headers)).status, 401);
      assert.strictEqual((await httpRequest("GET", "/api/admin/analytics/player/someone", null, headers)).status, 401);
      assert.strictEqual((await httpRequest("POST", "/api/config/features", { features: {} }, { Origin: BASE, ...headers })).status, 401);
      assert.strictEqual((await httpRequest("GET", "/api/admin/session", null, headers)).status, 401);
    }
  });

  // ---------------------------------------------------------------------------
  // Browser flows
  // ---------------------------------------------------------------------------
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "soofi-admin-session-"));
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-sandbox", "--disable-gpu",
    `--user-data-dir=${userDataDir}`
  ]);
  let browser = null;
  try {
    let versionInfo = null;
    for (let i = 0; i < 40 && !versionInfo; i++) {
      try { versionInfo = await cdpRequest("/json/version"); } catch (_) { await wait(250); }
    }
    if (!versionInfo) throw new Error("Chrome DevTools endpoint did not start");
    browser = await createCdpSession(versionInfo.webSocketDebuggerUrl);
    const page = await openPage(browser, ADMIN_URL);
    let firstCookieValue = "";

    await test("Fresh visit shows the password screen; wrong password is rejected", async () => {
      await waitForView(page, "login");
      await loginViaUi(page, "definitely_wrong_password");
      await wait(600);
      await waitForView(page, "login");
      const err = await page.eval(`document.getElementById("login-error").textContent`);
      assert.ok(/invalid/i.test(err), `expected invalid-password error, got "${err}"`);
      assert.strictEqual(await getAdminCookie(page), null);
    });

    await test("Correct password opens the dashboard with an HttpOnly cookie and no web-storage token", async () => {
      await loginViaUi(page, process.env.ADMIN_PASSWORD);
      await waitForView(page, "dashboard");
      const cookie = await getAdminCookie(page);
      assert.ok(cookie, "admin cookie must be set");
      assert.strictEqual(cookie.httpOnly, true, "cookie must be HttpOnly");
      assert.strictEqual(cookie.sameSite, "Strict", "cookie must be SameSite=Strict");
      assert.strictEqual(cookie.session, false, "cookie must be persistent (Max-Age), not tab-scoped");
      firstCookieValue = cookie.value;
      createdHashes.add(sha256(firstCookieValue));
      const jsVisible = await page.eval(`document.cookie.includes("soofi_admin_session")`);
      assert.strictEqual(jsVisible, false, "cookie must not be readable from JavaScript");
      const storageDump = await page.eval(`JSON.stringify({ l: Object.assign({}, localStorage), s: Object.assign({}, sessionStorage) })`);
      assert.ok(!storageDump.includes(firstCookieValue), "token must not be in web storage");
      assert.ok(!/admin_token/i.test(storageDump), "no admin token keys in web storage");
    });

    await test("Refreshing the page keeps the admin on the dashboard", async () => {
      for (let i = 0; i < 2; i++) {
        await reload(page);
        await waitForView(page, "dashboard");
      }
      let claims = "-";
      for (let i = 0; i < 50 && claims === "-"; i++) {
        claims = await page.eval(`document.getElementById("metric-claims").textContent`);
        if (claims === "-") await wait(100);
      }
      assert.notStrictEqual(claims, "-", "dashboard metrics must load after refresh");
    });

    await test("Opening the dashboard in a new tab reuses the session", async () => {
      const tab = await openPage(browser, ADMIN_URL);
      await waitForView(tab, "dashboard");
      tab.close();
      await browser.send("Target.closeTarget", { targetId: tab.targetId });
    });

    await test("An expired session shows the password screen on refresh", async () => {
      await db.query("UPDATE admin_sessions SET expires_at = $1 WHERE session_token = $2",
        [new Date(Date.now() - 60 * 1000).toISOString(), sha256(firstCookieValue)]);
      await reload(page);
      await waitForView(page, "login");
      assert.strictEqual(await getAdminCookie(page), null, "stale cookie must be cleared");
    });

    await test("An invalid/tampered session cookie shows the password screen", async () => {
      await page.send("Network.setCookie", {
        name: "soofi_admin_session", value: crypto.randomBytes(32).toString("hex"),
        url: BASE, httpOnly: true, sameSite: "Strict"
      });
      await reload(page);
      await waitForView(page, "login");
      assert.strictEqual(await getAdminCookie(page), null, "invalid cookie must be cleared");
    });

    await test("A session revoked while the dashboard is open returns to login on the next admin call", async () => {
      await loginViaUi(page, process.env.ADMIN_PASSWORD);
      await waitForView(page, "dashboard");
      const cookie = await getAdminCookie(page);
      createdHashes.add(sha256(cookie.value));
      await db.query("DELETE FROM admin_sessions WHERE session_token = $1", [sha256(cookie.value)]);
      // Trigger an admin-only API call (Customer Offer Management mobile search).
      await page.eval(`(() => { const el = document.getElementById("offer-search-input"); el.value = "98765"; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await waitForView(page, "login");
      const msg = await page.eval(`document.getElementById("login-error").textContent`);
      assert.ok(/expired/i.test(msg), `expected session-expired message, got "${msg}"`);
    });

    await test("Log Out revokes the session server-side; refresh and cookie replay stay logged out", async () => {
      await loginViaUi(page, process.env.ADMIN_PASSWORD);
      await waitForView(page, "dashboard");
      const cookie = await getAdminCookie(page);
      createdHashes.add(sha256(cookie.value));
      await page.eval(`document.getElementById("logout-btn").click()`);
      await waitForView(page, "login");
      assert.strictEqual(await getAdminCookie(page), null, "logout must clear the cookie");
      const row = await db.queryOne("SELECT 1 AS hit FROM admin_sessions WHERE session_token = $1", [sha256(cookie.value)]);
      assert.ok(!row, "logout must delete the session row");
      await reload(page);
      await waitForView(page, "login");
      const replay = await httpRequest("GET", "/api/admin/analytics/overview", null, { Cookie: `soofi_admin_session=${cookie.value}` });
      assert.strictEqual(replay.status, 401, "revoked cookie must not authorize admin APIs");
    });

    page.close();
  } catch (err) {
    console.error("Browser testing error:", err.message);
    failed++;
  } finally {
    if (browser) browser.close();
    try { process.kill(chrome.pid); } catch (_) {}
    for (const hash of createdHashes) {
      try { await db.query("DELETE FROM admin_sessions WHERE session_token = $1", [hash]); } catch (_) {}
    }
  }

  console.log("\n=================================================");
  console.log(`ADMIN SESSION TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
