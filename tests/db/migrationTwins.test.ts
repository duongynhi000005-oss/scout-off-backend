import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  checkMigrationTwins,
  extractCreatedTables,
  EXCEPTIONS_FILENAME,
} = require('../../scripts/check-migrations');

describe('migrationTwins parity checker (#1520)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-off-migration-twins-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for the repository db/ directory', () => {
    const repoDbDir = path.resolve(__dirname, '../../db');
    const result = checkMigrationTwins(repoDbDir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails with a readable message when a SQLite migration is missing its _postgres.sql twin', () => {
    fs.writeFileSync(path.join(tmpDir, '001_init.sql'), 'CREATE TABLE users (id INTEGER PRIMARY KEY);');
    fs.writeFileSync(path.join(tmpDir, '001_init_postgres.sql'), 'CREATE TABLE users (id SERIAL PRIMARY KEY);');
    fs.writeFileSync(path.join(tmpDir, '002_missing_twin.sql'), 'CREATE TABLE items (id INTEGER PRIMARY KEY);');

    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.missingPostgresTwins).toEqual([
      '002_missing_twin.sql is missing its PostgreSQL twin (002_missing_twin_postgres.sql)',
    ]);
  });

  it('detects the reverse case: an orphan _postgres.sql file with no SQLite twin', () => {
    fs.writeFileSync(path.join(tmpDir, '003_orphan_postgres.sql'), 'CREATE TABLE audit (id SERIAL PRIMARY KEY);');

    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.orphanPostgresFiles).toEqual([
      '003_orphan_postgres.sql has no matching SQLite migration (003_orphan.sql)',
    ]);
  });

  it('requires a non-empty reason for each allowlist entry in postgres-twin-exceptions.json', () => {
    fs.writeFileSync(path.join(tmpDir, '004_unpaired.sql'), 'ALTER TABLE users ADD COLUMN role TEXT;');
    fs.writeFileSync(
      path.join(tmpDir, EXCEPTIONS_FILENAME),
      JSON.stringify({
        exceptions: [{ file: '004_unpaired.sql', reason: '   ' }],
      }),
    );

    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.invalidAllowlistEntries).toEqual([
      'Allowlist entry "004_unpaired.sql" in postgres-twin-exceptions.json must include a non-empty "reason" string.',
    ]);
  });

  it('accepts an allowlisted SQLite migration when a valid reason is provided', () => {
    fs.writeFileSync(path.join(tmpDir, '004_unpaired.sql'), 'ALTER TABLE users ADD COLUMN role TEXT;');
    fs.writeFileSync(
      path.join(tmpDir, EXCEPTIONS_FILENAME),
      JSON.stringify({
        exceptions: [
          {
            file: '004_unpaired.sql',
            reason: 'Tracked in #1561 — portable SQL translated by convertSqlToPostgres().',
          },
        ],
      }),
    );

    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('flags stale allowlist entries when the _postgres.sql twin already exists', () => {
    fs.writeFileSync(path.join(tmpDir, '005_paired.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
    fs.writeFileSync(path.join(tmpDir, '005_paired_postgres.sql'), 'CREATE TABLE t (id SERIAL PRIMARY KEY);');
    fs.writeFileSync(
      path.join(tmpDir, EXCEPTIONS_FILENAME),
      JSON.stringify({
        exceptions: [{ file: '005_paired.sql', reason: 'Should be removed once paired' }],
      }),
    );

    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.staleAllowlistEntries[0]).toContain('already has a PostgreSQL twin');
  });

  it('reports CREATE TABLE name mismatches between twins as warnings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '006_tables.sql'),
      'CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY);\nCREATE TABLE beta (id INTEGER);',
    );
    fs.writeFileSync(
      path.join(tmpDir, '006_tables_postgres.sql'),
      'CREATE TABLE IF NOT EXISTS alpha (id SERIAL PRIMARY KEY);',
    );

    expect(extractCreatedTables('CREATE TABLE IF NOT EXISTS "Foo_Bar" (id INT);')).toEqual(['foo_bar']);
    const result = checkMigrationTwins(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.tableWarnings).toEqual([
      'CREATE TABLE mismatch between 006_tables.sql ([alpha, beta]) and 006_tables_postgres.sql ([alpha])',
    ]);
  });
});
