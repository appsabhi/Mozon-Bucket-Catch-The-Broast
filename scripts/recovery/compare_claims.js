#!/usr/bin/env node
/**
 * READ-ONLY comparison of offer_claims between the Neon recovery branch and production.
 *
 *   node scripts/recovery/compare_claims.js
 *
 * Needs DATABASE_URL (production) and RECOVERY_DATABASE_URL (recovery branch) in .env.
 * Every query runs in a server-enforced READ ONLY transaction on both databases.
 * Output contains claim IDs, timestamps, scores, offer IDs and classifications only —
 * never names, mobile numbers, emails, or connection strings.
 *
 * Writes scripts/recovery/out/recovery_manifest.json (no personal data) for restore_claims.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  CLAIM_COLUMNS, OUT_DIR, loadUrls, endpointLabel, createPool, readOnly, safeError,
  classifyClaim, mobileFormat, rowDigest
} = require("./lib");

const RESTORABLE_CATEGORIES = new Set(["genuine", "genuine-legacy"]);

async function claimColumns(client) {
  const r = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'offer_claims' ORDER BY ordinal_position"
  );
  return r.rows.map(x => x.column_name);
}

async function main() {
  const { productionUrl, recoveryUrl } = loadUrls();
  const production = createPool(productionUrl);
  const recovery = createPool(recoveryUrl);
  console.log(`Production endpoint: ${endpointLabel(productionUrl)}   Recovery endpoint: ${endpointLabel(recoveryUrl)}`);
  console.log("Mode: READ ONLY on both databases.\n");

  try {
    // 1. Schema check: both sides must have exactly the expected claim columns.
    const [prodCols, recCols] = await Promise.all([
      readOnly(production, claimColumns),
      readOnly(recovery, claimColumns)
    ]);
    for (const [label, cols] of [["production", prodCols], ["recovery", recCols]]) {
      const missing = CLAIM_COLUMNS.filter(c => !cols.includes(c));
      if (missing.length) throw new Error(`${label} offer_claims is missing columns: ${missing.join(", ")}`);
    }

    // 2. Snapshot both sides.
    const colList = CLAIM_COLUMNS.join(", ");
    const recoveryData = await readOnly(recovery, async c => ({
      claims: (await c.query(`SELECT ${colList} FROM offer_claims ORDER BY created_at`)).rows,
      counts: (await c.query(`SELECT
          (SELECT COUNT(*)::int FROM offer_claims) AS claims,
          (SELECT COUNT(*)::int FROM leaderboard) AS leaderboard,
          (SELECT COUNT(*)::int FROM players) AS players,
          (SELECT MAX(created_at)::text FROM offer_claims) AS latest_claim,
          (SELECT MAX(submitted_at)::text FROM leaderboard) AS latest_score`)).rows[0]
    }));
    const productionData = await readOnly(production, async c => ({
      claims: (await c.query("SELECT claim_id, game_session_id FROM offer_claims")).rows,
      counts: (await c.query(`SELECT
          (SELECT COUNT(*)::int FROM offer_claims) AS claims,
          (SELECT COUNT(*)::int FROM leaderboard) AS leaderboard,
          (SELECT COUNT(*)::int FROM players) AS players`)).rows[0]
    }));

    console.log("Recovery branch: ", JSON.stringify(recoveryData.counts));
    console.log("Production now:  ", JSON.stringify(productionData.counts), "\n");

    const prodClaimIds = new Set(productionData.claims.map(r => r.claim_id));
    const prodSessionToClaim = new Map(productionData.claims.map(r => [r.game_session_id, r.claim_id]));
    const recoveryIds = new Set(recoveryData.claims.map(r => r.claim_id));
    const missing = recoveryData.claims.filter(r => !prodClaimIds.has(r.claim_id));
    const onlyInProduction = productionData.claims.filter(r => !recoveryIds.has(r.claim_id)).length;

    // 3. Integrity checks for each missing claim against current production (read-only).
    const checks = await readOnly(production, async c => {
      const out = new Map();
      for (const row of missing) {
        const lb = (await c.query("SELECT player_id, score FROM leaderboard WHERE game_session_id = $1", [row.game_session_id])).rows[0];
        const player = (await c.query("SELECT 1 FROM players WHERE player_id = $1", [row.player_id])).rowCount === 1;
        const event = (await c.query(
          "SELECT 1 FROM analytics_events WHERE event_name = 'offer_claim_success' AND event_metadata->>'claimId' = $1 LIMIT 1", [row.claim_id]
        )).rowCount === 1;
        const conflictingClaim = prodSessionToClaim.get(row.game_session_id);
        out.set(row.claim_id, {
          leaderboardRowPresent: Boolean(lb),
          leaderboardPlayerMatches: Boolean(lb && lb.player_id === row.player_id),
          leaderboardScoreMatches: Boolean(lb && Number(lb.score) === Number(row.verified_score)),
          playerRowPresent: player,
          claimEventPresent: event,
          gameSessionAlreadyClaimed: Boolean(conflictingClaim && conflictingClaim !== row.claim_id)
        });
      }
      return out;
    });

    // 4. Classify and build the manifest (no personal data).
    const entries = missing.map(row => {
      const { category, reasons } = classifyClaim(row);
      const ck = checks.get(row.claim_id);
      const blockers = [];
      if (!ck.leaderboardRowPresent) blockers.push("leaderboard row missing in production (FK)");
      if (ck.leaderboardRowPresent && !ck.leaderboardPlayerMatches) blockers.push("leaderboard row belongs to a different player");
      if (!ck.playerRowPresent) blockers.push("player row missing in production (FK)");
      if (ck.gameSessionAlreadyClaimed) blockers.push("game session already has a different claim in production");
      if (!RESTORABLE_CATEGORIES.has(category)) blockers.push(`category '${category}' is not restored by default`);
      return {
        claim_id: row.claim_id,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        verified_score: Number(row.verified_score),
        offer_id: row.offer_id,
        claim_status: row.claim_status,
        mobile_format: mobileFormat(row.mobile_number),
        has_email: row.email !== null && row.email !== "",
        category,
        reasons,
        checks: ck,
        restorable: blockers.length === 0,
        blockers,
        digest: rowDigest(row)
      };
    });

    const manifestBody = {
      generated_at: new Date().toISOString(),
      production_endpoint: endpointLabel(productionUrl),
      recovery_endpoint: endpointLabel(recoveryUrl),
      recovery_counts: recoveryData.counts,
      production_counts: productionData.counts,
      claims: entries
    };
    const manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifestBody)).digest("hex");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const manifestPath = path.join(OUT_DIR, "recovery_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ manifest_hash: manifestHash, ...manifestBody }, null, 2));

    // 5. Report.
    const byCategory = entries.reduce((m, e) => (m[e.category] = (m[e.category] || 0) + 1, m), {});
    console.log(`Claims in recovery but missing from production: ${missing.length}`);
    console.log(`Claims in production but not in recovery (created after the branch point): ${onlyInProduction}`);
    console.log("By category:", JSON.stringify(byCategory));
    console.log(`Restorable now (genuine + genuine-legacy, all integrity checks pass): ${entries.filter(e => e.restorable).length}\n`);

    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad("claim_id", 44) + pad("created_at (UTC)", 26) + pad("score", 7) + pad("offer_id", 13) + pad("mobile", 22) + pad("category", 16) + "restore / notes");
    for (const e of entries) {
      const notes = e.restorable ? "YES" : "no: " + e.blockers.join("; ");
      const evt = e.checks.claimEventPresent ? "" : " [no claim event]";
      console.log(pad(e.claim_id, 44) + pad(e.created_at, 26) + pad(e.verified_score, 7) + pad(e.offer_id, 13) + pad(e.mobile_format, 22) + pad(e.category, 16) + notes + evt + `  (${e.reasons.join(", ")})`);
    }
    console.log(`\nManifest written: ${path.relative(process.cwd(), manifestPath)}`);
    console.log(`Manifest hash (needed to approve a restore): ${manifestHash}`);
  } finally {
    await Promise.all([production.end(), recovery.end()]);
  }
}

main().catch(error => {
  console.error(`Comparison failed: ${safeError(error)}`);
  process.exitCode = 1;
});
