/**
 * Runs every tests/test_*.js suite sequentially against the dedicated PostgreSQL test database.
 *
 * Requires TEST_DATABASE_URL (a database separate from DATABASE_URL). Example for a local server:
 *   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/soofi_mandi_test?sslmode=disable" npm run test:all
 * Browser suites additionally need Google Chrome at the default Windows install path.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Children get the original environment: require_test_database rewrites DATABASE_URL/NODE_ENV in
// this process, and each suite re-runs that guard itself.
const childEnv = { ...process.env };
require("./require_test_database"); // fail fast with a clear message if the test DB is not configured

const testsDir = __dirname;
const suites = fs.readdirSync(testsDir).filter(f => /^test_.*\.js$/.test(f)).sort();
const results = [];

for (const suite of suites) {
  console.log(`\n######## ${suite} ########`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(testsDir, suite)], {
    stdio: "inherit",
    env: childEnv,
    timeout: 5 * 60 * 1000
  });
  results.push({ suite, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\n================ ALL SUITES ================");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.suite}  (${r.seconds}s)`);
const failedCount = results.filter(r => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} suites passed`);
process.exit(failedCount ? 1 : 0);
