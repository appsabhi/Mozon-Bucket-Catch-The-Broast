/**
 * PostgreSQL access layer for local development and production.
 * DATABASE_URL is required in every environment; there is no alternate store.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const parseConnectionString = require('pg-connection-string');

function isProductionEnvironment() {
  return process.env.NODE_ENV === 'production'
    || process.env.CONTEXT === 'production'
    || process.env.VERCEL_ENV === 'production';
}

function loadLocalEnv() {
  if (isProductionEnvironment() || process.env.NODE_ENV === 'test') return;
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const DATABASE_URL = process.env.NODE_ENV === 'test'
  ? (process.env.TEST_DATABASE_URL || '')
  : (process.env.DATABASE_URL || '');

let pool = null;
let initialization = null;

function createSafeDatabaseError(error, phase) {
  const code = (error && (error.code || (error.cause && error.cause.code))) || 'DATABASE_ERROR';
  const message = code === 'ENOTFOUND'
    ? 'Neon PostgreSQL hostname could not be resolved. Check the current Neon endpoint in DATABASE_URL and the machine DNS/network.'
    : `Neon PostgreSQL ${phase} failed (${code}). Check DATABASE_URL, network access, and database availability.`;
  const safeError = new Error(message);
  safeError.code = code;
  return safeError;
}

function getPoolConfig(connectionString) {
  const parsedUrl = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL URL scheme.');
  }
  const parsedConfig = parseConnectionString(connectionString);
  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]', '::1'];
  // Plaintext is allowed only for an explicit sslmode=disable against a loopback test/dev server
  // (e.g. a local PostgreSQL using trust auth). Every remote host, including Neon, uses verified TLS.
  const plaintextLoopback = parsedConfig.ssl === false && loopbackHosts.includes(parsedUrl.hostname);

  if (!parsedUrl.hostname || !parsedUrl.username || (!parsedUrl.password && !plaintextLoopback) || !parsedUrl.pathname || parsedUrl.pathname === '/') {
    throw new Error('DATABASE_URL is missing a database host, credentials, or database name.');
  }

  let ssl = false;
  if (!plaintextLoopback) {
    ssl = { ...(parsedConfig.ssl || {}) };
    // Do not permit connection-string options to disable certificate or hostname checks.
    delete ssl.checkServerIdentity;
    ssl.rejectUnauthorized = true;
  }

  return {
    ...parsedConfig,
    ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    application_name: 'soofi-mandi-catch-the-feast'
  };
}

async function runMigrations(client) {
  const migrationFiles = [
    '002_neon_schema.sql',
    '003_player_sessions.postgres.sql',
    '004_game_session_id.postgres.sql',
    '005_player_profile_name.postgres.sql',
    '006_game_sessions.postgres.sql',
    '007_offer_claim_redemption.postgres.sql'
  ];

  for (const file of migrationFiles) {
    const migrationPath = path.join(__dirname, 'migrations', file);
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await client.query(sql);
  }
}

async function initializePostgres() {
  if (!DATABASE_URL) {
    throw new Error(process.env.NODE_ENV === 'test'
      ? 'TEST_DATABASE_URL is required; tests never use the development or production database.'
      : 'DATABASE_URL is required for Neon PostgreSQL in every environment.');
  }

  try {
    const config = getPoolConfig(DATABASE_URL);
    pool = new Pool(config);
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      await runMigrations(client);
    } finally {
      client.release();
    }
  } catch (error) {
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
    throw createSafeDatabaseError(error, 'initialization');
  }
}

function init() {
  if (pool) return Promise.resolve();
  if (!initialization) {
    initialization = initializePostgres().catch(error => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

async function query(sql, params = []) {
  if (!pool) throw new Error('Neon PostgreSQL is not initialized.');
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (error) {
    const code = error && error.code ? error.code : 'QUERY_ERROR';
    console.error(`Neon PostgreSQL query failed (${code}).`);
    throw error;
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function transaction(callback) {
  if (!pool) throw new Error('Neon PostgreSQL is not initialized.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: async (sql, params = []) => (await client.query(sql, params)).rows,
      queryOne: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows.length ? result.rows[0] : null;
      }
    };
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isNeon() {
  return Boolean(pool);
}

function getActiveEngine() {
  return pool ? 'neon-postgresql' : 'uninitialized';
}

module.exports = { init, query, queryOne, transaction, isNeon, getActiveEngine };
