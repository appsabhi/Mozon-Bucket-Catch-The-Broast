/**
 * Homepage boot loader — real browser (headless Chrome via CDP), desktop + mobile.
 *
 * Verifies that refreshing the homepage never shows a blank screen:
 *  1. the branded loader ("Getting things ready...") is visible while /api/player/session is pending,
 *  2. it hands over to the login screen (signed out) or the homepage (signed in),
 *  3. a hung session request times out into the login screen instead of loading forever,
 *  4. if app.js never runs, the loader offers a Reload after 15s instead of spinning forever,
 *  5. no frame between navigation and settle is blank, and app.js boots without a ReferenceError.
 *
 * Screenshots go to $BOOT_LOADER_SCREENSHOT_DIR (default: <os tmp>/soofi-boot-loader-screens).
 * Requires TEST_DATABASE_URL (see tests/require_test_database.js) and Google Chrome.
 */
const assert = require("node:assert");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
require("./require_test_database");

const PORT = 3091;
process.env.PORT = String(PORT);
const server = require("../server");
const db = require("../db");
const { createPlayerSession, deletePlayerSessions, ensurePlayer } = require("./pg_test_helpers");

const BASE = `http://localhost:${PORT}`;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9227;
const SHOT_DIR = process.env.BOOT_LOADER_SCREENSHOT_DIR || path.join(os.tmpdir(), "soofi-boot-loader-screens");
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const VIEWPORTS = {
  desktop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
};

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

// Classifies what the user currently sees.
const VIEW_PROBE = `(() => {
  const loader = document.getElementById("app-loader");
  const login = document.getElementById("login-screen");
  const page = document.querySelector("body > .page-wrap");
  if (window.__soofiPreReload) return "old-document";
  if (!document.body || !loader) return "booting-dom";
  // Render-blocking styles.css not applied yet: the browser paints nothing in this phase.
  if (getComputedStyle(loader).position !== "fixed") return "booting-css";
  const vis = (el) => {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility !== "visible") return 0;
    return parseFloat(cs.opacity);
  };
  const loaderOpacity = vis(loader);
  const loginVisible = login && !login.hidden && vis(login) > 0;
  const pageVisible = document.body.classList.contains("is-authenticated") && vis(page) > 0;
  if (document.body.classList.contains("auth-pending")) return loaderOpacity >= 0.99 ? "loader" : "blank";
  if (loginVisible) return "login";
  if (pageVisible) return "home";
  return loaderOpacity > 0 ? "loader-fading" : "blank";
})()`;

