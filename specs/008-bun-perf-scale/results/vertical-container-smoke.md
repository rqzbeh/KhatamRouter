# Vertical Scale (Wave 8) Container Multi-Worker Verification

- **Task**: T024 [US2] [SUBAGENT-DOCKER]
- SUBAGENT_DELEGATION=container-subagent
- **Source**: HEAD `36ad1490` plus overlay of `custom-server.js`, `src/lib/cluster/supervisor.js`, `tests/unit/vertical-cluster-supervisor.test.js`, `tests/unit/vertical-custom-server-integration.test.js`. Overlay files verified byte-identical (md5) to committed `d7644535`. Overlay built from detached worktree `/tmp/khatam-docker-smoke`.
- **Image**: `khatamrouter:vertical-smoke-36ad1490`, ID `sha256:7654f7bc8b37f2b6763437bcb20edd49e5dfc09a689d2d0dc63b7072377f1c55`, platform linux/amd64, size 1266730427 bytes (1.27 GB, 344 MB compressed per `docker images`).
- **Build**: `Dockerfile.bun`, `NEXT_BUILD_CPUS=2`, `NODE_OPTIONS=--max-old-space-size=3072`. Build log `/tmp/khatam-docker-build.log` ends `BUILD_EXIT=0`. Final export step 13.9 s. Total wall time not captured (no start timestamp recorded); single build, no retry.
- **Image contains committed supervisor**: `docker run --rm --entrypoint grep khatamrouter:vertical-smoke-36ad1490 -c "starting KHATAM_WORKERS" /app/src/lib/cluster/supervisor.js` -> `1`.
- **Host `~/.9router/db/data.sqlite`**: before `2026-10-28 00:14:56.971305822 +0330`, after `2026-10-28 00:14:56.971305822 +0330` (unchanged). No host command opened `~/.9router`; all DB reads ran inside the container against `/app/data`.
- **Host volume**: `/tmp/khatam-vertical-smoke-data` mounted at `/app/data`. `DATA_DIR=/app/data`. Proxy env cleared in container; host curls use `--noproxy '*'`.

## 2-worker container (main run)

- **CONTAINER_ID=4e3c970ca4464649d01bf1f85ebb7b53dc1b41bd7d228ba5ef357d3e1aee9cdf**
- Run: `docker run -d --name khatam-vertical-smoke-1 --platform linux/amd64 -e KHATAM_WORKERS=2 -e DATA_DIR=/app/data -e PORT=20128 -e HOSTNAME=0.0.0.0 -p 30128:20128 -v /tmp/khatam-vertical-smoke-data:/app/data khatamrouter:vertical-smoke-36ad1490` (plus NODE_OPTIONS and cleared proxy env).

### (1) Boot log

```
[Cluster] supervisor pid=1 starting KHATAM_WORKERS=2 workers on port 20128
[Cluster] fork worker=1 pid=27 role=leader
[Cluster] fork worker=2 pid=28 role=worker
[Cluster] worker=1 pid=27 ready
[Cluster] worker=2 pid=28 ready
```

`grep -c "is not on disk"` -> `0`.

### (2) Health

```
$ curl --noproxy "*" -i http://127.0.0.1:30128/api/health
HTTP/1.1 200 OK
```

### (3) Distinct worker PIDs

40 keep-alive connections from host (`hold.mjs 30128 40 15000`): `{"done":40,"failed":0,"conns":40}`. `probe.mjs` run inside container with bun 1.4.3, mapping ESTABLISHED sockets on port 20128 to owning PIDs via `/proc/net/tcp` and `/proc/<pid>/fd`:

```
LISTEN_ROWS=2
LISTEN 00000000:4EA0 inode=3153391 pids=28
LISTEN 00000000:4EA0 inode=3152819 pids=27
ESTABLISHED_ROWS=40
PER_PID={"27":18,"28":22}
DISTINCT_OWNER_PIDS=27,28
```

PIDs 27 and 28 equal the worker PIDs in the fork log (primary is pid 1, not used for serving).

DISTINCT_WORKER_PIDS=27,28

### (4) Leader count

`/proc/<pid>/environ` with `KHATAM_WORKER_ROLE=leader`: `LEADER pid=27`, `LEADER_COUNT=1`.

### (5) SQLite WAL on volume

Via bun inside container (readonly open):

```
journal_mode=wal
quick_check=ok
tables=22
```

Volume listing: `data.sqlite`, `data.sqlite-shm`, `data.sqlite-wal` present.

### (6) Graceful stop

`docker stop -t 40 khatam-vertical-smoke-1` -> `STOP_EXIT=0`, `ELAPSED_MS=584`. Log: `[Cluster] draining 2 workers`, then `crash worker=1 pid=27 code=0 signal=null` and `crash worker=2 pid=28 code=0 signal=null` (clean exits).

### (7) Restart

`docker restart` -> health `200` again. Fork lines repeated with new PIDs: `fork worker=1 pid=26 role=leader`, `fork worker=2 pid=27 role=worker`. Fork count 4 total across both boots, no `is not on disk`.

Migrations table `_khatam_migrations` (PK `version`, columns `version, name, applied_at`) after restart:

```
rows=[{"version":"1","name":"initial"},{"version":"2","name":"wave2-storage-quota"},{"version":"3","name":"wave4-circuit-breaker"},{"version":"4","name":"wave6-model-capabilities"}]
total=4
```

No duplicate rows (`version` is primary key). An earlier query used a wrong column name (`id`); it errored and was rerun with the real schema.

## KHATAM_WORKERS=1 container

- CONTAINER_ID=(removed after check; see full run ID above for the 2-worker container)
- Name `khatam-vertical-smoke-w1`, `KHATAM_WORKERS=1`, same volume.
- Health: `HTTP/1.1 200 OK` (ready at 2 s).
- Ran 15 s, still `Running=true`.
- Log shows Next.js ready lines only. No supervisor/fork lines, which is expected for single-process mode.
- `docker stop -t 40` -> `W1_STOP_EXIT=0`, `W1_STOP_MS=658`.

## (9) Native driver absence

`find / -name better_sqlite3.node` inside container -> no output.

## (10) Log secret scan

Pattern scan (sk-, api key, private key block, password=, ghp_, xox, AKIA) over full logs -> `0` hits.

## (11) SIGTERM via docker kill (fresh 2-worker)

- Name `khatam-vertical-smoke-k`, `KHATAM_WORKERS=2`, health ready at 2 s.
- `docker kill --signal=SIGTERM` -> container `Running=false`, `ExitCode=0`, elapsed 1230 ms (limit 10 s).
- Log: `[Cluster] draining 2 workers`, `crash worker=1 pid=25 code=0 signal=null`, `crash worker=2 pid=26 code=0 signal=null`.

## Host state and cleanup

- Containers created by this subagent removed (`docker rm`). `docker ps -a` shows no containers.
- Image `khatamrouter:vertical-smoke-36ad1490` removed after oracle.
- Pre-existing images (`khatamrouter:smoke-5d43ac6a`, `khatam-scale-perf-9router:latest`) untouched.
- Host `~/.9router/db/data.sqlite` mtime unchanged: `2026-10-28 00:14:56.971305822 +0330`.

## Result

All checks (1)-(11) passed with the output above.

VERTICAL_CONTAINER_SMOKE_OK
CONTAINER_ID=4e3c970ca4464649d01bf1f85ebb7b53dc1b41bd7d228ba5ef357d3e1aee9cdf
KHATAM_WORKERS=2
DISTINCT_WORKER_PIDS=27,28
HTTP/1.1 200 OK
