// Parity test for issues #1190 and #1520: every db/NNN_*.sql migration must
// have a matching `_postgres.sql` counterpart unless explicitly listed in
// `db/postgres-twin-exceptions.json` with a non-empty `reason` string.

import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkMigrationTwins } = require('../../scripts/check-migrations');

const DB_DIR = path.resolve(__dirname, '../../db');

describe('db/ migration Postgres parity', () => {
  it('every base migration has a _postgres.sql counterpart or is allowlisted with a reason', () => {
    const result = checkMigrationTwins(DB_DIR);
    expect(result.invalidAllowlistEntries).toEqual([]);
    expect(result.missingPostgresTwins).toEqual([]);
  });

  it('every _postgres.sql migration has a matching SQLite counterpart', () => {
    const result = checkMigrationTwins(DB_DIR);
    expect(result.orphanPostgresFiles).toEqual([]);
  });

  it('does not allowlist a file that already has a _postgres.sql counterpart or does not exist', () => {
    const result = checkMigrationTwins(DB_DIR);
    expect(result.staleAllowlistEntries).toEqual([]);
  });
});
