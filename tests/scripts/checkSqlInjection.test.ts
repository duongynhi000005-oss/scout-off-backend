import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  collectTypeScriptFiles,
  scanDirectory,
  scanFile,
} = require('../../scripts/check-sql-injection');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/check-sql-injection.js');

describe('scripts/check-sql-injection.js (issue #1622)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-sql-check-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags interpolated SELECT, UPDATE, DELETE, and DDL queries', () => {
    const badFile = path.join(tmpDir, 'bad.ts');
    fs.writeFileSync(
      badFile,
      [
        'export function unsafeQuery(userId: string) {',
        '  return db.prepare(`SELECT * FROM players WHERE player_id = ${userId}`);',
        '}',
      ].join('\n'),
      'utf8',
    );

    const findings = scanFile(badFile);
    expect(findings).toHaveLength(1);
    expect(findings[0].filePath).toBe(badFile);
    expect(findings[0].snippet).toContain('SELECT * FROM players');
  });

  it('ignores parameterized ? queries and non-SQL template literals', () => {
    const safeFile = path.join(tmpDir, 'safe.ts');
    fs.writeFileSync(
      safeFile,
      [
        'export function safeQuery(userId: string) {',
        '  const msg = `fetching player ${userId}`;',
        '  return db.prepare(`SELECT * FROM players WHERE player_id = ?`).get(userId, msg);',
        '}',
      ].join('\n'),
      'utf8',
    );

    expect(scanFile(safeFile)).toEqual([]);
  });

  it('honours both // sql-injection-ok: and // sql-injection-check-ignore allow comments', () => {
    const allowedFile = path.join(tmpDir, 'allowed.ts');
    fs.writeFileSync(
      allowedFile,
      [
        'const COLS = "player_id, wallet";',
        '// sql-injection-ok: COLS is a hardcoded column list constant',
        'const q1 = `SELECT ${COLS} FROM players WHERE player_id = ?`;',
        '// sql-injection-check-ignore: orderClause is validated against fixed enum',
        'const q2 = `SELECT * FROM players ORDER BY ${COLS}`;',
        'export { q1, q2 };',
      ].join('\n'),
      'utf8',
    );

    expect(scanFile(allowedFile)).toEqual([]);
  });

  it('recursively scans nested directories while skipping frontend/ and *.d.ts', () => {
    const servicesDir = path.join(tmpDir, 'services');
    const frontendDir = path.join(tmpDir, 'frontend');
    fs.mkdirSync(servicesDir, { recursive: true });
    fs.mkdirSync(frontendDir, { recursive: true });

    const serviceFile = path.join(servicesDir, 'indexer.ts');
    const frontendFile = path.join(frontendDir, 'app.ts');
    const dtsFile = path.join(servicesDir, 'types.d.ts');

    fs.writeFileSync(serviceFile, 'const q = `DELETE FROM events WHERE id = ${id}`;', 'utf8');
    fs.writeFileSync(frontendFile, 'const q = `SELECT * FROM ui WHERE id = ${id}`;', 'utf8');
    fs.writeFileSync(dtsFile, 'const q = `SELECT * FROM types WHERE id = ${id}`;', 'utf8');

    const files = collectTypeScriptFiles(tmpDir);
    expect(files).toEqual([serviceFile]);

    const findings = scanDirectory(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0].filePath).toBe(serviceFile);
  });

  it('exits with non-zero code on findings and 0 when clean', () => {
    const badFile = path.join(tmpDir, 'bad.ts');
    fs.writeFileSync(badFile, 'const q = `SELECT * FROM players WHERE region = ${region}`;\n', 'utf8');

    const failRun = spawnSync('node', [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, SQL_INJECTION_SCAN_DIR: tmpDir },
    });
    expect(failRun.status).toBe(1);
    expect(failRun.stderr).toContain('[FAIL] SQL string interpolation found');

    fs.writeFileSync(
      badFile,
      '// sql-injection-ok: static table constant\nconst q = `SELECT * FROM ${TABLE}`;\n',
      'utf8',
    );

    const passRun = spawnSync('node', [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, SQL_INJECTION_SCAN_DIR: tmpDir },
    });
    expect(passRun.status).toBe(0);
    expect(passRun.stdout).toContain('[PASS] No SQL string interpolation detected.');
  });

  it('passes against the repository src/ tree', () => {
    const repoRun = spawnSync('node', [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(repoRun.status).toBe(0);
    expect(repoRun.stdout).toContain('[PASS] No SQL string interpolation detected.');
  });
});
