#!/usr/bin/env node
/**
 * Verifies that every SQLite migration (`db/NNN_name.sql`) has a matching
 * PostgreSQL twin (`db/NNN_name_postgres.sql`) unless listed in
 * `db/postgres-twin-exceptions.json` with a non-empty `reason`, and that no
 * orphan `_postgres.sql` file exists without its SQLite counterpart (#1520).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DB_DIR = path.resolve(__dirname, '../db');
const EXCEPTIONS_FILENAME = 'postgres-twin-exceptions.json';

/**
 * Extract created table names from a SQL migration string.
 * @param {string} sql
 * @returns {string[]}
 */
function extractCreatedTables(sql) {
  const withoutComments = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const regex = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-zA-Z0-9_]+)"?)/gi;
  const tables = new Set();
  let match;
  while ((match = regex.exec(withoutComments)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  return [...tables].sort();
}

/**
 * Parse and validate `postgres-twin-exceptions.json`.
 * @param {string} exceptionsPath
 * @returns {{ map: Map<string, string>, errors: string[] }}
 */
function loadExceptions(exceptionsPath) {
  const map = new Map();
  const errors = [];

  if (!fs.existsSync(exceptionsPath)) {
    return { map, errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  } catch (err) {
    errors.push(`Failed to parse ${path.basename(exceptionsPath)}: ${err.message}`);
    return { map, errors };
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.exceptions)
      ? parsed.exceptions
      : parsed && typeof parsed === 'object'
        ? Object.entries(parsed).map(([file, val]) =>
            typeof val === 'string' ? { file, reason: val } : { file, ...(val || {}) },
          )
        : null;

  if (!entries) {
    errors.push(
      `${path.basename(exceptionsPath)} must contain an "exceptions" array of { "file", "reason" } objects.`,
    );
    return { map, errors };
  }

  for (const entry of entries) {
    const file = typeof entry?.file === 'string' ? entry.file.trim() : '';
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (!file) {
      errors.push(`Allowlist entry in ${path.basename(exceptionsPath)} is missing a valid "file" name.`);
      continue;
    }
    if (!reason) {
      errors.push(
        `Allowlist entry "${file}" in ${path.basename(exceptionsPath)} must include a non-empty "reason" string.`,
      );
      continue;
    }
    map.set(file, reason);
  }

  return { map, errors };
}

/**
 * Run the migration twin parity checks against `dbDir`.
 * @param {string} [dbDir]
 * @returns {{
 *   ok: boolean,
 *   missingPostgresTwins: string[],
 *   orphanPostgresFiles: string[],
 *   invalidAllowlistEntries: string[],
 *   staleAllowlistEntries: string[],
 *   tableWarnings: string[],
 *   errors: string[]
 * }}
 */
function checkMigrationTwins(dbDir = DEFAULT_DB_DIR) {
  const exceptionsPath = path.join(dbDir, EXCEPTIONS_FILENAME);
  const { map: allowlist, errors: allowlistErrors } = loadExceptions(exceptionsPath);

  const sqlFiles = fs
    .readdirSync(dbDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const sqliteFiles = sqlFiles.filter((f) => !f.endsWith('_postgres.sql'));
  const postgresFiles = sqlFiles.filter((f) => f.endsWith('_postgres.sql'));

  const sqliteSet = new Set(sqliteFiles);
  const postgresSet = new Set(postgresFiles);

  const missingPostgresTwins = [];
  const orphanPostgresFiles = [];
  const staleAllowlistEntries = [];
  const tableWarnings = [];

  for (const sqliteFile of sqliteFiles) {
    const expectedTwin = sqliteFile.replace(/\.sql$/, '_postgres.sql');
    if (!postgresSet.has(expectedTwin)) {
      if (!allowlist.has(sqliteFile)) {
        missingPostgresTwins.push(
          `${sqliteFile} is missing its PostgreSQL twin (${expectedTwin})`,
        );
      }
    } else {
      const sqliteTables = extractCreatedTables(
        fs.readFileSync(path.join(dbDir, sqliteFile), 'utf8'),
      );
      const pgTables = extractCreatedTables(
        fs.readFileSync(path.join(dbDir, expectedTwin), 'utf8'),
      );
      if (sqliteTables.join(',') !== pgTables.join(',')) {
        tableWarnings.push(
          `CREATE TABLE mismatch between ${sqliteFile} ([${sqliteTables.join(', ')}]) and ${expectedTwin} ([${pgTables.join(', ')}])`,
        );
      }
    }
  }

  for (const pgFile of postgresFiles) {
    const expectedSqlite = pgFile.replace(/_postgres\.sql$/, '.sql');
    if (!sqliteSet.has(expectedSqlite)) {
      orphanPostgresFiles.push(
        `${pgFile} has no matching SQLite migration (${expectedSqlite})`,
      );
    }
  }

  for (const allowedFile of allowlist.keys()) {
    const twin = allowedFile.replace(/\.sql$/, '_postgres.sql');
    if (!sqliteSet.has(allowedFile)) {
      staleAllowlistEntries.push(
        `Allowlisted migration "${allowedFile}" does not exist in ${dbDir}`,
      );
    } else if (postgresSet.has(twin)) {
      staleAllowlistEntries.push(
        `Allowlisted migration "${allowedFile}" already has a PostgreSQL twin (${twin}); remove it from ${EXCEPTIONS_FILENAME}`,
      );
    }
  }

  const errors = [
    ...allowlistErrors,
    ...missingPostgresTwins,
    ...orphanPostgresFiles,
    ...staleAllowlistEntries,
  ];

  return {
    ok: errors.length === 0,
    missingPostgresTwins,
    orphanPostgresFiles,
    invalidAllowlistEntries: allowlistErrors,
    staleAllowlistEntries,
    tableWarnings,
    errors,
  };
}

if (require.main === module) {
  const result = checkMigrationTwins();
  for (const warning of result.tableWarnings) {
    console.warn(`[check-migrations] WARNING: ${warning}`);
  }
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`[check-migrations] ERROR: ${err}`);
    }
    process.exit(1);
  }
  console.log('[check-migrations] All SQLite and PostgreSQL migration twins are in sync.');
}

module.exports = {
  checkMigrationTwins,
  extractCreatedTables,
  loadExceptions,
  EXCEPTIONS_FILENAME,
};
