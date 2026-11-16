const fs = require('node:fs');
const path = require('node:path');

function readDotEnvDatabaseUrl() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find(entry => /^\s*DATABASE_URL\s*=/.test(entry));
  if (!line) return '';
  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
}

function targetKey(value) {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return "";
    return `${url.protocol}//${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch (_) {
    return '';
  }
}

const testUrl = process.env.TEST_DATABASE_URL || '';
const configuredUrl = process.env.DATABASE_URL || readDotEnvDatabaseUrl();
if (!testUrl) {
  console.error('TEST_DATABASE_URL is required. Use a dedicated PostgreSQL test database; tests will not use .env DATABASE_URL.');
  process.exit(1);
}
if (targetKey(testUrl) === targetKey(configuredUrl)) {
  console.error('TEST_DATABASE_URL must point to a different PostgreSQL database from DATABASE_URL.');
  process.exit(1);
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;
