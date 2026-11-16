const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const parseConnectionString = require('pg-connection-string');

function loadDevelopmentDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.NODE_ENV === 'production') return '';
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find(item => /^\s*DATABASE_URL\s*=/.test(item));
  if (!line) return '';
  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
}

async function main() {
  const databaseUrl = loadDevelopmentDatabaseUrl();
  if (!databaseUrl) {
    console.error('DATABASE_URL is not configured.');
    process.exitCode = 1;
    return;
  }

  let pool;
  try {
    const config = parseConnectionString(databaseUrl);
    config.ssl = { ...(config.ssl || {}), rejectUnauthorized: true };
    pool = new Pool({ ...config, connectionTimeoutMillis: 8000, max: 1 });
    await pool.query('SELECT 1');
    console.log('PostgreSQL connectivity: OK (TLS certificate verification enabled).');
  } catch (error) {
    const code = error && (error.code || (error.cause && error.cause.code)) || 'CONNECTION_FAILED';
    console.error(`PostgreSQL connectivity: FAILED (${code}).`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

main();
