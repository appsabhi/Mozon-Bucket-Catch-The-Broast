#!/usr/bin/env node
/**
 * Restores missing offer_claims rows from the Neon recovery branch into production.
 *
 * DRY RUN (default; read-only on both databases):
 *   node scripts/recovery/restore_claims.js --categories=genuine,genuine-legacy
 *
 * EXECUTE (only after explicit approval of the reviewed manifest):
 *   node scripts/recovery/restore_claims.js --categories=genuine,genuine-legacy --execute --confirm=<manifest_hash>
 *
 * Options:
 *   --categories=a,b     Required. Which manifest categories to restore (genuine, genuine-legacy).
 *   --exclude=id1,id2    Claim IDs to leave out.
 *   --execute            Write to production. Without it nothing is written.
 *   --confirm=<hash>     Must equal manifest_hash in out/recovery_manifest.json.
 *
 * Guarantees:
 *   - INSERT only. No UPDATE, DELETE, DROP or TRUNCATE anywhere in this script.
 *   - Each row is re-read from the recovery branch and must match the reviewed digest exactly.
 *   - Rows are copied verbatim (claim_id, player_id, game_session_id, name, mobile, email,
 *     score, offer snapshot, status, created_at).
 *   - Duplicates are impossible: claims already present (by claim_id or game_session_id) are
 *     skipped up front, and the INSERT uses ON CONFLICT DO NOTHING as a second guard.
 *   - One transaction: if the inserted count or the post-insert digests differ from the plan,
 *     the whole transaction is rolled back.
 *   - Never prints names, mobile numbers, emails or connection strings.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CLAIM_COLUMNS, OUT_DIR, loadUrls, endpointLabel, createPool, readOnly, safeError, rowDigest } = require("./lib");

function parseArgs(argv) {
  const args = { categories: [], exclude: new Set(), execute: false, confirm: "" };
  for (const a of argv) {
    if (a.startsWith("--categories=")) args.categories = a.slice(13).split(",").map(s => s.trim()).filter(Boolean);
    else if (a.startsWith("--exclude=")) a.slice(10).split(",").map(s => s.trim()).filter(Boolean).forEach(id => args.exclude.add(id));
    else if (a === "--execute") args.execute = true;
    else if (a.startsWith("--confirm=")) args.confirm = a.slice(10).trim();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.categories.length) throw new Error("--categories is required (e.g. --categories=genuine,genuine-legacy).");
  const allowed = new Set(["genuine", "genuine-legacy"]);
  for (const c of args.categories) if (!allowed.has(c)) throw new Error(`Category '${c}' cannot be restored by this script.`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(OUT_DIR, "recovery_manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("No manifest found. Run compare_claims.js first.");
  const { manifest_hash: storedHash, ...manifestBody } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const recomputed = crypto.createHash("sha256").update(JSON.stringify(manifestBody)).digest("hex");
  if (recomputed !== storedHash) throw new Error("Manifest file was modified after it was generated. Re-run compare_claims.js.");

  const { productionUrl, recoveryUrl } = loadUrls();
  if (endpointLabel(productionUrl) !== manifestBody.production_endpoint || endpointLabel(recoveryUrl) !== manifestBody.recovery_endpoint) {
    throw new Error("Configured endpoints differ from the ones the manifest was generated against.");
  }
  if (args.execute && args.confirm !== storedHash) {
    throw new Error("--execute requires --confirm=<manifest_hash> matching the reviewed manifest.");
  }

  const planned = manifestBody.claims.filter(e => e.restorable && args.categories.includes(e.category) && !args.exclude.has(e.claim_id));
  console.log(`Mode: ${args.execute ? "EXECUTE (writes to production)" : "DRY RUN (read-only)"}`);
  console.log(`Production endpoint: ${manifestBody.production_endpoint}   Recovery endpoint: ${manifestBody.recovery_endpoint}`);
  console.log(`Planned from manifest: ${planned.length} claim(s) [categories: ${args.categories.join(", ")}; excluded: ${args.exclude.size}]`);
  if (!planned.length) return;

  const production = createPool(productionUrl);
  const recovery = createPool(recoveryUrl);
  try {
    // 1. Re-read rows from the recovery branch; each must match the reviewed digest.
    const colList = CLAIM_COLUMNS.join(", ");
    const ids = planned.map(e => e.claim_id);
    const sourceRows = await readOnly(recovery, async c =>
      (await c.query(`SELECT ${colList} FROM offer_claims WHERE claim_id = ANY($1::text[])`, [ids])).rows);
    const byId = new Map(sourceRows.map(r => [r.claim_id, r]));
    for (const e of planned) {
      const row = byId.get(e.claim_id);
      if (!row) throw new Error(`Claim ${e.claim_id} is no longer in the recovery branch.`);
      if (rowDigest(row) !== e.digest) throw new Error(`Claim ${e.claim_id} differs from the reviewed version. Re-run compare_claims.js.`);
    }

    // 2. Re-check production (read-only): skip anything already present; parents must exist.
    const pre = await readOnly(production, async c => {
      const present = new Set((await c.query("SELECT claim_id FROM offer_claims WHERE claim_id = ANY($1::text[])", [ids])).rows.map(r => r.claim_id));
      const sessions = planned.map(e => byId.get(e.claim_id).game_session_id);
      const sessionTaken = new Set((await c.query("SELECT game_session_id FROM offer_claims WHERE game_session_id = ANY($1::text[])", [sessions])).rows.map(r => r.game_session_id));
      const lb = new Map((await c.query("SELECT game_session_id, player_id FROM leaderboard WHERE game_session_id = ANY($1::text[])", [sessions])).rows.map(r => [r.game_session_id, r.player_id]));
      const players = new Set((await c.query("SELECT player_id FROM players WHERE player_id = ANY($1::text[])", [planned.map(e => byId.get(e.claim_id).player_id)])).rows.map(r => r.player_id));
      return { present, sessionTaken, lb, players };
    });

    const toInsert = [];
    for (const e of planned) {
      const row = byId.get(e.claim_id);
      if (pre.present.has(row.claim_id)) { console.log(`  skip ${row.claim_id}: already in production`); continue; }
      if (pre.sessionTaken.has(row.game_session_id)) { console.log(`  skip ${row.claim_id}: game session already claimed in production`); continue; }
      if (pre.lb.get(row.game_session_id) !== row.player_id) throw new Error(`Claim ${row.claim_id}: leaderboard parent missing or owned by another player.`);
      if (!pre.players.has(row.player_id)) throw new Error(`Claim ${row.claim_id}: player parent missing.`);
      toInsert.push(row);
    }
    console.log(`Verified against recovery digests and production state: ${toInsert.length} claim(s) to insert.`);
    for (const row of toInsert) console.log(`  ${row.claim_id}  ${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}  score=${row.verified_score}  offer=${row.offer_id}`);

    if (!args.execute) {
      console.log(`\nDRY RUN complete. Nothing was written.`);
      console.log(`To execute after approval: --execute --confirm=${storedHash}`);
      return;
    }
    if (!toInsert.length) { console.log("Nothing to insert."); return; }

    // 3. Single INSERT-only transaction on production with post-insert verification.
    const client = await production.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const placeholders = CLAIM_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
      const inserted = [];
      for (const row of toInsert) {
        const r = await client.query(
          `INSERT INTO offer_claims (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING claim_id`,
          CLAIM_COLUMNS.map(c => row[c])
        );
        if (r.rowCount === 1) inserted.push(r.rows[0].claim_id);
      }
      if (inserted.length !== toInsert.length) {
        throw new Error(`Inserted ${inserted.length} of ${toInsert.length}; rolling back.`);
      }
      const after = (await client.query(`SELECT ${colList} FROM offer_claims WHERE claim_id = ANY($1::text[])`, [inserted])).rows;
      const expected = new Map(toInsert.map(r => [r.claim_id, rowDigest(r)]));
      for (const row of after) {
        if (rowDigest(row) !== expected.get(row.claim_id)) throw new Error(`Post-insert verification failed for ${row.claim_id}; rolling back.`);
      }
      if (after.length !== inserted.length) throw new Error("Post-insert row count mismatch; rolling back.");
      await client.query("COMMIT");

      const resultPath = path.join(OUT_DIR, "restore_result.json");
      fs.writeFileSync(resultPath, JSON.stringify({
        restored_at: new Date().toISOString(), manifest_hash: storedHash, inserted_claim_ids: inserted
      }, null, 2));
      console.log(`\nCOMMITTED: ${inserted.length} claim(s) restored and verified byte-for-byte. Log: ${path.relative(process.cwd(), resultPath)}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await Promise.all([production.end(), recovery.end()]);
  }
}

main().catch(error => {
  console.error(`Restore aborted: ${safeError(error)}`);
  process.exitCode = 1;
});
