import fs from 'fs';
import path from 'path';

describe('Helm chart environment variable wiring', () => {
  const valuesPath = path.join(__dirname, '../helm/scout-off-backend/values.yaml');
  const configmapPath = path.join(__dirname, '../helm/scout-off-backend/templates/configmap.yaml');
  const deploymentPath = path.join(__dirname, '../helm/scout-off-backend/templates/deployment.yaml');

  const valuesContent = fs.readFileSync(valuesPath, 'utf-8');
  const configmapContent = fs.readFileSync(configmapPath, 'utf-8');
  const deploymentContent = fs.readFileSync(deploymentPath, 'utf-8');

  const REQUIRED_VALUES_VARS = [
    'ADMIN_IP_ALLOWLIST',
    'CACHE_MAX_ENTRIES',
    'CACHE_MAX_SIZE',
    'CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    'CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
    'FEATURE_FLAG_CACHE_TTL_MS',
    'INDEXER_FINALITY_MARGIN',
    'INDEXER_LAG_WARN_THRESHOLD',
    'IPFS_BREAKER_FAILURE_THRESHOLD',
    'IPFS_BREAKER_RESET_TIMEOUT_MS',
    'MILESTONE_LOADER_CONCURRENCY',
    'MILESTONE_RATE_MAX',
    'MILESTONE_RATE_WINDOW_MS',
    'PLAYER_CACHE_MAX_SIZE',
    'REINDEX_CATCHUP_THRESHOLD',
    'REINDEX_CATCHUP_BATCH_SIZE',
    'REINDEX_BATCH_SIZE',
    'REINDEX_BATCH_DELAY_MS',
    'REINDEX_RATE_LIMIT_BACKOFF_MS',
    'SHUTDOWN_TIMEOUT_MS',
    'SHUTDOWN_PRESTOP_DELAY_MS',
    'SSE_AUTH_SWEEP_INTERVAL_MS',
    'SSE_MAX_CONNECTIONS_PER_WALLET',
    'SSE_RETRY_MS',
    'WALLET_BLOCKLIST_CACHE_TTL_MS',
    'READINESS_DB_TIMEOUT_MS',
    'READINESS_IPFS_TIMEOUT_MS',
    'READINESS_STELLAR_TIMEOUT_MS',
  ];

  it.each(REQUIRED_VALUES_VARS)('defines %s in helm/scout-off-backend/values.yaml', (varName) => {
    const regex = new RegExp(`^\\s*${varName}:\\s*".*"`, 'm');
    expect(valuesContent).toMatch(regex);
  });

  it('skips empty values in configmap.yaml so app defaults apply when a key is left blank', () => {
    expect(configmapContent).toContain('if ne (toString $value) ""');
  });

  it('allows ADMIN_IP_ALLOWLIST to be sourced from Secret when empty in values.yaml', () => {
    expect(deploymentContent).toContain('name: ADMIN_IP_ALLOWLIST');
    expect(deploymentContent).toContain('key: ADMIN_IP_ALLOWLIST');
  });
});
