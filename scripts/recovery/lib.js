/**
 * Shared helpers for offer_claims recovery.
 *
 * Safety properties:
 *  - Connection strings are never printed. Errors are reduced to a code.
 *  - TLS rules match db.js: verified TLS for every remote host; plaintext only for an explicit
 *    sslmode=disable on a loopback host (used for local rehearsal databases).
 *  - All reads run inside `BEGIN TRANSACTION READ ONLY`, which PostgreSQL enforces server-side
 *    and which works through Neon's transaction pooler.
 *  - No customer names or mobile numbers are ever printed; reports show only claim IDs,
 *    timestamps, scores, offer IDs and classification reasons.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const parseConnectionString = require("pg-connection-string");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");

// The exact offer_claims columns (production schema verified read-only). Every column is copied
// verbatim so claim IDs, player associations, offer snapshot, mobile and timestamps are preserved.
const CLAIM_COLUMNS = [
  "claim_id", "game_session_id", "player_id", "full_name", "mobile_number", "email",
  "verified_score", "offer_id", "offer_title", "offer_badge", "claim_status", "created_at"
];

function readDotEnv() {
  const envPath = path.join(PROJECT_ROOT, ".env");
  const values = {};
  if (!fs.existsSync(envPath)) return values;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const i = line.indexOf("=");
    if (i < 1) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, i).trim()] = value;
  }
  return values;
}

/** Production = DATABASE_URL, recovery branch = RECOVERY_DATABASE_URL (process env wins over .env). */
function loadUrls() {
  const dotEnv = readDotEnv();
  const productionUrl = process.env.DATABASE_URL || dotEnv.DATABASE_URL || "";
  const recoveryUrl = process.env.RECOVERY_DATABASE_URL || dotEnv.RECOVERY_DATABASE_URL || "";
  if (!productionUrl) throw new Error("DATABASE_URL (production) is not configured.");
  if (!recoveryUrl) throw new Error("RECOVERY_DATABASE_URL is not configured. Add the recovery branch connection string to .env.");
  if (targetKey(productionUrl) === targetKey(recoveryUrl)) {
    throw new Error("RECOVERY_DATABASE_URL points at the same endpoint and database as DATABASE_URL. Use the recovery branch's own connection string.");
  }
  return { productionUrl, recoveryUrl };
}

function targetKey(value) {
  const u = new URL(value);
  return `${u.hostname.replace(/-pooler(?=\.)/, "")}:${u.port || "5432"}${u.pathname}`;
}

/** Non-secret label: Neon endpoint id only (e.g. ep-abc-123), never credentials. */
function endpointLabel(value) {
  const host = new URL(value).hostname;
  return host.split(".")[0].replace(/-pooler$/, "");
}

function createPool(connectionString) {
  const parsedUrl = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) throw new Error("Connection string must use the PostgreSQL scheme.");
  const config = parseConnectionString(connectionString);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedUrl.hostname);
  let ssl = false;
  if (!(config.ssl === false && loopback)) {
    ssl = { ...(config.ssl || {}) };
    delete ssl.checkServerIdentity;
    ssl.rejectUnauthorized = true;
  }
  return new Pool({ ...config, ssl, max: 1, connectionTimeoutMillis: 15000, application_name: "soofi-mandi-claims-recovery" });
}

/** Runs `fn(client)` inside a server-enforced read-only transaction. */
async function readOnly(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function safeError(error) {
  return (error && (error.code || (error.cause && error.cause.code))) || (error && error.message && !/postgres(ql)?:\/\//i.test(error.message) ? error.message : "UNKNOWN");
}

// ---------------------------------------------------------------------------
// Test-record classification. Fixture values come from this repository's test suites
// (committed and current). They are fake test data, not customer data.
// ---------------------------------------------------------------------------
const TEST_PLAYER_ID_PREFIXES = [
  "test-", "test_", "player_sub99_", "player_sub105_", "player_low_", "rate-limit-prod-", "v2-player-", "diag-"
];
const TEST_FULL_NAMES = new Set([
  "a", "ahmed al-mandi", "claim test", "fatima al-nuaimi", "fatima al-zahra", "hussain al-yemeni",
  "tariq al-mansoor", "tariq feaster", "tariq mansoor", "test eligible", "test under", "test under 100",
  "test user", "zayd al-harbi"
].map(s => s.toLowerCase()));
const TEST_MOBILE_DIGITS = new Set([
  "123", "910000000000", "919111111111", "919876500001", "919876500002", "919876543210",
  "919876543211", "966501234567", "966559876543", "967771234567"
]);
const TEST_EMAIL_DOMAINS = ["example.com", "soofimandi.com"];

function mobileFormat(mobile) {
  if (typeof mobile !== "string") return "missing";
  if (/^\+91[6-9]\d{9}$/.test(mobile)) return "verified-otp-format";
  return "legacy-free-text";
}

/**
 * Returns { category, reasons } where category is:
 *  - "test":           matches a test fixture (player-id prefix, fixture name/mobile/email)
 *  - "genuine":        no test markers, OTP-verified +91 mobile
 *  - "genuine-legacy": no test markers, claimed before OTP login (mobile was typed, not verified)
 *  - "review":         no test markers but fails an integrity rule (e.g. score below 100)
 * Reasons never contain the personal values themselves.
 */
function classifyClaim(row) {
  const reasons = [];
  const pid = String(row.player_id || "");
  if (TEST_PLAYER_ID_PREFIXES.some(p => pid.startsWith(p))) reasons.push("test player-id prefix");
  if (TEST_FULL_NAMES.has(String(row.full_name || "").trim().toLowerCase())) reasons.push("test fixture name");
  const digits = String(row.mobile_number || "").replace(/\D/g, "");
  if (TEST_MOBILE_DIGITS.has(digits)) reasons.push("test fixture mobile");
  const email = String(row.email || "").toLowerCase();
  if (email && TEST_EMAIL_DOMAINS.some(d => email.endsWith("@" + d))) reasons.push("test fixture email domain");
  if (reasons.length) return { category: "test", reasons };

  if (Number(row.verified_score) < 100) return { category: "review", reasons: ["verified score below 100"] };
  if (mobileFormat(row.mobile_number) !== "verified-otp-format") {
    return { category: "genuine-legacy", reasons: ["no test markers; pre-OTP claim (mobile typed by customer, not OTP-verified)"] };
  }
  return { category: "genuine", reasons: ["no test markers; OTP-verified mobile format"] };
}

/** Stable SHA-256 over the full row, so a restore can prove it inserts exactly what was reviewed. */
function rowDigest(row) {
  const normalized = CLAIM_COLUMNS.map(c => {
    const v = row[c];
    if (v instanceof Date) return v.toISOString();
    return v === null || v === undefined ? null : String(v);
  });
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

module.exports = {
  CLAIM_COLUMNS, OUT_DIR, loadUrls, endpointLabel, createPool, readOnly, safeError,
  classifyClaim, mobileFormat, rowDigest
};
