/**
 * MOZON — "Bucket Catch The Broast" Server & Private Analytics Backend
 * 
 * Features:
 * - Enterprise Database Layer: Neon PostgreSQL
 * - Customer Offer Unlock & Verification Flow (Score 100+ -> Details -> Save Claim -> Reveal)
 * - Public Global Top 10 Leaderboard API with deterministic ranking & anti-cheat verification
 * - Anonymous first-party player identification & tracking
 * - Privacy-conscious analytics event tracking (page visits, game starts, completions, replays, CTAs)
 * - Private Owner Game Analytics Dashboard at /admin/game-analytics
 * - Fast, zero-dependency static file server
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");
const { DEFAULT_OFFER } = require("./offers");
const { GAME_FEATURES, GAME_CONFIG, calculateCatchPoints } = require("./game_config");

// Verification Engine: Validates chronological event log against server-side feature configuration
function verifyGameSession(events, durationSeconds, features = GAME_FEATURES, config = GAME_CONFIG) {
  let verifiedScore = 0;
  let verifiedCaught = 0;
  let verifiedMissed = 0;
  let consecutiveCatches = 0;
  const maxAllowedDurationMs = Math.max(10000, (durationSeconds + 5) * 1000);

  if (!Array.isArray(events)) {
    return { valid: false, message: "Events must be an array" };
  }

  let lastTimestamp = -1;

  for (const ev of events) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string") {
      return { valid: false, message: "Invalid event structure" };
    }

    const t = typeof ev.timestamp === "number" ? ev.timestamp : 0;
    if (t < 0 || t > maxAllowedDurationMs) {
      return { valid: false, message: "Event timestamp out of session bounds" };
    }
    if (t < lastTimestamp) {
      return { valid: false, message: "Event timestamps must be chronological" };
    }
    lastTimestamp = t;

    if (ev.type === "miss") {
      // Safe avoidance for bomb: no penalty, no miss, no combo reset
      if (ev.itemType === "bomb") {
        continue;
      }
      verifiedMissed++;
      // Combo resets on food miss (normal or golden mandi)
      consecutiveCatches = 0;
      continue;
    }

    if (ev.type === "catch") {
      if (ev.itemType === "bomb") {
        // Bomb caught: deducts 10 points (never multiplied), floor at 0, resets combo, does NOT add miss, does NOT increment food caught
        if (features.bomb) {
          const penalty = config.bombPoints !== undefined ? config.bombPoints : -10;
          verifiedScore = Math.max(0, verifiedScore + penalty);
        }
        consecutiveCatches = 0;
        continue;
      }

      verifiedCaught++;
      consecutiveCatches++;

      const scoring = calculateCatchPoints(ev.itemType, consecutiveCatches, features, config);
      verifiedScore += scoring.awardedPoints;
      continue;
    }

    return { valid: false, message: `Unknown event type: ${ev.type}` };
  }

  return {
    valid: true,
    verifiedScore,
    verifiedCaught,
    verifiedMissed
  };
}
const dbReadyPromise = db.init();
// Attach a handler immediately to avoid an unhandled rejection during cold start;
// request handlers and local startup still observe the original rejection.
dbReadyPromise.catch(() => {});

const PORT = parseInt(process.env.PORT || "3000", 10);

const isProductionServer = (
  process.env.NODE_ENV === "production" ||
  process.env.CONTEXT === "production" ||
  process.env.VERCEL_ENV === "production" ||
  ((Boolean(process.env.NETLIFY) || Boolean(process.env.VERCEL)) && process.env.NODE_ENV !== "test" && process.env.LOCAL_DEV !== "1")
);

// Developer-only actions (dev score injection, rate-limit bypass) are available ONLY on a
// local, non-production server. On Vercel/Netlify (or NODE_ENV=production) they are refused
// server-side regardless of what the client sends.
const DEV_TOOLS_ENABLED = !isProductionServer;

// -----------------------------------------------------------------------------
// Demo player entry (client demonstrations only)
// Name-only sign-in without MSG91 / OTP / captcha. It exists ONLY on a local, non-production
// server (set DEMO_PLAYER_ENTRY=0 to turn it off locally as well). On Vercel, Netlify or
// NODE_ENV=production it is unavailable whatever the configuration, and demo sessions are refused.
// Demo identities are kept apart from verified customers:
//   - player ids start with "demo_"; sessions store the marker "demo" instead of a mobile number,
//     so they never satisfy the verified-customer rules (admin customers list, staff claims);
//   - a production server rejects demo session cookies (getPlayerSession) and hides demo players
//     from the public leaderboard.
// Everything after sign-in (game-session nonces, event-log score verification, rate limits,
// duplicate protection, offer claims) is the unchanged production code path.
// -----------------------------------------------------------------------------
const DEMO_PLAYER_ENTRY_ENABLED = !isProductionServer && process.env.DEMO_PLAYER_ENTRY !== "0";
const DEMO_SESSION_MARKER = "demo";
const DEMO_PLAYER_ID_PREFIX = "demo_";
const DEMO_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEMO_ENTRY_LIMIT = 10; // demo sign-ins per client address per window
const DEMO_ENTRY_WINDOW_MS = 10 * 60 * 1000;
const demoEntryRateMap = new Map(); // client address -> recent demo sign-in timestamps

function isDemoPlayerId(playerId) {
  return typeof playerId === "string" && playerId.startsWith(DEMO_PLAYER_ID_PREFIX);
}

function allowDemoEntry(req) {
  const key = (req.socket && req.socket.remoteAddress) || "unknown";
  const now = Date.now();
  const recent = (demoEntryRateMap.get(key) || []).filter((t) => now - t < DEMO_ENTRY_WINDOW_MS);
  if (recent.length >= DEMO_ENTRY_LIMIT) {
    demoEntryRateMap.set(key, recent);
    return false;
  }
  recent.push(now);
  demoEntryRateMap.set(key, recent);
  return true;
}

// Public MSG91 widget settings for OTP sign-in come from the deployment environment. They are
// never hard-coded in the page, so this project cannot ship another brand's widget credentials.
function getOtpWidgetConfig() {
  const widgetId = String(process.env.MSG91_WIDGET_ID || "").trim();
  const tokenAuth = String(process.env.MSG91_TOKEN_AUTH || "").trim();
  return widgetId && tokenAuth ? { widgetId, tokenAuth } : null;
}

// Tells the page which player sign-in to show; contains no secrets.
function getPlayerEntryMode() {
  return DEMO_PLAYER_ENTRY_ENABLED
    ? { entryMode: "demo" }
    : { entryMode: "otp", otp: getOtpWidgetConfig() };
}

// Player OTP sign-in verifies MSG91 access tokens server-side and cannot work without the Authkey.
if (isProductionServer && !process.env.MSG91_AUTHKEY) {
  console.error("MSG91_AUTHKEY is not set: player OTP sign-in (POST /api/auth/msg91) will return HTTP 503 until it is configured and the site is redeployed.");
}

const INSECURE_DEFAULT_PASSWORDS = new Set([
  "soofi_admin_2026",
  "admin",
  "password",
  "123456",
  "admin123",
  "root"
]);

function getValidatedAdminPassword() {
  const envPass = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD).trim() : "";
  if (isProductionServer) {
    if (!envPass) {
      return null;
    }
    if (INSECURE_DEFAULT_PASSWORDS.has(envPass) || envPass.length < 10) {
      return null;
    }
    return envPass;
  }
  return envPass || "soofi_admin_2026";
}

// In-memory rate limiting and event deduplication
const submissionRateMap = new Map(); // playerId -> lastSubmissionTimestamp
const playerNameRateMap = new Map(); // playerId -> lastPlayerNameSaveTimestamp
const eventDedupMap = new Map();      // hash -> timestamp

// Helper: Parse JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    // If body was already parsed into object or string by serverless runtime/adapter
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === "object") return resolve(req.body);
      if (typeof req.body === "string") {
        if (!req.body.trim()) return resolve({});
        try {
          return resolve(JSON.parse(req.body));
        } catch (err) {
          return reject(new Error("Invalid JSON"));
        }
      }
    }

    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) { // 1MB limit
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Helper: Send JSON response
function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...headers
  });
  res.end(JSON.stringify(data));
}

// Customer Offer Management helpers (admin dashboard).
function getOfferMinScore() {
  return Math.max(100, GAME_CONFIG.offerEligibilityScore || 100);
}

function formatIndianMobileDisplay(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^91[6-9]\d{9}$/.test(digits)) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return digits ? `+${digits}` : null;
}

function isPlaceholderPlayerName(name) {
  return !name || /^(Anonymous Feast Guest|(?:Mandi|Mozon)Guest(_\w*)?|Customer)$/.test(name);
}

// Verified customers for Customer Offer Management ($1 = minimum qualifying score).
// owner:     each player identity -> the MSG91-verified mobile that created it (first session).
//            player_sessions rows exist only after server-side MSG91 verification.
// games:     qualifying leaderboard rows of those identities.
// customers: one row per verified mobile, grouping every identity and name it played under.
const VERIFIED_CUSTOMERS_SQL = `
  WITH owner AS (
    SELECT DISTINCT ON (s.player_id) s.player_id, regexp_replace(s.mobile_number, '[^0-9]', '', 'g') AS mobile
    FROM player_sessions s
    ORDER BY s.player_id, s.created_at ASC
  ),
  games AS (
    SELECT o.mobile, l.player_id, l.score, l.display_name, l.submitted_at
    FROM leaderboard l
    JOIN owner o ON o.player_id = l.player_id
    WHERE l.score >= $1 AND o.mobile ~ '^91[6-9][0-9]{9}$'
  ),
  customers AS (
    SELECT g.mobile,
           MAX(g.score) AS best_score,
           COUNT(*) AS qualifying_games,
           MAX(g.submitted_at) AS last_at,
           ARRAY_AGG(DISTINCT g.player_id) AS player_ids,
           ARRAY_AGG(g.display_name ORDER BY g.submitted_at DESC) AS names,
           (SELECT ARRAY_AGG(p.profile_name ORDER BY p.updated_at DESC)
              FROM players p
             WHERE p.profile_name IS NOT NULL
               AND p.player_id IN (SELECT g2.player_id FROM games g2 WHERE g2.mobile = g.mobile)) AS profile_names
    FROM games g
    GROUP BY g.mobile
  )
`;

// Customer display name from the names used with one verified mobile: saved profile names first,
// then the name given on a claim, then game names (latest first). Guest placeholders are skipped.
function describeCustomerNames(profileNames, gameNames, claimName) {
  const seen = new Set();
  const ordered = [];
  for (const value of [...(profileNames || []), claimName, ...(gameNames || [])]) {
    const trimmed = (value || "").trim();
    if (isPlaceholderPlayerName(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(trimmed);
  }
  return { name: ordered[0] || null, otherNames: ordered.slice(1, 6) };
}

// Helper: Sanitize string
function sanitizeString(str, maxLen = 32) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>?/gm, "").trim().substring(0, maxLen);
}

// -----------------------------------------------------------------------------
// Admin sessions
// The raw session token only ever lives in the HttpOnly `soofi_admin_session` cookie.
// The database stores its SHA-256 hash (in admin_sessions.session_token), so a leaked
// table row cannot be replayed as a cookie. Logout deletes the row (revocation).
// -----------------------------------------------------------------------------
const ADMIN_SESSION_COOKIE = "soofi_admin_session";
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function hashAdminToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function adminSessionCookie(token, maxAgeSeconds) {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isProductionServer) attributes.push("Secure");
  return attributes.join("; ");
}

// Returns { status: "valid", expiresAt } | { status: "missing" } | { status: "invalid" } | { status: "error" }
async function getAdminSession(req) {
  const rawToken = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (!rawToken) return { status: "missing" };
  if (!ADMIN_TOKEN_PATTERN.test(rawToken)) return { status: "invalid" };
  try {
    const row = await db.queryOne(
      "SELECT expires_at FROM admin_sessions WHERE session_token = $1 AND expires_at > $2",
      [hashAdminToken(rawToken), new Date().toISOString()]
    );
    if (!row) return { status: "invalid" };
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);
    return { status: "valid", expiresAt };
  } catch (_) {
    return { status: "error" };
  }
}

// Server-side authorization gate for every admin-only API. Cookie-only: no bearer tokens.
async function checkAdminAuth(req) {
  const session = await getAdminSession(req);
  return session.status === "valid";
}

const PLAYER_SESSION_COOKIE = "soofi_player_session";
const PLAYER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeIndianMobile(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  if (!/^91[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

// MSG91 verifyAccessToken (called server-side with the Authkey) returns
// { type: "success", message: "<verified identifier>" } on success and
// { type: "error", message: "...", code } on rejection. Only `message` is read, and the
// caller still requires it to normalize to a valid Indian mobile AND to equal the number
// the OTP was requested for. Anything else (e.g. a request id) fails closed with 503.
function extractMsg91VerifiedMobile(verification) {
  if (!verification || verification.type !== "success") return null;
  return typeof verification.message === "string" ? verification.message : null;
}

// Diagnostic for unexpected MSG91 success payloads: logs key names and value types only,
// never values, so no token, Authkey, or mobile number is ever written to logs.
function describeMsg91PayloadShape(payload) {
  if (!payload || typeof payload !== "object") return typeof payload;
  return Object.entries(payload)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
    .join(",");
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== "string" || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    const expectedProtocol = isProductionServer ? "https:" : (req.socket && req.socket.encrypted ? "https:" : "http:");
    return parsedOrigin.protocol === expectedProtocol && parsedOrigin.host.toLowerCase() === String(host).toLowerCase();
  } catch (_) {
    return false;
  }
}

function getCookieValue(req, cookieName) {
  const cookieHeader = req.headers.cookie || "";
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === cookieName) {
      return item.slice(separator + 1).trim();
    }
  }
  return "";
}

async function getPlayerSession(req, { throwOnDatabaseError = false } = {}) {
  const rawToken = getCookieValue(req, PLAYER_SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(rawToken)) return null;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const nowIso = new Date().toISOString();
  try {
    const session = await db.queryOne(
      "SELECT player_id, mobile_number, expires_at FROM player_sessions WHERE session_token_hash = $1 AND revoked_at IS NULL AND expires_at > $2",
      [tokenHash, nowIso]
    );
    // Demo sessions are valid only where demo entry is enabled (never on a production server).
    if (session && (session.mobile_number === DEMO_SESSION_MARKER || isDemoPlayerId(session.player_id)) && !DEMO_PLAYER_ENTRY_ENABLED) {
      return null;
    }
    return session;
  } catch (error) {
    if (throwOnDatabaseError) throw error;
    return null;
  }
}

function playerSessionCookie(token, maxAgeSeconds) {
  const attributes = [
    `${PLAYER_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isProductionServer) attributes.push("Secure");
  return attributes.join("; ");
}

// Helper: MIME types for static serving
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};

// Public static allowlist: the game page, its scripts/styles, and image/font assets.
// Source files, tests, scripts, data files, migrations and .env are never served.
const PUBLIC_STATIC_FILES = new Set(["/index.html", "/app.js", "/styles.css", "/game_config.js", "/offers.js", "/popup.js"]);
// Nested folders are allowed (e.g. /assets/images/broast/thigh.png); folder names cannot contain dots.
const PUBLIC_ASSET_PATTERN = /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:png|jpe?g|svg|ico|woff2?)$/i;

function isPublicStaticPath(requestPath) {
  if (typeof requestPath !== "string" || requestPath.includes("..") || requestPath.includes("\\")) return false;
  return PUBLIC_STATIC_FILES.has(requestPath) || PUBLIC_ASSET_PATTERN.test(requestPath);
}

// Serve static file
function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": ext === ".png" || ext === ".jpg" ? "public, max-age=86400" : "no-cache"
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

// Serve Private Admin Analytics Dashboard HTML
function serveAdminDashboardHtml(res) {
  const adminHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Analytics Dashboard — MOZON</title>
  <link rel="icon" type="image/png" href="/assets/images/branding/mozon_fav.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --stage-center: #2F405C;
      --stage-edge: #071429;
      --stage-floor: #273958;
      --gold-500: #F5B800;
      --gold-300: #FFD24D;
      --gold-600: #D99E00;
      --cream-50: #FFF8E7;
      --sand-200: #F0E3C4;
      --brown-900: #2A1408;
      --spice-600: #B5532F;
      --text-muted: #9FB3C8;
      --chip-bg: rgba(255, 248, 231, 0.08);
      --chip-line: rgba(245, 184, 0, 0.28);
      --border-gold: rgba(245, 184, 0, 0.35);
      --surface-card: linear-gradient(180deg, #1A2639 0%, #0D1624 100%);
      --surface-inner: rgba(7, 20, 41, 0.85);
      --success: #7BD88F;
      --danger: #FF6B4A;
      --sans: "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--sans);
      background-color: var(--stage-edge);
      background-image: radial-gradient(circle at 50% 25%, var(--stage-center), var(--stage-edge) 80%);
      background-attachment: fixed;
      color: var(--cream-50);
      min-height: 100vh;
      padding: 24px 20px;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--chip-line);
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .brand-logo { height: 48px; width: auto; object-fit: contain; }
    .title-wrap h1 { font-size: 20px; font-weight: 800; color: var(--gold-500); letter-spacing: 0.02em; }
    .title-wrap p { font-size: 12px; color: var(--text-muted); }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .btn {
      padding: 8px 18px;
      border-radius: 999px;
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }
    .btn-gold {
      background: linear-gradient(135deg, var(--gold-300), var(--gold-500));
      color: var(--brown-900);
      border: none;
    }
    .btn-gold:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(245, 184, 0, 0.45); }
    .btn-outline {
      background: rgba(15, 25, 41, 0.65);
      border: 1px solid var(--border-gold);
      color: var(--cream-50);
    }
    .btn-outline:hover {
      background: rgba(245, 184, 0, 0.15);
      border-color: var(--gold-300);
      color: var(--gold-300);
      box-shadow: 0 0 10px rgba(245, 184, 0, 0.2);
    }

    /* Login Form Card */
    .login-overlay {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 60vh;
    }
    .login-card {
      background: var(--surface-card);
      color: var(--cream-50);
      padding: 34px 30px;
      border-radius: 20px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(245, 184, 0, 0.12);
      border: 1px solid var(--border-gold);
    }
    .login-card h2 { font-size: 20px; font-weight: 800; margin-bottom: 8px; color: var(--gold-500); }
    .login-card p { font-size: 13px; color: var(--text-muted); margin-bottom: 22px; line-height: 1.45; }
    .input-field {
      width: 100%;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--surface-inner);
      border: 1.5px solid var(--border-gold);
      font-family: var(--sans);
      font-size: 14px;
      color: var(--gold-300);
      outline: none;
      margin-bottom: 16px;
      box-sizing: border-box;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .input-field:focus {
      border-color: var(--gold-500);
      box-shadow: 0 0 12px rgba(245, 184, 0, 0.35);
    }
    .input-field::placeholder { color: rgba(159, 179, 200, 0.55); }
    .login-btn {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, var(--gold-300), var(--gold-500));
      color: var(--brown-900);
      border: none;
      border-radius: 12px;
      font-family: var(--sans);
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
      letter-spacing: 0.05em;
      transition: all 0.2s ease;
    }
    .login-btn:hover { box-shadow: 0 4px 16px rgba(245, 184, 0, 0.45); transform: translateY(-1px); }

    /* Dashboard Main View */
    .dashboard-view { display: none; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .metric-card {
      background: linear-gradient(180deg, rgba(26, 38, 57, 0.8) 0%, rgba(13, 22, 36, 0.9) 100%);
      border: 1px solid var(--chip-line);
      border-radius: 16px;
      padding: 18px 16px;
      backdrop-filter: blur(8px);
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: var(--gold-500);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(245, 184, 0, 0.15);
    }
    .metric-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--gold-300); margin-bottom: 6px; }
    .metric-val { font-size: 28px; font-weight: 800; color: var(--cream-50); line-height: 1.1; margin-bottom: 4px; }
    .metric-sub { font-size: 11px; color: var(--text-muted); }

    /* Panels & Tables */
    .panel {
      background: linear-gradient(180deg, rgba(26, 38, 57, 0.8) 0%, rgba(13, 22, 36, 0.9) 100%);
      border: 1px solid var(--chip-line);
      border-radius: 18px;
      padding: 22px 20px;
      margin-bottom: 28px;
      backdrop-filter: blur(10px);
      box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4);
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .panel-title { font-size: 16px; font-weight: 700; color: var(--gold-500); display: flex; align-items: center; gap: 8px; }
    .filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .filter-select, .filter-input {
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--surface-inner);
      border: 1px solid var(--border-gold);
      color: var(--cream-50);
      font-family: var(--sans);
      font-size: 12px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .filter-select:focus, .filter-input:focus {
      border-color: var(--gold-500);
      box-shadow: 0 0 8px rgba(245, 184, 0, 0.35);
    }
    .filter-select option { background: #0D1624; color: var(--cream-50); }
    .filter-input::placeholder { color: rgba(159, 179, 200, 0.55); }
    .table-responsive {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border-radius: 10px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; text-align: left; }
    th {
      padding: 11px 14px;
      background: rgba(7, 20, 41, 0.95);
      color: var(--gold-300);
      font-weight: 700;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border-gold);
      white-space: nowrap;
    }
    td {
      padding: 11px 14px;
      border-bottom: 1px solid rgba(245, 184, 0, 0.12);
      color: var(--cream-50);
    }
    tr:hover td { background: rgba(245, 184, 0, 0.05); }
    .badge-rank {
      display: inline-block;
      width: 26px;
      height: 26px;
      line-height: 26px;
      text-align: center;
      border-radius: 50%;
      font-weight: 800;
      font-size: 11px;
    }
    .badge-rank-1 { background: var(--gold-500); color: var(--brown-900); }
    .badge-rank-2 { background: #B0BEC5; color: #0F1929; }
    .badge-rank-3 { background: #D97706; color: #FFFFFF; }
    .badge-event {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .offer-summary { font-size: 12px; color: var(--text-muted); margin: -6px 0 14px; }
    .offer-summary strong { color: var(--gold-300); }
    .offer-title-cell { font-weight: 700; }
    .offer-sub { display: block; font-size: 11px; font-weight: 500; color: var(--text-muted); margin-top: 3px; }
    .muted-value { color: var(--text-muted); font-style: italic; }
    .status-claimed { background: rgba(123, 216, 143, 0.2); color: var(--success); border: 1px solid rgba(123, 216, 143, 0.4); }
    .status-unclaimed { background: rgba(245, 184, 0, 0.2); color: var(--gold-300); border: 1px solid rgba(245, 184, 0, 0.4); }
    .claim-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .claim-btn {
      padding: 6px 16px;
      background: linear-gradient(135deg, var(--gold-300), var(--gold-500));
      color: var(--brown-900);
      border: none;
      border-radius: 999px;
      font-family: var(--sans);
      font-weight: 800;
      font-size: 12px;
      letter-spacing: 0.04em;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s ease;
    }
    .claim-btn:hover:not(:disabled) { box-shadow: 0 4px 16px rgba(245, 184, 0, 0.45); transform: translateY(-1px); }
    .claim-btn:disabled { opacity: 0.6; cursor: wait; }
    .offer-search { min-width: 240px; }
    .offer-notice { font-size: 12px; color: var(--success); margin: -6px 0 12px; min-height: 0; }
    .offer-notice:empty { display: none; }

    .privacy-notice {
      padding: 14px 18px;
      background: rgba(15, 25, 41, 0.7);
      border: 1px solid var(--chip-line);
      border-left: 4px solid var(--gold-500);
      border-radius: 8px;
      font-size: 11.5px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .admin-footer {
      text-align: center;
      font-size: 11px;
      letter-spacing: 0.14em;
      color: var(--gold-500);
      opacity: 0.75;
      padding-top: 28px;
      padding-bottom: 16px;
      font-weight: 600;
    }

    @media (max-width: 768px) {
      body { padding: 16px 14px; }
      /* Mobile header: logo, title and Log Out on one centred row; the title never wraps. */
      .header { flex-direction: row; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: clamp(8px, 3vw, 14px); padding-bottom: 14px; margin-bottom: 18px; }
      .header-left { flex: 1 1 auto; min-width: 0; gap: clamp(8px, 2.5vw, 12px); }
      .brand-logo { height: clamp(34px, 10vw, 44px); flex-shrink: 0; }
      .title-wrap { min-width: 0; }
      .title-wrap h1 { font-size: clamp(15px, 4.6vw, 20px); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .header-actions { flex: 0 0 auto; width: auto; justify-content: flex-end; }
      .header-actions .btn { padding: 7px clamp(12px, 3.5vw, 16px); white-space: nowrap; }
      /* Mobile: one swipeable row of full-size cards instead of squeezing them into the screen. */
      .metrics-grid {
        display: flex;
        gap: 10px;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        scroll-padding-inline: 14px;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-x: contain;
        scrollbar-width: thin;
        scrollbar-color: var(--chip-line) transparent;
        /* Bleed to the screen edges so cards scroll under the page gutter. */
        margin-left: -14px;
        margin-right: -14px;
        padding: 4px 14px 10px;
      }
      .metrics-grid::-webkit-scrollbar { height: 4px; }
      .metrics-grid::-webkit-scrollbar-thumb { background: var(--chip-line); border-radius: 4px; }
      .metric-card {
        flex: 0 0 clamp(160px, 44vw, 220px);
        scroll-snap-align: start;
        padding: 14px 12px;
      }
      .metric-val { font-size: 22px; }
      .panel { padding: 16px 14px; }
      .filter-bar { width: 100%; }
      .filter-select, .filter-input { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Navigation Header -->
    <header class="header">
      <div class="header-left">
        <img src="/assets/images/branding/logo.png" alt="MOZON Logo" class="brand-logo">
        <div class="title-wrap">
          <h1>Game Dashboard</h1>
        </div>
      </div>
      <div class="header-actions">
        <button id="logout-btn" class="btn btn-outline" style="display: none;">Log Out</button>
      </div>
    </header>

    <!-- Login Form Card -->
    <div id="login-section" class="login-overlay" style="display: none;">
      <div class="login-card">
        <h2>Owner Authentication</h2>
        <p>Enter administrative secret to inspect game usage analytics.</p>
        <input type="password" id="admin-pass-input" class="input-field" placeholder="Enter admin password..." autocomplete="current-password">
        <button id="admin-login-btn" class="login-btn">ACCESS DASHBOARD</button>
        <p id="login-error" style="color: var(--danger); font-size: 12px; margin-top: 10px; display: none;"></p>
      </div>
    </div>

    <!-- Protected Dashboard View -->
    <div id="dashboard-section" class="dashboard-view">
      <!-- 1. Overview Metrics Cards -->
      <div class="metrics-grid" id="metrics-cards">
        <div class="metric-card"><div class="metric-label">Offers Claimed</div><div class="metric-val" id="metric-claims" style="color: var(--gold-500);">-</div><div class="metric-sub">Score 100+ verified</div></div>
        <div class="metric-card"><div class="metric-label">Unique Players</div><div class="metric-val" id="metric-players">-</div><div class="metric-sub">Anonymous visitors</div></div>
        <div class="metric-card"><div class="metric-label">Page Visits</div><div class="metric-val" id="metric-visits">-</div><div class="metric-sub">Total impressions</div></div>
        <div class="metric-card"><div class="metric-label">Games Started</div><div class="metric-val" id="metric-starts">-</div><div class="metric-sub">Rounds initiated</div></div>
        <div class="metric-card"><div class="metric-label">Games Completed</div><div class="metric-val" id="metric-completes">-</div><div class="metric-sub">Completed rounds</div></div>
        <div class="metric-card"><div class="metric-label">Replays</div><div class="metric-val" id="metric-replays">-</div><div class="metric-sub">Play Again rounds</div></div>
        <div class="metric-card"><div class="metric-label">Abandoned</div><div class="metric-val" id="metric-abandons">-</div><div class="metric-sub">Left before 5 misses</div></div>
        <div class="metric-card"><div class="metric-label">Highest Score</div><div class="metric-val" id="metric-highscore">-</div><div class="metric-sub" id="metric-avgscore">Avg: -</div></div>
      </div>

      <!-- 1b. Customer Offer Management Panel -->
      <div class="panel" id="customer-offers-panel">
        <div class="panel-header">
          <h2 class="panel-title"><span>🎁</span> Customer Offer Management</h2>
          <div class="filter-bar">
            <input type="search" id="offer-search-input" class="filter-input offer-search" inputmode="tel" autocomplete="off" maxlength="16" placeholder="Search by mobile number..." aria-label="Search customers by mobile number">
          </div>
        </div>
        <p class="offer-summary" id="offer-summary">Verified mobile customers with a score of 100+</p>
        <p class="offer-notice" id="offer-notice" role="status" aria-live="polite"></p>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Registered Mobile</th>
                <th>Customer Name</th>
                <th>Highest Score</th>
                <th>Offer Details</th>
                <th>Claim Status</th>
              </tr>
            </thead>
            <tbody id="customer-offers-tbody">
              <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Loading customers...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 2. Global Top 10 Leaderboard Panel -->
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title"><span>🏆</span> Global Top 10 Leaderboard</h2>
          <span style="font-size: 12px; color: var(--text-muted);">Tie-breaking: Score DESC, Submission Time ASC</span>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 60px;">Rank</th>
                <th>Player Display Name</th>
                <th>Highest Score</th>
                <th>Food Caught</th>
                <th>Submitted Date</th>
              </tr>
            </thead>
            <tbody id="top10-tbody">
              <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Loading leaderboard...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Privacy & Retention Notice -->
      <div class="privacy-notice">
        <strong>Privacy & Security Notice:</strong> All metrics and events recorded use pseudonymous, first-party browser identifiers. Customer offer claim information is stored in verified database storage solely for offer fulfillment.
      </div>
    </div>

    <!-- Branded Footer -->
    <footer class="admin-footer">
      MOZON · GROUP OF RESTAURANTS · BUCKET CATCH THE BROAST
    </footer>
  </div>

  <script src="/popup.js"></script>
  <script>
    // Admin auth is cookie-based: the HttpOnly soofi_admin_session cookie is sent automatically
    // with same-origin requests. No token is kept in localStorage/sessionStorage.
    try { sessionStorage.removeItem("soofi_admin_token"); } catch (_) {} // purge legacy token storage

    const loginSection = document.getElementById("login-section");
    const dashboardSection = document.getElementById("dashboard-section");
    const logoutBtn = document.getElementById("logout-btn");
    const passInput = document.getElementById("admin-pass-input");
    const loginBtn = document.getElementById("admin-login-btn");
    const loginError = document.getElementById("login-error");

    // Wrapper for admin-only APIs: a 401 means the session expired or was revoked.
    async function adminFetch(url, options = {}) {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
      if (res.status === 401) {
        handleSessionLost();
        throw new Error("unauthorized");
      }
      return res;
    }

    function handleSessionLost() {
      if (dashboardSection.style.display !== "none") {
        showLogin({ kind: "session", key: "admin-session", title: "Session expired", message: "Your admin session has expired. Please log in again." });
      }
    }

    function loadDashboardData() {
      loadOverview();
      loadCustomerOffers();
      loadTop10();
    }

    async function checkAuth() {
      try {
        const res = await fetch("/api/admin/session", { credentials: "same-origin", cache: "no-store" });
        if (res.ok) {
          showDashboard();
          loadDashboardData();
        } else if (res.status === 503) {
          showLogin({ kind: "server", key: "admin-session-check", title: "Couldn't verify your session", message: "We couldn't check your admin session right now. Please refresh in a moment." });
        } else {
          showLogin();
        }
      } catch (_) {
        showLogin({ kind: "network", key: "admin-session-check", message: "We couldn't reach the server to check your admin session. Check your connection and refresh." });
      }
    }

    // Errors use the shared premium popup (popup.js); the inline login-error line is no longer used.
    function adminPopup(kind, overrides) {
      if (window.SoofiPopup) return window.SoofiPopup.error(kind, overrides);
      return Promise.resolve(null);
    }

    function showLogin(popup) {
      loginSection.style.display = "flex";
      dashboardSection.style.display = "none";
      logoutBtn.style.display = "none";
      loginError.style.display = "none";
      if (popup) adminPopup(popup.kind, popup);
    }

    function showDashboard() {
      loginSection.style.display = "none";
      dashboardSection.style.display = "block";
      logoutBtn.style.display = "inline-flex";
      loginError.style.display = "none";
    }

    async function submitLogin() {
      const password = passInput.value.trim();
      loginError.style.display = "none";
      if (!password) return;

      loginBtn.disabled = true;
      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (res.ok && data && data.success) {
          passInput.value = "";
          showDashboard();
          loadDashboardData();
        } else if (res.status === 401) {
          adminPopup("session", { key: "admin-login", icon: "lock", tone: "danger", title: "Incorrect password", message: "That password isn't right. Please check it and try again." })
            .then(() => { passInput.select(); });
        } else if (res.status === 503) {
          adminPopup("server", { key: "admin-login", title: "Admin sign-in unavailable", message: "Admin sign-in isn't available on the server right now. Please contact the site owner." });
        } else {
          adminPopup("server", { key: "admin-login", title: "Couldn't sign in", message: "Something went wrong while signing in. Please try again." });
        }
      } catch (_) {
        adminPopup("network", { key: "admin-login-network", message: "We couldn't reach the server. Check your connection and try again." });
      } finally {
        loginBtn.disabled = false;
      }
    }

    loginBtn.addEventListener("click", submitLogin);
    passInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitLogin();
    });

    logoutBtn.addEventListener("click", async () => {
      logoutBtn.disabled = true;
      try {
        const res = await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new Error("logout failed");
        showLogin();
      } catch (_) {
        adminPopup("server", { key: "admin-logout", title: "Couldn't log out", message: "We couldn't log you out. Check your connection and try again." });
      } finally {
        logoutBtn.disabled = false;
      }
    });

    async function loadOverview() {
      try {
        const res = await adminFetch("/api/admin/analytics/overview");
        const data = await res.json();
        if (data.success && data.metrics) {
          const m = data.metrics;
          document.getElementById("metric-claims").textContent = (m.offersClaimed || 0).toLocaleString();
          document.getElementById("metric-players").textContent = (m.uniquePlayers || 0).toLocaleString();
          document.getElementById("metric-visits").textContent = (m.pageVisits || 0).toLocaleString();
          document.getElementById("metric-starts").textContent = (m.gamesStarted || 0).toLocaleString();
          document.getElementById("metric-completes").textContent = (m.gamesCompleted || 0).toLocaleString();
          document.getElementById("metric-replays").textContent = (m.replays || 0).toLocaleString();
          document.getElementById("metric-abandons").textContent = (m.abandoned || 0).toLocaleString();
          document.getElementById("metric-highscore").textContent = (m.highestScore || 0).toLocaleString();
          document.getElementById("metric-avgscore").textContent = "Avg Score: " + (m.averageScore || 0).toFixed(1);
        } else {
          showDashboardLoadError(null);
        }
      } catch (err) {
        if (err && err.message === "unauthorized") return;
        showDashboardLoadError(err);
      }
    }

    // One popup (deduplicated) when any dashboard data fails to load, with a Retry action.
    function showDashboardLoadError(err) {
      const offline = window.SoofiPopup && window.SoofiPopup.isNetworkError(err);
      adminPopup(offline ? "network" : "server", {
        key: "admin-load",
        title: offline ? "You're offline" : "Couldn't load dashboard data",
        message: offline
          ? "We couldn't reach the server. Check your connection and try again."
          : "Some dashboard data didn't load. Please try again in a moment.",
        actions: [
          { label: "Close", value: "close" },
          { label: "Retry", value: "retry", primary: true, onClick: () => loadDashboardData() }
        ]
      });
    }

    // Customer Offer Management. Customers are verified mobile numbers. The main list shows
    // unclaimed offers; a mobile search (run on the server) shows any matching customer,
    // including existing CLAIMED status. Claim goes to POST /api/admin/offers/claim.
    let customerOffers = [];
    let lastOfferData = null;
    let offerSearchTimer = null;
    let offerLoadSeq = 0;
    const claimsInFlight = new Set();

    function offerSearchDigits() {
      return document.getElementById("offer-search-input").value.replace(/\\D/g, "").slice(0, 15);
    }

    function renderCustomerOffers() {
      const tbody = document.getElementById("customer-offers-tbody");
      const searching = offerSearchDigits().length >= 3;
      if (customerOffers.length === 0) {
        const msg = searching ? "No verified customer found with this mobile number." : "No eligible customers yet.";
        tbody.innerHTML = \`<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">\${msg}</td></tr>\`;
        return;
      }
      tbody.innerHTML = customerOffers.map((c) => {
        const cid = escapeHtml(c.customerId);
        const others = c.otherNames && c.otherNames.length ? \`<span class="offer-sub">Also played as \${escapeHtml(c.otherNames.join(", "))}</span>\` : "";
        const name = (c.name ? \`<strong>\${escapeHtml(c.name)}</strong>\` : '<span class="muted-value">Name not provided</span>') + others;
        const games = c.qualifyingGames > 1 ? \`<span class="offer-sub">\${c.qualifyingGames} games scored 100+</span>\` : "";
        const offer = \`<span class="offer-title-cell">\${escapeHtml(c.offer.title || "-")}</span><span class="offer-sub">\${escapeHtml(c.offer.badge || "")}</span>\`;
        let statusCell;
        if (c.claimed) {
          const when = c.claimedAt ? new Date(c.claimedAt).toLocaleString() : "";
          statusCell = \`<span class="badge-event status-claimed">Claimed</span><span class="offer-sub">\${when ? "Claimed on " + escapeHtml(when) : "Already claimed"}</span>\`;
        } else {
          const busy = claimsInFlight.has(c.customerId);
          statusCell = \`<span class="badge-event status-unclaimed">Unclaimed</span><span class="offer-sub">\${c.unlockedInGame ? "Offer unlocked in game" : "Eligible"}</span>
            <div class="claim-actions"><button type="button" class="claim-btn" data-claim-customer="\${cid}" \${busy ? "disabled" : ""}>\${busy ? "Claiming…" : "Claim"}</button></div>\`;
        }
        return \`<tr>
          <td style="white-space: nowrap;"><strong>\${escapeHtml(c.mobileNumber)}</strong></td>
          <td>\${name}</td>
          <td style="color:var(--gold-500); font-weight:800;">\${c.score}\${games}</td>
          <td>\${offer}</td>
          <td>\${statusCell}</td>
        </tr>\`;
      }).join("");
    }

    function renderOfferSummary(data) {
      lastOfferData = data;
      const t = data.totals || {};
      const counts = \`<strong>\${t.eligible || 0}</strong> eligible · <strong>\${t.claimed || 0}</strong> claimed · <strong>\${t.unclaimed || 0}</strong> unclaimed\`;
      document.getElementById("offer-summary").innerHTML = data.search
        ? \`Mobile search “\${escapeHtml(data.search)}” · \${customerOffers.length} found · Totals: \${counts}\`
        : \`Verified mobile customers with a score of \${data.minScore}+ · \${counts}\`;
    }

    async function loadCustomerOffers() {
      const tbody = document.getElementById("customer-offers-tbody");
      const digits = offerSearchDigits();
      const query = digits.length >= 3 ? "?mobile=" + encodeURIComponent(digits) : "";
      const seq = ++offerLoadSeq;
      try {
        const res = await adminFetch("/api/admin/offers/customers" + query);
        const data = await res.json();
        if (seq !== offerLoadSeq) return; // a newer search is in progress
        if (!res.ok || !data.success) throw new Error("load failed");
        customerOffers = data.customers || [];
        renderOfferSummary(data);
        renderCustomerOffers();
      } catch (err) {
        if (err && err.message === "unauthorized") return;
        if (seq !== offerLoadSeq) return;
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Customer offers unavailable right now.</td></tr>';
        showDashboardLoadError(err);
      }
    }

    // Friendly popup for a failed staff claim (by HTTP status; server text is not shown).
    function showClaimError(status) {
      if (status === "network") {
        return adminPopup("network", { key: "admin-claim", message: "The claim wasn't saved because the connection dropped. Check your internet and try again." });
      }
      if (status === 404) {
        return adminPopup("claim", { key: "admin-claim", title: "Customer not eligible", message: "This mobile number has no verified score of 100 or more, so the offer can't be claimed." });
      }
      if (status === 409) {
        return adminPopup("claim", { key: "admin-claim", title: "Please refresh", message: "This customer's offer was just updated elsewhere. Refresh the list and check the status." });
      }
      return adminPopup("server", { key: "admin-claim", title: "Claim not saved", message: "Something went wrong while saving the claim. Please try again." });
    }
    const confirmingClaims = new Set();

    async function claimCustomerOffer(customerId) {
      if (claimsInFlight.has(customerId)) return; // ignore double clicks
      const customer = customerOffers.find((c) => c.customerId === customerId);
      if (!customer || customer.claimed) return;
      const who = (customer.name ? customer.name + " · " : "") + customer.mobileNumber;
      if (confirmingClaims.has(customerId)) return;
      confirmingClaims.add(customerId);
      let confirmed = false;
      try {
        confirmed = window.SoofiPopup
          ? await window.SoofiPopup.confirm({
              key: "claim-confirm-" + customerId,
              icon: "gift",
              title: "Claim this offer?",
              message: "Check the customer's final offer screenshot first. This permanently marks the offer for " + who + " as CLAIMED.",
              confirmLabel: "Claim offer",
              cancelLabel: "Cancel"
            })
          : false;
      } finally {
        confirmingClaims.delete(customerId);
      }
      if (!confirmed) return;

      claimsInFlight.add(customerId);
      renderCustomerOffers();
      try {
        const res = await adminFetch("/api/admin/offers/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId })
        });
        let data = null;
        try { data = await res.json(); } catch (_) {}
        claimsInFlight.delete(customerId);
        if (!res.ok || !data || !data.success) {
          renderCustomerOffers();
          showClaimError(res.status);
          return;
        }
        document.getElementById("offer-notice").textContent = data.alreadyClaimed
          ? \`\${customer.mobileNumber} was already claimed on \${new Date(data.claim.claimedAt).toLocaleString()}. No second claim was made.\`
          : \`Offer CLAIMED for \${who}.\`;
        // Keep the customer in place and show CLAIMED immediately (no reload, so the row does not
        // jump); move one customer from unclaimed to claimed in the counts.
        customer.claimed = true;
        customer.claimStatus = "claimed";
        customer.claimedAt = data.claim.claimedAt;
        if (lastOfferData && lastOfferData.totals) {
          lastOfferData.totals.claimed = (lastOfferData.totals.claimed || 0) + 1;
          lastOfferData.totals.unclaimed = Math.max(0, (lastOfferData.totals.unclaimed || 0) - 1);
          renderOfferSummary(lastOfferData);
        }
        renderCustomerOffers();
        loadOverview();
      } catch (err) {
        claimsInFlight.delete(customerId);
        if (err && err.message === "unauthorized") return;
        renderCustomerOffers();
        showClaimError("network");
      }
    }

    document.getElementById("customer-offers-tbody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-claim-customer]");
      if (button && !button.disabled) claimCustomerOffer(button.getAttribute("data-claim-customer"));
    });
    document.getElementById("offer-search-input").addEventListener("input", () => {
      document.getElementById("offer-notice").textContent = "";
      window.clearTimeout(offerSearchTimer);
      offerSearchTimer = window.setTimeout(loadCustomerOffers, 300);
    });

    async function loadTop10() {
      try {
        const res = await fetch("/api/leaderboard");
        const data = await res.json();
        const tbody = document.getElementById("top10-tbody");
        if (data.success && data.leaderboard && data.leaderboard.length > 0) {
          tbody.innerHTML = data.leaderboard.map((row, i) => {
            const rankBadge = i === 0 ? '<span class="badge-rank badge-rank-1">1</span>' :
                              i === 1 ? '<span class="badge-rank badge-rank-2">2</span>' :
                              i === 2 ? '<span class="badge-rank badge-rank-3">3</span>' :
                              \`<span class="badge-rank">\${i + 1}</span>\`;
            const dateStr = new Date(row.submitted_at).toLocaleString();
            return \`<tr>
              <td>\${rankBadge}</td>
              <td><strong>\${escapeHtml(row.display_name)}</strong> <small style="color:var(--text-muted); opacity:0.7;">(\${row.player_id.substring(0,8)}...)</small></td>
              <td style="color:var(--gold-500); font-weight:800;">\${row.score}</td>
              <td>\${row.food_caught}</td>
              <td>\${dateStr}</td>
            </tr>\`;
          }).join("");
        } else {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No records found.</td></tr>';
        }
      } catch (err) {
        const tbody = document.getElementById("top10-tbody");
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Leaderboard unavailable right now.</td></tr>';
        showDashboardLoadError(err);
      }
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str).replace(/[&<>"']/g, m => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[m]));
    }

    checkAuth();
  </script>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(adminHtml);
}

// Main HTTP Request Handler
async function handleRequest(req, res) {
  await dbReadyPromise;
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS Preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end();
    return;
  }

  // MSG91 verified-token exchange and persistent player cookie sessions.
  if (pathname === "/api/auth/msg91" && method === "POST") {
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    }
    const authkey = process.env.MSG91_AUTHKEY;
    if (!authkey) {
      // Name only, never a value: makes a missing deployment variable visible in function logs.
      console.error("MSG91 sign-in unavailable: the MSG91_AUTHKEY environment variable is not set on this deployment.");
      return sendJson(res, 503, { success: false, message: "Phone verification is temporarily unavailable." });
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { success: false, message: "Invalid authentication request." });
    }
    const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
    const requestedMobile = normalizeIndianMobile(body.mobileNumber);
    if (!accessToken || accessToken.length > 4096 || !requestedMobile) {
      return sendJson(res, 400, { success: false, message: "Invalid authentication request." });
    }

    let upstream;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        upstream = await fetch("https://control.msg91.com/api/v5/widget/verifyAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ authkey, "access-token": accessToken }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (_) {
      return sendJson(res, 502, { success: false, message: "Phone verification could not be completed." });
    }

    let verification;
    try {
      verification = await upstream.json();
    } catch (_) {
      return sendJson(res, 502, { success: false, message: "Phone verification could not be completed." });
    }
    if (!upstream.ok || !verification || verification.type !== "success") {
      return sendJson(res, 401, { success: false, message: "Phone verification failed. Please verify your OTP again." });
    }

    const verifiedMobile = normalizeIndianMobile(extractMsg91VerifiedMobile(verification));
    if (!verifiedMobile) {
      console.error(`MSG91 verification succeeded but no verified mobile was found (payload shape: ${describeMsg91PayloadShape(verification)}).`);
      return sendJson(res, 503, {
        success: false,
        code: "verified_identifier_contract_unconfirmed",
        message: "Phone verification is temporarily unavailable."
      });
    }
    if (verifiedMobile !== requestedMobile) {
      return sendJson(res, 401, { success: false, message: "Verified phone number did not match the OTP request." });
    }

    try {
      const rawSessionToken = crypto.randomBytes(32).toString("base64url");
      const sessionTokenHash = crypto.createHash("sha256").update(rawSessionToken).digest("hex");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PLAYER_SESSION_TTL_MS);
      const session = await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [verifiedMobile]);
        const previousIdentity = await tx.queryOne(
          "SELECT player_id FROM player_sessions WHERE mobile_number = $1 ORDER BY created_at DESC LIMIT 1",
          [verifiedMobile]
        );
        const playerId = previousIdentity ? previousIdentity.player_id : crypto.randomUUID();
        await tx.query(
          "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL)",
          [sessionTokenHash, playerId, verifiedMobile, now.toISOString(), expiresAt.toISOString()]
        );
        return { playerId };
      });
      return sendJson(res, 200, { success: true, playerId: session.playerId, expiresAt: expiresAt.toISOString() }, {
        "Set-Cookie": playerSessionCookie(rawSessionToken, Math.floor(PLAYER_SESSION_TTL_MS / 1000)),
        "Cache-Control": "no-store"
      });
    } catch (err) {
      console.error("Player session creation failed.");
      return sendJson(res, 500, { success: false, message: "Sign-in could not be completed. Please try again." });
    }
  }

  if (pathname === "/api/player/session" && method === "GET") {
    let session;
    try {
      session = await getPlayerSession(req, { throwOnDatabaseError: true });
    } catch (_) {
      console.error("Player session lookup failed.");
      return sendJson(res, 503, {
        success: false,
        authenticated: false,
        message: "Unable to verify your sign-in right now."
      }, { "Cache-Control": "no-store" });
    }
    if (!session) {
      const staleCookie = getCookieValue(req, PLAYER_SESSION_COOKIE);
      return sendJson(res, 200, { success: true, authenticated: false, ...getPlayerEntryMode() }, {
        "Cache-Control": "no-store",
        ...(staleCookie ? { "Set-Cookie": playerSessionCookie("", 0) } : {})
      });
    }
    return sendJson(res, 200, {
      success: true,
      authenticated: true,
      playerId: session.player_id,
      expiresAt: session.expires_at,
      demo: session.mobile_number === DEMO_SESSION_MARKER,
      ...getPlayerEntryMode()
    }, { "Cache-Control": "no-store" });
  }

  // Demo player entry: name-only sign-in for local client demonstrations (see DEMO_PLAYER_ENTRY_ENABLED).
  // Issues the same HttpOnly, hashed-token player session as OTP sign-in, under a new "demo_" identity.
  if (pathname === "/api/auth/demo" && method === "POST") {
    if (!DEMO_PLAYER_ENTRY_ENABLED) {
      return sendJson(res, 404, { success: false, message: "Not found." });
    }
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    }
    if (!allowDemoEntry(req)) {
      return sendJson(res, 429, { success: false, message: "Too many attempts. Please wait a few minutes and try again." });
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { success: false, message: "Invalid request." });
    }
    const displayName = sanitizeString(typeof body.displayName === "string" ? body.displayName.replace(/\s+/g, " ") : "", 20);
    if (displayName.length < 2 || !/^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u.test(displayName) || isPlaceholderPlayerName(displayName)) {
      return sendJson(res, 400, { success: false, message: "Please enter a name of 2–20 letters or numbers." });
    }

    try {
      // Signing in again on this device ends the previous session first.
      const previousToken = getCookieValue(req, PLAYER_SESSION_COOKIE);
      if (/^[A-Za-z0-9_-]{40,60}$/.test(previousToken)) {
        const previousHash = crypto.createHash("sha256").update(previousToken).digest("hex");
        await db.query("UPDATE player_sessions SET revoked_at = $1 WHERE session_token_hash = $2 AND revoked_at IS NULL", [new Date().toISOString(), previousHash]);
      }

      const playerId = DEMO_PLAYER_ID_PREFIX + crypto.randomUUID();
      const rawSessionToken = crypto.randomBytes(32).toString("base64url");
      const sessionTokenHash = crypto.createHash("sha256").update(rawSessionToken).digest("hex");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEMO_SESSION_TTL_MS);
      await db.transaction(async (tx) => {
        await tx.query(`
          INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at)
          VALUES ($1, $2, $2, 0, 0, $3, $3)
          ON CONFLICT (player_id) DO NOTHING
        `, [playerId, displayName, now.toISOString()]);
        await tx.query(
          "INSERT INTO player_sessions (session_token_hash, player_id, mobile_number, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, NULL)",
          [sessionTokenHash, playerId, DEMO_SESSION_MARKER, now.toISOString(), expiresAt.toISOString()]
        );
      });
      return sendJson(res, 200, { success: true, demo: true, playerId, displayName, expiresAt: expiresAt.toISOString() }, {
        "Set-Cookie": playerSessionCookie(rawSessionToken, Math.floor(DEMO_SESSION_TTL_MS / 1000)),
        "Cache-Control": "no-store"
      });
    } catch (err) {
      console.error("Demo player session creation failed.");
      return sendJson(res, 500, { success: false, message: "Couldn't start the demo. Please try again." });
    }
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    }
    const rawToken = getCookieValue(req, PLAYER_SESSION_COOKIE);
    if (/^[A-Za-z0-9_-]{40,60}$/.test(rawToken)) {
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      await db.query("UPDATE player_sessions SET revoked_at = $1 WHERE session_token_hash = $2 AND revoked_at IS NULL", [new Date().toISOString(), tokenHash]);
    }
    return sendJson(res, 200, { success: true }, {
      "Set-Cookie": playerSessionCookie("", 0),
      "Cache-Control": "no-store"
    });
  }

  // -------------------------------------------------------------------------
  // NEW API: POST /api/game/start (Issue a Server-Side Game Session Nonce)
  // -------------------------------------------------------------------------
  if (pathname === "/api/game/start" && method === "POST") {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });

    try {
      const playerId = authenticatedPlayer.player_id;
      const gameSessionId = "sess_" + crypto.randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour session window

      // A newly signed-in player has no players row until their first verified score, but
      // game_sessions.player_id references players. Create a placeholder profile first (never
      // overwriting an existing one) so the very first game can be verified.
      await db.transaction(async (tx) => {
        await tx.query(`
          INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at)
          VALUES ($1, 'Anonymous Feast Guest', NULL, 0, 0, $2, $2)
          ON CONFLICT (player_id) DO NOTHING
        `, [playerId, now.toISOString()]);
        await tx.query(`
          INSERT INTO game_sessions (session_id, player_id, created_at, expires_at)
          VALUES ($1, $2, $3, $4)
        `, [gameSessionId, playerId, now.toISOString(), expiresAt.toISOString()]);
      });

      return sendJson(res, 200, {
        success: true,
        gameSessionId
      });
    } catch (err) {
      console.error("Error creating game session:", err.message);
      return sendJson(res, 500, { success: false, message: "Could not initialize game session." });
    }
  }

  // 1. PUBLIC API: GET /api/leaderboard (Top 10 Global Ranking)
  // -------------------------------------------------------------------------
  if (pathname === "/api/leaderboard" && method === "GET") {
    try {
      // Demo players appear only where demo entry is enabled (never on a production server).
      const rows = await db.query(`
        SELECT id, game_session_id, player_id, display_name, score, food_caught, missed_count, submitted_at
        FROM leaderboard
        ${DEMO_PLAYER_ENTRY_ENABLED ? "" : "WHERE player_id NOT LIKE 'demo\\_%'"}
        ORDER BY score DESC, submitted_at ASC
        LIMIT 10
      `);
      return sendJson(res, 200, {
        success: true,
        tieBreakingRule: "Score DESC, submitted_at ASC",
        leaderboard: rows
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Database query error" });
    }
  }

  // -------------------------------------------------------------------------
  // Feature Configuration API: GET /api/config/features & POST /api/config/features
  // -------------------------------------------------------------------------
  if (pathname === "/api/config/features" && method === "GET") {
    return sendJson(res, 200, {
      success: true,
      features: GAME_FEATURES,
      config: GAME_CONFIG
    });
  }

  if (pathname === "/api/config/features" && method === "POST") {
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }
    try {
      const body = await parseJsonBody(req);
      if (body && typeof body === "object") {
        if (body.features && typeof body.features === "object") {
          Object.assign(GAME_FEATURES, body.features);
        }
        if (body.config && typeof body.config === "object") {
          // Rule: minimum qualifying score must never fall below 100
          if (body.config.offerEligibilityScore !== undefined) {
            body.config.offerEligibilityScore = Math.max(100, parseInt(body.config.offerEligibilityScore, 10) || 100);
          }
          Object.assign(GAME_CONFIG, body.config);
        }
      }
      return sendJson(res, 200, {
        success: true,
        features: GAME_FEATURES,
        config: GAME_CONFIG
      });
    } catch (_) {
      return sendJson(res, 400, { success: false, message: "Invalid config payload" });
    }
  }

  // -------------------------------------------------------------------------
  // 1b. PUBLIC API: POST /api/player/name (Save & Confirm Player Display Name)
  // -------------------------------------------------------------------------
  if ((pathname === "/api/player/name" || pathname === "/api/player") && method === "POST") {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    try {
      const body = await parseJsonBody(req);
      const { displayName } = body;
      const playerId = authenticatedPlayer.player_id;

      // 2. Validate non-empty display name
      const rawName = typeof displayName === "string" ? displayName.trim() : "";
      if (!rawName) {
        return sendJson(res, 400, { success: false, message: "Display name cannot be empty" });
      }

      const cleanName = sanitizeString(rawName, 20);
      if (!cleanName) {
        return sendJson(res, 400, { success: false, message: "Display name cannot be empty" });
      }

      // 3. Debounce rapid repeat clicks (max 1 save per 250ms per player)
      const now = Date.now();
      const lastPlayerSave = playerNameRateMap.get(playerId) || 0;
      if (now - lastPlayerSave < 250) {
        return sendJson(res, 200, {
          success: true,
          message: "Name saved successfully!",
          displayName: cleanName,
          playerId
        });
      }
      playerNameRateMap.set(playerId, now);

      const nowIso = new Date().toISOString();

      // 4. Upsert player data in PostgreSQL
      await db.query(`
        INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at)
        VALUES ($1, $2, $2, 0, 0, $3, $4)
        ON CONFLICT(player_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          profile_name = EXCLUDED.profile_name,
          updated_at = EXCLUDED.updated_at
      `, [playerId, cleanName, nowIso, nowIso]);

      // 5. Update existing leaderboard records for this player so their display name stays in sync
      await db.query(`
        UPDATE leaderboard
        SET display_name = $1
        WHERE player_id = $2
      `, [cleanName, playerId]);

      return sendJson(res, 200, {
        success: true,
        message: "Name saved successfully!",
        displayName: cleanName,
        playerId
      });
    } catch (err) {
      console.error("Error saving player display name:", err.message);
      return sendJson(res, 500, {
        success: false,
        message: "Couldn't save your name. Please try again."
      });
    }
  }

  // Optional GET /api/player?playerId=...
  if ((pathname === "/api/player" || pathname === "/api/player/name") && method === "GET") {
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    try {
      const pid = authenticatedPlayer.player_id;
      const row = await db.queryOne("SELECT player_id, display_name, profile_name, highest_score, total_games FROM players WHERE player_id = $1", [pid]);
      if (!row) return sendJson(res, 404, { success: false, message: "Player not found" });
      return sendJson(res, 200, { success: true, player: row });
    } catch (_) {
      return sendJson(res, 500, { success: false, message: "Error fetching player" });
    }
  }

  // -------------------------------------------------------------------------
  // 2. PUBLIC API: POST /api/leaderboard (Submit Verified Game Score)
  // -------------------------------------------------------------------------
  if (pathname === "/api/leaderboard" && method === "POST") {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    // Stored, server-verified result for a session this player already consumed (null otherwise).
    const lookupStoredSubmission = async (sessionId) => {
      const row = await db.queryOne(`
        SELECT l.score, l.submitted_at
        FROM game_sessions gs
        JOIN leaderboard l ON l.game_session_id = gs.session_id AND l.player_id = gs.player_id
        WHERE gs.session_id = $1 AND gs.player_id = $2 AND gs.used_at IS NOT NULL
      `, [sessionId, authenticatedPlayer.player_id]);
      if (!row) return null;
      const storedScore = Number(row.score);
      const pbRow = await db.queryOne("SELECT highest_score FROM players WHERE player_id = $1", [authenticatedPlayer.player_id]);
      const rankRow = await db.queryOne(
        "SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE score > $1 OR (score = $1 AND submitted_at < $2)",
        [storedScore, row.submitted_at]
      );
      return {
        success: true,
        alreadySubmitted: true,
        rank: rankRow ? parseInt(rankRow.rank, 10) : 1,
        personalBest: pbRow ? pbRow.highest_score : storedScore,
        verifiedScore: storedScore,
        gameSessionId: sessionId
      };
    };
    let submittedSessionId = null;
    try {
      const body = await parseJsonBody(req);
      const { displayName, score, foodCaught, missedCount, durationSeconds, events, gameSessionId } = body;
      const playerId = authenticatedPlayer.player_id;

      // Developer-only score injection is refused outright in production, before any other processing.
      if (body.isDevTest && !DEV_TOOLS_ENABLED) {
        return sendJson(res, 403, { success: false, message: "Dev test score injection is strictly prohibited in production." });
      }

      if (!gameSessionId || typeof gameSessionId !== "string" || gameSessionId.length > 64) {
        return sendJson(res, 400, { success: false, message: "Missing game session identifier." });
      }

      // IDEMPOTENT RETRY: if this player's session was already consumed by a stored score
      // (e.g. the response was lost and the browser retries), return that stored, server-verified
      // result. The resubmitted payload is ignored, so a retry can never change the score, and
      // no second session or leaderboard entry is consumed.
      submittedSessionId = gameSessionId;
      const stored = await lookupStoredSubmission(gameSessionId);
      if (stored) return sendJson(res, 200, stored);

      const numScore = parseInt(score, 10);
      const numCaught = parseInt(foodCaught, 10);
      const numMissed = parseInt(missedCount, 10);
      const numDuration = parseFloat(durationSeconds) || 0;

      if (isNaN(numScore) || numScore < 0 || isNaN(numCaught) || numCaught < 0 || isNaN(numMissed) || numMissed < 0 || numMissed > 10) {
        return sendJson(res, 400, { success: false, message: "Invalid score, caught, or missed food count" });
      }

      let finalVerifiedScore = numScore;
      let finalVerifiedCaught = numCaught;

      // 2. Score Verification: Dev test bypass (dev-only), event log verification, or legacy matching
      if (body.isDevTest) {
        if (!DEV_TOOLS_ENABLED) {
          return sendJson(res, 403, { success: false, message: "Dev test score injection is strictly prohibited in production." });
        }
        finalVerifiedScore = numScore;
        finalVerifiedCaught = numCaught;
      } else if (Array.isArray(events) && events.length > 0) {
        const verification = verifyGameSession(events, numDuration, GAME_FEATURES, GAME_CONFIG);
        if (!verification.valid) {
          // The precise reason stays in server logs; the client gets a generic message.
          console.warn(`Score verification rejected a submission: ${String(verification.message).replace(/[\r\n]+/g, " ").slice(0, 200)}`);
          return sendJson(res, 400, { success: false, message: "Your score could not be verified." });
        }

        // Anti-abuse: verify catch physical rate (max 3.5 items/sec)
        if (verification.verifiedCaught > 5 && numDuration > 0 && (verification.verifiedCaught / numDuration) > 3.5) {
          return sendJson(res, 400, { success: false, message: "Submission failed physical sanity verification" });
        }

        // Use the server-verified score
        finalVerifiedScore = verification.verifiedScore;
        finalVerifiedCaught = verification.verifiedCaught;
      } else {
        // Fallback for requests without event logs: score must match food caught count
        if (isNaN(numScore) || numScore < 0 || isNaN(numCaught) || numCaught < 0 || numScore !== numCaught) {
          return sendJson(res, 400, { success: false, message: "Invalid score or caught count mismatch" });
        }

        // Anti-Abuse Sanity Check: Minimum physical catch rate
        if (numCaught > 5 && numDuration > 0 && (numCaught / numDuration) > 3.5) {
          return sendJson(res, 400, { success: false, message: "Submission failed physical sanity verification" });
        }
      }

      // 3. Submission Rate Limiting: Max 1 submission per 800ms per player (bypassed for dev tests in non-production)
      const now = Date.now();
      const lastSub = submissionRateMap.get(playerId) || 0;
      const isDevBypass = Boolean(body.isDevTest && DEV_TOOLS_ENABLED);
      if (!isDevBypass && (now - lastSub < 800)) {
        return sendJson(res, 429, { success: false, message: "Too many submissions. Please wait a moment." });
      }
      submissionRateMap.set(playerId, now);

      // Reuse a server-saved profile name instead of trusting a browser's cached display name.
      const existingPlayer = await db.queryOne(
        "SELECT profile_name FROM players WHERE player_id = $1",
        [playerId]
      );
      const savedProfileName = sanitizeString(existingPlayer?.profile_name || "", 64);
      const cleanName = savedProfileName.length >= 2
        ? savedProfileName
        : sanitizeString(displayName || "Anonymous Feast Guest", 20);
      const nowIso = new Date().toISOString();

      // SCORE REPLAY PROTECTION: Validate and use the server-issued session nonce
      const result = await db.transaction(async (tx) => {
        const session = await tx.queryOne(
          "SELECT session_id FROM game_sessions WHERE session_id = $1 AND player_id = $2 AND used_at IS NULL AND expires_at > $3 FOR UPDATE",
          [gameSessionId, playerId, nowIso]
        );

        if (!session) {
          throw new Error("REPLAY_OR_EXPIRED");
        }

        // Mark session as used
        await tx.query(
          "UPDATE game_sessions SET used_at = $1, score = $2, food_caught = $3 WHERE session_id = $4",
          [nowIso, finalVerifiedScore, finalVerifiedCaught, gameSessionId]
        );

        // Upsert player record with verified score
        await tx.query(`
          INSERT INTO players (player_id, display_name, profile_name, highest_score, total_games, created_at, updated_at)
          VALUES ($1, $2, NULL, $3, 1, $4, $5)
          ON CONFLICT(player_id) DO UPDATE SET
            display_name = COALESCE(NULLIF(BTRIM(players.profile_name), ''), EXCLUDED.display_name),
            highest_score = CASE WHEN players.highest_score > EXCLUDED.highest_score THEN players.highest_score ELSE EXCLUDED.highest_score END,
            total_games = players.total_games + 1,
            updated_at = EXCLUDED.updated_at
        `, [playerId, cleanName, finalVerifiedScore, nowIso, nowIso]);

        // Insert score entry with verified score & game_session_id
        await tx.query(`
          INSERT INTO leaderboard (game_session_id, player_id, display_name, score, food_caught, missed_count, duration_seconds, submitted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [gameSessionId, playerId, cleanName, finalVerifiedScore, finalVerifiedCaught, numMissed, numDuration, nowIso]);

        // Query current player's personal best
        const pbRow = await tx.queryOne("SELECT highest_score FROM players WHERE player_id = $1", [playerId]);

        // Query rank among all scores
        const rankRow = await tx.queryOne(`
          SELECT COUNT(*) + 1 as rank
          FROM leaderboard
          WHERE score > $1 OR (score = $2 AND submitted_at < $3)
        `, [finalVerifiedScore, finalVerifiedScore, nowIso]);

        return {
          rank: rankRow ? parseInt(rankRow.rank, 10) : 1,
          personalBest: pbRow ? pbRow.highest_score : finalVerifiedScore,
          verifiedScore: finalVerifiedScore,
          gameSessionId
        };
      });

      return sendJson(res, 201, {
        success: true,
        ...result
      });
    } catch (err) {
      if (err.message === "REPLAY_OR_EXPIRED") {
        // A concurrent duplicate of this same submission may have just consumed the session.
        try {
          const stored = submittedSessionId ? await lookupStoredSubmission(submittedSessionId) : null;
          if (stored) return sendJson(res, 200, stored);
        } catch (_) {}
        return sendJson(res, 403, { success: false, message: "Game session is invalid or has already been submitted." });
      }
      console.error("Error processing score submission:", err.message);
      return sendJson(res, 500, { success: false, message: "Error processing score submission" });
    }
  }

  // -------------------------------------------------------------------------
  // 3. PUBLIC API: POST /api/offers/claim (Claim Offer for Score 100+)
  // -------------------------------------------------------------------------
  if (pathname === "/api/offers/claim" && method === "POST") {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    try {
      const body = await parseJsonBody(req);
      const { gameSessionId, fullName } = body;
      const playerId = authenticatedPlayer.player_id;

      if (!gameSessionId || typeof gameSessionId !== "string") {
        return sendJson(res, 400, { success: false, message: "Missing or invalid game session identifier." });
      }
      const rawMobile = `+${authenticatedPlayer.mobile_number}`;
      const cleanEmail = null;
      const nowIso = new Date().toISOString();
      const offer = DEFAULT_OFFER;

      // ATOMIC TRANSACTION: Handle claim logic and concurrency
      const result = await db.transaction(async (tx) => {
        // 1. Look up verified server-side game session record
        const sessionRow = await tx.queryOne(
          "SELECT game_session_id, player_id, score, submitted_at FROM leaderboard WHERE game_session_id = $1 AND player_id = $2",
          [gameSessionId, playerId]
        );

        if (!sessionRow) {
          return { error: 404, message: "Game session not found or invalid." };
        }

        // 2. Enforce Server-Side Score Requirement
        const verifiedScore = parseInt(sessionRow.score, 10);
        const minScore = Math.max(100, GAME_CONFIG.offerEligibilityScore || 100);
        if (isNaN(verifiedScore) || verifiedScore < minScore) {
          return { error: 403, message: `Offer is only unlocked for verified scores of ${minScore} points or higher.` };
        }

        // 3. Idempotency Check: Return existing claim if already claimed for this game session
        const existingClaim = await tx.queryOne(
          "SELECT claim_id, game_session_id, player_id, full_name, verified_score, offer_id, offer_title, offer_badge, claim_status, created_at FROM offer_claims WHERE game_session_id = $1 FOR UPDATE",
          [gameSessionId]
        );

        if (existingClaim) {
          return {
            alreadyClaimed: true,
            claim: {
              claimId: existingClaim.claim_id,
              gameSessionId: existingClaim.game_session_id,
              fullName: existingClaim.full_name,
              verifiedScore: existingClaim.verified_score,
              offer: {
                id: existingClaim.offer_id,
                title: existingClaim.offer_title,
                badge: existingClaim.offer_badge,
                description: DEFAULT_OFFER.description,
                brand: DEFAULT_OFFER.brand,
                instructions: DEFAULT_OFFER.instructions
              },
              claimStatus: existingClaim.claim_status,
              createdAt: existingClaim.created_at
            }
          };
        }

        // 4. Use the saved profile name, or validate and persist the first submitted name.
        const player = await tx.queryOne(
          "SELECT profile_name FROM players WHERE player_id = $1 FOR UPDATE",
          [playerId]
        );
        if (!player) {
          throw new Error("Authenticated player profile is missing.");
        }

        let cleanName = sanitizeString(player.profile_name || "", 64);
        if (cleanName.length < 2) {
          const submittedName = sanitizeString(fullName, 64);
          if (submittedName.length < 2) {
            return {
              error: 428,
              code: "player_name_required",
              message: "Please enter your name to claim this offer."
            };
          }

          cleanName = submittedName;
          await tx.query(`
            UPDATE players
            SET profile_name = $1, display_name = $1, updated_at = $2
            WHERE player_id = $3
          `, [cleanName, nowIso, playerId]);
          await tx.query(
            "UPDATE leaderboard SET display_name = $1 WHERE player_id = $2",
            [cleanName, playerId]
          );
        }

        const claimId = "claim_" + crypto.randomUUID();
        await tx.query(`
          INSERT INTO offer_claims (
            claim_id, game_session_id, player_id, full_name, mobile_number, email,
            verified_score, offer_id, offer_title, offer_badge, claim_status, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          claimId,
          gameSessionId,
          playerId,
          cleanName,
          rawMobile,
          cleanEmail,
          verifiedScore,
          offer.id,
          offer.title,
          offer.badge,
          "unlocked",
          nowIso
        ]);

        // Record tracking event
        const eventMeta = JSON.stringify({ claimId, offerId: offer.id, verifiedScore });
        await tx.query(`
          INSERT INTO analytics_events (player_id, session_id, event_name, event_metadata, created_at)
          VALUES ($1, $2, 'offer_claim_success', $3, $4)
        `, [playerId, gameSessionId, eventMeta, nowIso]);

        return {
          success: true,
          claim: {
            claimId,
            gameSessionId,
            fullName: cleanName,
            verifiedScore,
            offer,
            claimStatus: "unlocked",
            createdAt: nowIso
          }
        };
      });

      if (result.error) {
        return sendJson(res, result.error, {
          success: false,
          code: result.code,
          message: result.message
        });
      }

      if (result.alreadyClaimed) {
        return sendJson(res, 200, {
          success: true,
          alreadyClaimed: true,
          claim: result.claim
        });
      }

      return sendJson(res, 201, {
        success: true,
        claim: result.claim
      });

    } catch (err) {
      console.error("Error processing offer claim:", err.message);
      // Handle unique constraint violation just in case of race between outer check and transaction commit
      if (err.code === '23505') {
          return sendJson(res, 409, { success: false, message: "Claim already in progress for this session." });
      }
      return sendJson(res, 500, { success: false, message: "Unable to record your offer claim. Please try again." });
    }
  }

  // -------------------------------------------------------------------------
  // 4. PUBLIC API: GET /api/offers/claim (Retrieve Existing Claim for Session)
  // -------------------------------------------------------------------------
  if (pathname === "/api/offers/claim" && method === "GET") {
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    try {
      const gameSessionId = parsedUrl.searchParams.get("gameSessionId") || "";
      const playerId = authenticatedPlayer.player_id;
      if (!gameSessionId) return sendJson(res, 400, { success: false, message: "Missing gameSessionId." });

      const claim = await db.queryOne(
        "SELECT claim_id, game_session_id, player_id, full_name, verified_score, offer_id, offer_title, offer_badge, claim_status, created_at FROM offer_claims WHERE game_session_id = $1 AND player_id = $2",
        [gameSessionId, playerId]
      );

      if (!claim) {
        return sendJson(res, 404, { success: false, message: "No offer claim found for this session." });
      }

      return sendJson(res, 200, {
        success: true,
        claim: {
          claimId: claim.claim_id,
          gameSessionId: claim.game_session_id,
          fullName: claim.full_name,
          verifiedScore: claim.verified_score,
          offer: {
            id: claim.offer_id,
            title: claim.offer_title,
            badge: claim.offer_badge,
            description: DEFAULT_OFFER.description,
            brand: DEFAULT_OFFER.brand,
            instructions: DEFAULT_OFFER.instructions
          },
          claimStatus: claim.claim_status,
          createdAt: claim.created_at
        }
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error retrieving offer claim." });
    }
  }

  // -------------------------------------------------------------------------
  // 5. PUBLIC API: POST /api/analytics/events (Privacy-Conscious Tracking)
  // -------------------------------------------------------------------------
  if (pathname === "/api/analytics/events" && method === "POST") {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { success: false, message: "Request origin rejected." });
    const authenticatedPlayer = await getPlayerSession(req);
    if (!authenticatedPlayer) return sendJson(res, 401, { success: false, message: "Please sign in to continue." });
    try {
      const body = await parseJsonBody(req);
      const { sessionId, eventName, metadata } = body;
      const playerId = authenticatedPlayer.player_id;

      if (!playerId || !sessionId || !eventName) {
        return sendJson(res, 400, { success: false, message: "Missing required tracking attributes" });
      }

      // Event deduplication: prevent duplicate event within 500ms
      const dedupKey = `${playerId}_${sessionId}_${eventName}_${JSON.stringify(metadata || {})}`;
      const now = Date.now();
      const lastSent = eventDedupMap.get(dedupKey) || 0;
      if (now - lastSent < 500) {
        return sendJson(res, 200, { success: true, deduplicated: true });
      }
      eventDedupMap.set(dedupKey, now);

      if (eventDedupMap.size > 2000) {
        for (const [k, ts] of eventDedupMap) {
          if (now - ts > 10000) eventDedupMap.delete(k);
        }
      }

      const cleanEvent = sanitizeString(eventName, 40);
      const nowIso = new Date().toISOString();
      const metaString = typeof metadata === "object" ? JSON.stringify(metadata) : "{}";

      await db.query(`
        INSERT INTO analytics_events (player_id, session_id, event_name, event_metadata, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [playerId, sessionId, cleanEvent, metaString, nowIso]);

      return sendJson(res, 201, { success: true });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error recording event" });
    }
  }

  // -------------------------------------------------------------------------
  // 6. ADMIN API: POST /api/admin/login (Owner Authentication)
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/login" && method === "POST") {
    try {
      const configuredPassword = getValidatedAdminPassword();
      if (!configuredPassword) {
        return sendJson(res, 503, {
          success: false,
          message: isProductionServer
            ? "Administrative login is disabled in production: A secure ADMIN_PASSWORD environment variable (minimum 10 characters, non-default) must be configured."
            : "Administrative login is currently unconfigured."
        });
      }

      // Login CSRF protection: only the dashboard's own origin may create an admin session.
      if (!isSameOriginRequest(req)) {
        return sendJson(res, 403, { success: false, message: "Cross-origin admin login is not allowed." });
      }

      const body = await parseJsonBody(req);
      const { password } = body;

      const inputPass = typeof password === "string" ? password : "";
      const inputBuffer = Buffer.from(inputPass);
      const expectedBuffer = Buffer.from(configuredPassword);
      const isMatch = (
        inputBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(inputBuffer, expectedBuffer)
      );

      if (!isMatch) {
        return sendJson(res, 401, { success: false, message: "Invalid administrative password" });
      }

      const sessionToken = crypto.randomBytes(32).toString("hex");
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS).toISOString();

      // Housekeeping: drop expired admin sessions (admin_sessions only; no player data touched).
      await db.query("DELETE FROM admin_sessions WHERE expires_at <= $1", [nowIso]);
      await db.query(
        "INSERT INTO admin_sessions (session_token, created_at, expires_at) VALUES ($1, $2, $3)",
        [hashAdminToken(sessionToken), nowIso, expiresAt]
      );

      // The token is delivered only via the HttpOnly cookie, never in the JSON body.
      return sendJson(res, 200, { success: true, authenticated: true, expiresAt }, {
        "Set-Cookie": adminSessionCookie(sessionToken, Math.floor(ADMIN_SESSION_TTL_MS / 1000)),
        "Cache-Control": "no-store"
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error during admin authentication" });
    }
  }

  // -------------------------------------------------------------------------
  // ADMIN API: GET /api/admin/session (restore session on page load)
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/session" && method === "GET") {
    const session = await getAdminSession(req);
    if (session.status === "valid") {
      return sendJson(res, 200, { success: true, authenticated: true, expiresAt: session.expiresAt }, {
        "Cache-Control": "no-store"
      });
    }
    if (session.status === "error") {
      // Keep the cookie: a transient database failure must not log the admin out.
      return sendJson(res, 503, { success: false, authenticated: false, message: "Unable to verify admin session." }, {
        "Cache-Control": "no-store"
      });
    }
    return sendJson(res, 401, { success: false, authenticated: false, message: "Admin session expired or invalid." }, {
      "Cache-Control": "no-store",
      ...(session.status === "invalid" ? { "Set-Cookie": adminSessionCookie("", 0) } : {})
    });
  }

  // -------------------------------------------------------------------------
  // ADMIN API: POST /api/admin/logout (revoke session)
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/logout" && method === "POST") {
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { success: false, message: "Cross-origin admin logout is not allowed." });
    }
    const rawToken = getCookieValue(req, ADMIN_SESSION_COOKIE);
    if (ADMIN_TOKEN_PATTERN.test(rawToken)) {
      try {
        await db.query("DELETE FROM admin_sessions WHERE session_token = $1", [hashAdminToken(rawToken)]);
      } catch (_) {
        return sendJson(res, 500, { success: false, message: "Unable to revoke admin session." });
      }
    }
    return sendJson(res, 200, { success: true, authenticated: false }, {
      "Set-Cookie": adminSessionCookie("", 0),
      "Cache-Control": "no-store"
    });
  }

  // -------------------------------------------------------------------------
  // 7. ADMIN API: GET /api/admin/analytics/overview (Metrics Aggregation)
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/analytics/overview" && method === "GET") {
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }

    try {
      const uniquePlayers = (await db.queryOne("SELECT COUNT(DISTINCT player_id) as count FROM analytics_events"))?.count || 0;
      const pageVisits = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'page_visit'"))?.count || 0;
      const gamesStarted = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'game_start'"))?.count || 0;
      const gamesCompleted = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'game_complete'"))?.count || 0;
      const replays = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'game_replay'"))?.count || 0;
      const abandoned = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'game_abandon'"))?.count || 0;
      const ctaClicks = (await db.queryOne("SELECT COUNT(*) as count FROM analytics_events WHERE event_name = 'cta_click'"))?.count || 0;
      const offersClaimed = (await db.queryOne("SELECT COUNT(*) as count FROM offer_claims"))?.count || 0;

      const scoreStats = await db.queryOne("SELECT MAX(score) as max_score, AVG(score) as avg_score FROM leaderboard");
      const highestScore = scoreStats?.max_score || 0;
      const averageScore = Math.round(Number(scoreStats?.avg_score || 0));

      return sendJson(res, 200, {
        success: true,
        metrics: {
          uniquePlayers: Number(uniquePlayers),
          pageVisits: Number(pageVisits),
          gamesStarted: Number(gamesStarted),
          gamesCompleted: Number(gamesCompleted),
          replays: Number(replays),
          abandoned: Number(abandoned),
          ctaClicks: Number(ctaClicks),
          offersClaimed: Number(offersClaimed),
          highestScore: Number(highestScore),
          averageScore
        }
      });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error computing overview metrics" });
    }
  }

  // -------------------------------------------------------------------------
  // 7b. ADMIN API: GET /api/admin/offers/customers (Customer Offer Management)
  // Read-only. A customer is a MSG91-verified mobile number. player_sessions rows are written
  // only after server-side MSG91 verification, so guest-only/unverified players never appear.
  // Each player identity belongs to the verified mobile that created it (its first session);
  // all of that mobile's games are grouped together regardless of the names used, and
  // different mobiles are never merged, even when names match.
  //   no ?mobile  -> every eligible customer, claimed and unclaimed
  //   ?mobile=... -> eligible customers whose verified mobile matches (claimed or not)
  // totals always describe all eligible customers (not just the search results).
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/offers/customers" && method === "GET") {
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }

    try {
      const minScore = getOfferMinScore();
      const mobileDigits = String(parsedUrl.searchParams.get("mobile") || "").replace(/\D/g, "").slice(0, 15);
      const mobileFilter = mobileDigits.length >= 3 ? mobileDigits : null;
      const rows = await db.query(`
        ${VERIFIED_CUSTOMERS_SQL}
        SELECT cu.mobile, cu.best_score, cu.qualifying_games, cu.last_at, cu.names, cu.profile_names,
               COALESCE(lc.offer_id, $2) AS offer_id,
               COALESCE(lc.offer_title, $3) AS offer_title,
               COALESCE(lc.offer_badge, $4) AS offer_badge,
               lc.created_at AS unlocked_at, lc.full_name AS claim_name,
               r.claim_id AS redeemed_claim_id, COALESCE(r.redeemed_at, r.created_at) AS claimed_at
        FROM customers cu
        LEFT JOIN LATERAL (
          SELECT c.offer_id, c.offer_title, c.offer_badge, c.created_at, c.full_name
          FROM offer_claims c
          WHERE c.player_id = ANY(cu.player_ids) OR regexp_replace(c.mobile_number, '[^0-9]', '', 'g') = cu.mobile
          ORDER BY c.created_at DESC
          LIMIT 1
        ) lc ON TRUE
        LEFT JOIN LATERAL (
          SELECT c.claim_id, c.redeemed_at, c.created_at
          FROM offer_claims c
          WHERE c.claim_status = 'claimed'
            AND c.offer_id = COALESCE(lc.offer_id, $2)
            AND (c.player_id = ANY(cu.player_ids) OR regexp_replace(c.mobile_number, '[^0-9]', '', 'g') = cu.mobile)
          ORDER BY c.redeemed_at DESC NULLS LAST, c.created_at DESC
          LIMIT 1
        ) r ON TRUE
        ORDER BY cu.best_score DESC, cu.last_at DESC
        LIMIT 5000
      `, [minScore, DEFAULT_OFFER.id, DEFAULT_OFFER.title, DEFAULT_OFFER.badge]);

      const all = (rows || []).map((row) => {
        const claimed = Boolean(row.redeemed_claim_id);
        const names = describeCustomerNames(row.profile_names, row.names, row.claim_name);
        return {
          customerId: row.mobile,
          mobileNumber: formatIndianMobileDisplay(row.mobile),
          name: names.name,
          otherNames: names.otherNames,
          score: Number(row.best_score),
          qualifyingGames: Number(row.qualifying_games),
          offer: { id: row.offer_id, title: row.offer_title, badge: row.offer_badge },
          claimed,
          claimStatus: claimed ? "claimed" : "unclaimed",
          claimedAt: claimed ? row.claimed_at : null,
          unlockedInGame: Boolean(row.unlocked_at),
          lastPlayedAt: row.last_at
        };
      });
      // Every eligible customer is listed, claimed or not: unclaimed first (staff action needed),
      // then claimed; each group keeps the highest-score-first order from the query.
      const ordered = [...all.filter((c) => !c.claimed), ...all.filter((c) => c.claimed)];
      const customers = mobileFilter
        ? ordered.filter((c) => c.customerId.includes(mobileFilter))
        : ordered;

      return sendJson(res, 200, {
        success: true,
        minScore,
        search: mobileFilter,
        totals: {
          eligible: all.length,
          claimed: all.filter((c) => c.claimed).length,
          unclaimed: all.filter((c) => !c.claimed).length
        },
        customers
      }, { "Cache-Control": "no-store" });
    } catch (err) {
      console.error("Customer offer list query failed.");
      return sendJson(res, 500, { success: false, message: "Error loading customer offers" });
    }
  }

  // -------------------------------------------------------------------------
  // 7c. ADMIN API: POST /api/admin/offers/claim (staff confirms a customer's offer)
  // Body: { customerId } = the customer's verified mobile number (digits) from the list.
  //  - Admin session + same-origin required; the customer is re-validated on the server
  //    (verified mobile with a qualifying score) inside the transaction.
  //  - Serialized per verified mobile with a transaction-scoped advisory lock and backed by the
  //    uq_offer_claims_mobile_offer_claimed unique index: double clicks and concurrent staff
  //    devices produce exactly one claim; repeats return the existing claim.
  //  - Reuses the customer's latest in-game claim record (only claim_status and redeemed_at
  //    change); creates a record only when none exists. Other claim records are untouched.
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/offers/claim" && method === "POST") {
    if (!isSameOriginRequest(req)) {
      return sendJson(res, 403, { success: false, message: "Cross-origin admin requests are not allowed." });
    }
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (_) {
      return sendJson(res, 400, { success: false, message: "Invalid claim request." });
    }
    const mobile = normalizeIndianMobile(typeof body.customerId === "string" ? body.customerId : "");
    if (!mobile) {
      return sendJson(res, 400, { success: false, message: "Invalid customer." });
    }

    const claimView = (row) => ({
      customerId: mobile,
      mobileNumber: formatIndianMobileDisplay(mobile),
      claimId: row.claim_id,
      claimStatus: "claimed",
      claimedAt: row.redeemed_at || row.created_at,
      offer: { id: row.offer_id, title: row.offer_title, badge: row.offer_badge }
    });
    const findRedeemed = (q, playerIds, offerId) => q.queryOne(`
      SELECT claim_id, offer_id, offer_title, offer_badge, redeemed_at, created_at
      FROM offer_claims
      WHERE claim_status = 'claimed' AND offer_id = $3
        AND (player_id = ANY($1) OR regexp_replace(mobile_number, '[^0-9]', '', 'g') = $2)
      ORDER BY redeemed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `, [playerIds, mobile, offerId]);
    const loadCustomer = (q) => q.queryOne(`
      ${VERIFIED_CUSTOMERS_SQL}
      SELECT mobile, best_score, player_ids, names, profile_names FROM customers WHERE mobile = $2
    `, [getOfferMinScore(), mobile]);

    try {
      const result = await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`offer-claim:${mobile}`]);

        const customer = await loadCustomer(tx);
        if (!customer) {
          return { error: 404, message: "No verified customer with a qualifying score was found for this mobile number." };
        }
        const playerIds = customer.player_ids;
        const latest = await tx.queryOne(`
          SELECT claim_id, offer_id, offer_title, offer_badge, full_name
          FROM offer_claims
          WHERE player_id = ANY($1) OR regexp_replace(mobile_number, '[^0-9]', '', 'g') = $2
          ORDER BY created_at DESC
          LIMIT 1
        `, [playerIds, mobile]);
        const offer = latest
          ? { id: latest.offer_id, title: latest.offer_title, badge: latest.offer_badge }
          : { id: DEFAULT_OFFER.id, title: DEFAULT_OFFER.title, badge: DEFAULT_OFFER.badge };

        const already = await findRedeemed(tx, playerIds, offer.id);
        if (already) return { alreadyClaimed: true, claim: claimView(already) };

        const nowIso = new Date().toISOString();
        // Reuse the latest unconfirmed record for this offer that belongs to this verified mobile.
        const pending = await tx.queryOne(`
          SELECT claim_id FROM offer_claims
          WHERE player_id = ANY($1) AND offer_id = $2 AND claim_status <> 'claimed'
            AND regexp_replace(mobile_number, '[^0-9]', '', 'g') = $3
          ORDER BY created_at DESC
          LIMIT 1
        `, [playerIds, offer.id, mobile]);
        if (pending) {
          const updated = await tx.queryOne(`
            UPDATE offer_claims SET claim_status = 'claimed', redeemed_at = $2
            WHERE claim_id = $1 AND claim_status <> 'claimed'
            RETURNING claim_id, offer_id, offer_title, offer_badge, redeemed_at, created_at
          `, [pending.claim_id, nowIso]);
          return { claimed: true, claim: claimView(updated) };
        }

        // No usable record: attach a new one to the customer's best qualifying game without a claim.
        const game = await tx.queryOne(`
          SELECT l.game_session_id, l.score
          FROM leaderboard l
          WHERE l.player_id = ANY($1) AND l.score >= $2 AND l.game_session_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM offer_claims c WHERE c.game_session_id = l.game_session_id)
          ORDER BY l.score DESC, l.submitted_at ASC
          LIMIT 1
        `, [playerIds, getOfferMinScore()]);
        if (!game) {
          return { error: 409, message: "This customer's game record cannot be linked to a claim." };
        }
        const names = describeCustomerNames(customer.profile_names, customer.names, latest && latest.full_name);
        const ownerRow = await tx.queryOne(
          "SELECT player_id FROM leaderboard WHERE game_session_id = $1", [game.game_session_id]);
        const inserted = await tx.queryOne(`
          INSERT INTO offer_claims (
            claim_id, game_session_id, player_id, full_name, mobile_number, email,
            verified_score, offer_id, offer_title, offer_badge, claim_status, created_at, redeemed_at
          ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, 'claimed', $10, $10)
          RETURNING claim_id, offer_id, offer_title, offer_badge, redeemed_at, created_at
        `, ["claim_" + crypto.randomUUID(), game.game_session_id, ownerRow.player_id,
            sanitizeString(names.name || "Customer", 100), `+${mobile}`,
            Number(game.score), offer.id, offer.title, offer.badge, nowIso]);
        return { claimed: true, claim: claimView(inserted) };
      });

      if (result.error) {
        return sendJson(res, result.error, { success: false, message: result.message });
      }
      return sendJson(res, 200, { success: true, alreadyClaimed: Boolean(result.alreadyClaimed), claim: result.claim }, { "Cache-Control": "no-store" });
    } catch (err) {
      if (err && err.code === "23505") {
        // A concurrent request won the race (unique index). Report the claim that now exists.
        try {
          const customer = await loadCustomer(db);
          if (customer) {
            const existing = await db.queryOne(`
              SELECT claim_id, offer_id, offer_title, offer_badge, redeemed_at, created_at FROM offer_claims
              WHERE claim_status = 'claimed' AND (player_id = ANY($1) OR regexp_replace(mobile_number, '[^0-9]', '', 'g') = $2)
              ORDER BY redeemed_at DESC NULLS LAST LIMIT 1`, [customer.player_ids, mobile]);
            if (existing) {
              return sendJson(res, 200, { success: true, alreadyClaimed: true, claim: claimView(existing) }, { "Cache-Control": "no-store" });
            }
          }
        } catch (_) {}
        return sendJson(res, 409, { success: false, message: "The claim was updated by another request. Please refresh and try again." });
      }
      console.error("Staff offer claim failed.");
      return sendJson(res, 500, { success: false, message: "Could not complete the claim. Please try again." });
    }
  }

  // -------------------------------------------------------------------------
  // 8. ADMIN API: GET /api/admin/analytics/events (Filterable Event History)
  // -------------------------------------------------------------------------
  if (pathname === "/api/admin/analytics/events" && method === "GET") {
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }

    try {
      const eventType = parsedUrl.searchParams.get("eventType") || "";
      const search = parsedUrl.searchParams.get("search") || "";
      const limit = Math.min(100, parseInt(parsedUrl.searchParams.get("limit") || "50", 10));

      let sql = "SELECT id, player_id, session_id, event_name, event_metadata, created_at FROM analytics_events WHERE 1=1";
      const params = [];
      let paramIdx = 1;

      if (eventType) {
        sql += ` AND event_name = $${paramIdx++}`;
        params.push(eventType);
      }
      if (search) {
        sql += ` AND (player_id LIKE $${paramIdx} OR session_id LIKE $${paramIdx + 1})`;
        params.push(`%${search}%`, `%${search}%`);
        paramIdx += 2;
      }

      sql += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
      params.push(limit);

      const rows = await db.query(sql, params);
      return sendJson(res, 200, { success: true, events: rows });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error fetching events history" });
    }
  }

  // -------------------------------------------------------------------------
  // 9. ADMIN API: GET /api/admin/analytics/player/:playerId (Timeline)
  // -------------------------------------------------------------------------
  if (pathname.startsWith("/api/admin/analytics/player/") && method === "GET") {
    if (!(await checkAdminAuth(req))) {
      return sendJson(res, 401, { success: false, message: "Unauthorized. Admin authentication required." });
    }

    try {
      const pid = pathname.substring("/api/admin/analytics/player/".length).trim();
      const rows = await db.query(`
        SELECT id, session_id, event_name, event_metadata, created_at
        FROM analytics_events
        WHERE player_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `, [pid]);

      return sendJson(res, 200, { success: true, events: rows });
    } catch (err) {
      return sendJson(res, 500, { success: false, message: "Error fetching player timeline" });
    }
  }

  // -------------------------------------------------------------------------
  // 10. ADMIN DASHBOARD: GET /admin/game-analytics
  // -------------------------------------------------------------------------
  if ((pathname === "/admin/game-analytics" || pathname === "/admin/game-analytics/") && method === "GET") {
    return serveAdminDashboardHtml(res);
  }

  // -------------------------------------------------------------------------
  // 11. STATIC FILE SERVING
  // -------------------------------------------------------------------------
  const requestedFile = pathname === "/" ? "/index.html" : pathname;
  if (!isPublicStaticPath(requestedFile)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    res.end("404 Not Found");
    return;
  }
  const filePath = path.join(__dirname, requestedFile);

  serveStaticFile(req, res, filePath);
}

const server = http.createServer(handleRequest);

// Start server when run directly or in non-serverless test/dev environments
if (require.main === module || (!process.env.NETLIFY && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.SERVERLESS)) {
  dbReadyPromise.then(() => {
    server.listen(PORT, () => {
      console.log(`MOZON "Bucket Catch The Broast" Server listening on http://localhost:${PORT}`);
      console.log(`Admin Game Analytics Dashboard: http://localhost:${PORT}/admin/game-analytics`);
      console.log("Database backend: Neon PostgreSQL");
    });
  }).catch(error => {
    const message = error && error.message ? error.message : "Neon PostgreSQL initialization failed.";
    console.error(`FATAL: ${message} Server did not start.`);
    process.exitCode = 1;
  });
}

module.exports = server;
module.exports.server = server;
module.exports.handleRequest = handleRequest;
module.exports.dbReadyPromise = dbReadyPromise;