async function main() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    process.stdout.write(`• ${name}... `);
    try { await fn(); console.log("PASSED ✓"); passed++; }
    catch (err) { console.log("FAILED ✗"); console.error("  Error:", err.message); failed++; }
  }

  await server.dbReadyPromise;
  await wait(250);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const playerId = `test-boot-loader-${Date.now()}`;
  const sessionHashes = [];
  await ensurePlayer(db, playerId, "Boot Loader");
  const { headers } = await createPlayerSession(db, playerId, { origin: BASE, trackHash: sessionHashes });
  const playerToken = headers.Cookie.split("=")[1];

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "soofi-boot-loader-"));
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`, "--headless=new", "--no-sandbox", "--disable-gpu",
    `--user-data-dir=${userDataDir}`
  ]);
  let browser = null;

  async function newPage(viewport) {
    const target = await browser.send("Target.createTarget", { url: "about:blank" });
    const page = await createCdpSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${target.targetId}`);
    page.targetId = target.targetId;
    page.errors = [];
    page.on("Runtime.exceptionThrown", (p) => page.errors.push(p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", viewport);
    if (viewport.mobile) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    return page;
  }

  async function closePage(page) {
    page.close();
    await browser.send("Target.closeTarget", { targetId: page.targetId });
  }

  async function screenshot(page, name) {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  // Intercepts requests matching `urlPattern`; `decide(requestId)` controls each one.
  async function intercept(page, urlPattern, decide) {
    page.on("Fetch.requestPaused", (p) => decide(p.requestId, p.request.url));
    await page.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Request" }] });
  }

  // Samples the view every 50ms until `settledOn` is reached; returns the observed sequence.
  async function sampleUntil(page, settledOn, timeoutMs) {
    const seen = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let view;
      try { view = await page.eval(VIEW_PROBE); } catch (_) { view = "booting-dom"; }
      if (seen[seen.length - 1] !== view) seen.push(view);
      if (view === settledOn) return seen;
      await wait(50);
    }
    throw new Error(`did not settle on "${settledOn}"; saw ${seen.join(" → ")}`);
  }

  try {
    let versionInfo = null;
    for (let i = 0; i < 40 && !versionInfo; i++) {
      try { versionInfo = await cdpRequest("/json/version"); } catch (_) { await wait(250); }
    }
    if (!versionInfo) throw new Error("Chrome DevTools endpoint did not start");
    browser = await createCdpSession(versionInfo.webSocketDebuggerUrl);

    for (const [deviceName, viewport] of Object.entries(VIEWPORTS)) {
      await test(`[${deviceName}] signed out: loader shows during verification, then the login screen`, async () => {
        const page = await newPage(viewport);
        await page.send("Network.clearBrowserCookies");
        let release;
        const held = new Promise(r => { release = r; });
        await intercept(page, "*/api/player/session*", async (requestId) => {
          await held;
          await page.send("Fetch.continueRequest", { requestId });
        });
        await page.send("Page.navigate", { url: BASE + "/" });
        await sampleUntil(page, "loader", 5000);
        await wait(500); // let the logo decode
        const text = await page.eval(`document.querySelector(".app-loader-text").textContent.trim()`);
        assert.strictEqual(text, "Getting things ready...");
        const logoOk = await page.eval(`(() => { const i = document.querySelector(".app-loader-logo"); return i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 100; })()`);
        assert.ok(logoOk, "Soofi Mandi logo must render in the loader");
        const barAnimated = await page.eval(`getComputedStyle(document.querySelector(".app-loader-bar")).animationName`);
        assert.strictEqual(barAnimated, "appLoaderSweep", "loader bar must animate");
        const noScroll = await page.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
        assert.ok(noScroll, "loader must not cause horizontal scroll");
        console.log(`\n    screenshot: ${await screenshot(page, `${deviceName}-1-loader`)}`);
        release();
        const seen = await sampleUntil(page, "login", 8000);
        assert.ok(!seen.includes("blank"), `blank frame observed: ${seen.join(" → ")}`);
        await wait(600);
        const loaderGone = await page.eval(`getComputedStyle(document.getElementById("app-loader")).visibility === "hidden"`);
        assert.ok(loaderGone, "loader must be hidden (non-interactive) after verification");
        console.log(`    screenshot: ${await screenshot(page, `${deviceName}-2-login`)}`);
        assert.deepStrictEqual(page.errors, [], `uncaught page errors: ${page.errors.join(" | ")}`);
        await closePage(page);
      });

      await test(`[${deviceName}] signed in: refreshing shows the loader, then the homepage (no blank frame)`, async () => {
        const page = await newPage(viewport);
        await page.send("Network.setCookie", { name: "soofi_player_session", value: playerToken, url: BASE, httpOnly: true, sameSite: "Lax" });
        await page.send("Page.navigate", { url: BASE + "/" });
        await sampleUntil(page, "home", 8000);
        // Refresh with a slowed-down session check, sampling every frame for blanks.
        await intercept(page, "*/api/player/session*", async (requestId) => {
          await wait(1200);
          await page.send("Fetch.continueRequest", { requestId });
        });
        await page.eval(`window.__soofiPreReload = true`);
        await page.send("Page.reload", { ignoreCache: true });
        const seen = await sampleUntil(page, "home", 8000);
        assert.ok(seen.includes("loader"), `loader should appear on refresh: ${seen.join(" → ")}`);
        assert.ok(!seen.includes("blank"), `blank frame observed: ${seen.join(" → ")}`);
        assert.ok(!seen.includes("login"), `signed-in refresh must not flash the login screen: ${seen.join(" → ")}`);
        await wait(600);
        const introActive = await page.eval(`document.getElementById("view-intro").classList.contains("is-active")`);
        assert.ok(introActive, "homepage intro should be shown");
        const hooks = await page.eval(`typeof window.__soofiGame === "object"`);
        assert.ok(hooks, "app.js must run to completion (no boot-time ReferenceError)");
        console.log(`\n    screenshot: ${await screenshot(page, `${deviceName}-3-home`)}`);
        assert.deepStrictEqual(page.errors, [], `uncaught page errors: ${page.errors.join(" | ")}`);
        await closePage(page);
      });
    }

    await test("Hung session request times out to the login screen (no infinite loading)", async () => {
      const page = await newPage(VIEWPORTS.mobile);
      await page.send("Network.clearBrowserCookies");
      await intercept(page, "*/api/player/session*", () => { /* never answer */ });
      const started = Date.now();
      await page.send("Page.navigate", { url: BASE + "/" });
      const seen = await sampleUntil(page, "login", 14000);
      const elapsed = Date.now() - started;
      assert.ok(!seen.includes("blank"), `blank frame observed: ${seen.join(" → ")}`);
      assert.ok(elapsed >= 9000 && elapsed < 13000, `expected ~10s timeout, got ${elapsed}ms`);
      const msg = await page.eval(`document.getElementById("login-error").textContent`);
      assert.ok(/couldn't verify/i.test(msg), `expected connection message, got "${msg}"`);
      console.log(`\n    screenshot: ${await screenshot(page, "mobile-4-timeout-login")}`);
      await closePage(page);
    });

    await test("If app.js never loads, the loader offers Reload after 15s instead of spinning forever", async () => {
      const page = await newPage(VIEWPORTS.desktop);
      await intercept(page, "*/app.js*", async (requestId) => {
        await page.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
      });
      await page.send("Page.navigate", { url: BASE + "/" });
      await sampleUntil(page, "loader", 5000);
      const early = await page.eval(`getComputedStyle(document.querySelector(".app-loader-slow")).display`);
      assert.strictEqual(early, "none", "reload hint must stay hidden in the normal case");
      await wait(15500);
      const slowShown = await page.eval(`getComputedStyle(document.querySelector(".app-loader-slow")).display`);
      assert.strictEqual(slowShown, "flex", "reload hint must appear after 15s");
      console.log(`\n    screenshot: ${await screenshot(page, "desktop-5-slow-reload")}`);
      await closePage(page);
    });
  } catch (err) {
    console.error("Browser testing error:", err.message);
    failed++;
  } finally {
    if (browser) browser.close();
    try { process.kill(chrome.pid); } catch (_) {}
    try {
      await deletePlayerSessions(db, sessionHashes);
      await db.query("DELETE FROM analytics_events WHERE player_id = $1", [playerId]);
      await db.query("DELETE FROM players WHERE player_id = $1", [playerId]);
    } catch (_) {}
  }

  console.log("\n=================================================");
  console.log(`BOOT LOADER TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log(`Screenshots: ${SHOT_DIR}`);
  console.log("=================================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
