# Contract: multi-replica compose + trusted proxy

## `TRUSTED_PROXY_CIDRS` (env, `custom-server.js`)

| Value | Behavior |
|---|---|
| unset / empty | **Unchanged**: forwarding headers are trusted only from loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) |
| `172.31.250.254/32` | Also trusts `X-Forwarded-For` / `X-Real-IP` when the TCP peer matches the exact load balancer address |
| invalid entry | Startup logs one error and ignores that entry, so the result is more restrictive, never less |

Invariants (each needs a unit test):
- A peer outside every CIDR cannot set the effective client IP via `X-Forwarded-For` (spoof negative control).
- `x-9r-real-ip`, `x-9r-peer-token`, and `x-9r-via-proxy` are still stripped from inbound requests and re-stamped by the server.
- IPv4-mapped IPv6 peers (`::ffff:a.b.c.d`) match their IPv4 CIDR.
- With the variable unset, behavior is identical to master (the existing tests stay green).

## `docker-compose.scale.yml` (overlay; base file untouched)

Use: `docker compose -f docker-compose.yml -f docker-compose.scale.yml up --scale 9router=N`

Requirements:
1. The app service has no `container_name`, and its host port is NOT published. Only the LB publishes 20128.
2. Healthcheck: `curl -f http://localhost:20128/api/health`, with `start_period` set.
3. The LB is nginx round-robin to the service DNS name. It sets `X-Forwarded-For $remote_addr`, which overwrites any client-supplied value and does not append to it.
4. All replicas mount the same `9router-data` volume and the same `REDIS_URL`. `DATA_DIR` is identical.
5. `TRUSTED_PROXY_CIDRS` is set to ONLY the LB address (`172.31.250.254/32`), never the whole subnet, so co-tenant containers (Redis, etc.) cannot forge client IPs.
6. Docs state: single host only. NFS/EFS is unsupported for the SQLite WAL.

## Redis-down contract (re-verified under N replicas)

Quota, semaphore, breaker and rotation state degrade to in-process behavior. Auth stays fail-closed against SQLite. No request-path throw, and at most one warning per outage per replica.
