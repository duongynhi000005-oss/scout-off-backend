# Prometheus Metrics Reference

The ScoutOff backend exposes operational metrics in the Prometheus text exposition format (`text/plain; version=0.0.4; charset=utf-8`) at `GET /metrics` (`src/middleware/metrics.ts`).

---

## Scraping `/metrics`

- **Authentication**: Intentionally unauthenticated and exempt from rate limiting so in-cluster Prometheus scrapers can poll without tokens. Restrict external access at your ingress or reverse proxy in production.
- **Caching**: Returns `Cache-Control: no-store`.
- **Example Prometheus scrape configuration**:

```yaml
scrape_configs:
  - job_name: scout-off-backend
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ["scout-off-backend:4000"]
```

---

## Exported Metrics

| Metric Name | Type | Labels | Description | Suggested Alert |
| --- | --- | --- | --- | --- |
| `http_requests_total` | `counter` | `route` (e.g. `GET /api/players/:id`) | Total number of HTTP requests per normalized route. | Sudden drop to `0` on active traffic or anomalous spike per route. |
| `http_request_duration_ms` | `histogram` | `le` (`5`, `10`, `25`, `50`, `100`, `250`, `500`, `1000`, `2500`, `5000`, `+Inf`) | HTTP request latency in milliseconds across all routes. | `histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m])) > 1000` for `5m`. |
| `http_errors_total` | `counter` | `range` (`4xx`, `5xx`) | Total number of HTTP error responses by status class. | `rate(http_errors_total{range="5xx"}[5m]) > 0.05` for `5m`. |
| `cache_hits_total` | `counter` | — | Total number of cache hits across in-memory / Redis cache reads. | — |
| `cache_misses_total` | `counter` | — | Total number of cache misses. | Hit ratio `rate(cache_hits_total[10m]) / (rate(cache_hits_total[10m]) + rate(cache_misses_total[10m])) < 0.2` under steady read load. |
| `cache_evictions_total` | `counter` | — | Total number of lazy cache evictions (expired key reads). | — |
| `cache_invalidation_total` | `counter` | — | Total number of player-list cache invalidations performed (local operations and received `invalidate:players` pub/sub messages). | — |
| `ipfs_operation_duration_seconds` | `histogram` | `operation` (`pinJson`, `pinFile`, `fetch`, etc.), `le` (`0.005`..`10`, `+Inf`) | IPFS / Pinata operation latency in seconds. | `histogram_quantile(0.95, sum(rate(ipfs_operation_duration_seconds_bucket[5m])) by (le, operation)) > 5` for `5m`. |
| `db_query_duration_seconds` | `histogram` | `query_name`, `le` (`0.005`..`10`, `+Inf`) | Database query latency in seconds (SQLite / PostgreSQL). | `histogram_quantile(0.95, sum(rate(db_query_duration_seconds_bucket[5m])) by (le)) > 0.25` for `5m`. |
| `soroban_rpc_duration_seconds` | `histogram` | `operation`, `le` (`0.005`..`10`, `+Inf`) | Soroban RPC operation latency in seconds. | `histogram_quantile(0.95, sum(rate(soroban_rpc_duration_seconds_bucket[5m])) by (le, operation)) > 5` for `5m`. |
| `webhook_delivery_total` | `counter` | `status` (`success`, `failure`, `dead_letter`) | Total number of outbound webhook delivery attempts by outcome. | `rate(webhook_delivery_total{status="dead_letter"}[5m]) > 0`. |
| `evidence_download_rejected_total` | `counter` | `reason` (`ssrf`, `invalid_content_type`, `oversize`, `timeout`, etc.) | Total number of milestone evidence downloads rejected, by reason. | Sustained spike in `reason="ssrf"` or `reason="oversize"`. |
| `sse_connections_active` | `gauge` | — | Current number of open Server-Sent Events (`/api/events/stream`) connections. | Approaching `SSE_MAX_CONNECTIONS` capacity limit. |
| `indexer_ledger_lag` | `gauge` | — | Ledgers behind the Stellar chain tip after the last indexer poll. | `indexer_ledger_lag > 100` for `10m` (matches `INDEXER_LAG_WARN_THRESHOLD`). |
| `stuck_pending_pins_count` | `gauge` | — | Current number of stuck pending IPFS pins detected by reconciliation. | `stuck_pending_pins_count > 0` for `15m`. |
| `scout_off_webhook_dead_letters_total` | `gauge` | `subscription_id` | Current webhook dead-letter queue depth broken down by subscription. | `sum(scout_off_webhook_dead_letters_total) > 50` or monotonically growing over `30m`. |
| `scout_off_webhook_dead_letters_inserted_total` | `counter` | — | Lifetime webhook dead-letter inserts since process start. | `increase(scout_off_webhook_dead_letters_inserted_total[10m]) > 10`. |
| `scout_off_webhook_retry_success_total` | `counter` | — | Total number of dead-letter entries successfully re-delivered by auto-retry. | — |
| `ip_reputation_blocked_total` | `counter` | — | Total number of requests rejected (`429`) by IP reputation scoring (`score >= 90`). | Sudden spike indicating active credential stuffing or scanner flood. |
| `ip_reputation_penalised_total` | `counter` | — | Total number of requests that received a reputation penalty (500 ms delay or reduced rate limit). | — |
| `scout_off_tier_divergence_total` | `counter` | — | Total number of player tier divergence events (derived tier ≠ stored `progress_level`) detected since process start. | `increase(scout_off_tier_divergence_total[5m]) > 0` (run a reindex; see [docs/runbook.md](runbook.md)). |

---

## Suggested Prometheus Alerting Rules

```yaml
groups:
  - name: scout-off-backend
    rules:
      - alert: ScoutOffIndexerLagHigh
        expr: indexer_ledger_lag > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Soroban event indexer is {{ $value }} ledgers behind tip"

      - alert: ScoutOffTierDivergenceDetected
        expr: increase(scout_off_tier_divergence_total[5m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Player tier divergence detected between milestones and stored progress_level"

      - alert: ScoutOffStuckIpfsPins
        expr: stuck_pending_pins_count > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} IPFS pending pins are stuck"

      - alert: ScoutOffWebhookDeadLetterGrowing
        expr: increase(scout_off_webhook_dead_letters_inserted_total[15m]) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Webhook dead-letter queue is receiving new failed deliveries"

      - alert: ScoutOffHttp5xxErrorRateHigh
        expr: rate(http_errors_total{range="5xx"}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "HTTP 5xx error rate exceeds 0.05 req/s"
```
