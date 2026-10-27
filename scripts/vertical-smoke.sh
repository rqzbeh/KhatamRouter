#!/usr/bin/env bash
# Vertical multi-worker host drill (T023): worker PID sharing, crash recovery, graceful drain.
# Host loopback only. Every gateway, DB and seed call runs against a fresh temp DATA_DIR.
# Exit 0 only when every check passes. Kills only recorded PIDs. Ports 31000-31999.
set -uo pipefail

START_S=$SECONDS
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
TMP_DIR="$(mktemp -d /tmp/khatam-vertical-smoke-XXXXXX)"
DATA_DIR="$TMP_DIR/data"
NET_ENV=(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy)
REAL_DB="$HOME/.9router/db/data.sqlite"
FAILS=0
GW_PIDS=()
BG_PIDS=()
USED_PORTS=""
GW_PID=""

stat_real_db() { ls -la --time-style=full-iso "$REAL_DB" 2>&1; }
now_ms() { date +%s%3N; }

owned_by_run() { # true only if the pid's environ carries this run's DATA_DIR
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -qx "DATA_DIR=$DATA_DIR"
}

cleanup() {
  local rc=$?
  for p in "${BG_PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null; done
  wait 2>/dev/null
  for g in "${GW_PIDS[@]:-}"; do
    [ -z "$g" ] && continue
    for c in $(pgrep -P "$g" 2>/dev/null); do kill -KILL "$c" 2>/dev/null; done
    kill -KILL "$g" 2>/dev/null
    wait "$g" 2>/dev/null
  done
  # Orphaned workers outlive a dead primary; kill recorded PIDs that belong to this run.
  if [ -f "$TMP_DIR/seen.pids" ]; then
    for p in $(sort -un "$TMP_DIR/seen.pids"); do
      kill -0 "$p" 2>/dev/null && owned_by_run "$p" && kill -KILL "$p" 2>/dev/null
    done
  fi
  sleep 0.3
  local leaked=0
  for g in "${GW_PIDS[@]:-}"; do [ -n "$g" ] && kill -0 "$g" 2>/dev/null && leaked=$((leaked + 1)); done
  if [ -f "$TMP_DIR/seen.pids" ]; then
    for p in $(sort -un "$TMP_DIR/seen.pids"); do kill -0 "$p" 2>/dev/null && owned_by_run "$p" && leaked=$((leaked + 1)); done
  fi
  rm -rf "$TMP_DIR"
  echo "CLEANUP leaked_gateway_processes=$leaked tmp_removed=yes elapsed=$((SECONDS - START_S))s"
  [ "$FAILS" -ne 0 ] && rc=1
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

check() { # $1 label, $2 exit status of the condition (0 = pass)
  if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi
}

pick_port() {
  local p i
  for i in $(seq 1 300); do
    p=$((31000 + RANDOM % 1000))
    case " $USED_PORTS " in *" $p "*) continue ;; esac
    if [ -z "$(ss -Htln "sport = :$p")" ]; then USED_PORTS="$USED_PORTS $p"; echo "$p"; return 0; fi
  done
  echo "no free port in 31000-31999" >&2
  return 1
}

worker_pids() {
  local p
  for p in $(pgrep -P "$GW_PID" | sort -n); do echo "$p" >> "$TMP_DIR/seen.pids"; echo "$p"; done
}
role_of() { { tr '\0' '\n' < "/proc/$1/environ"; } 2>/dev/null | sed -n 's/^KHATAM_WORKER_ROLE=//p' || true; }
leader_of() { for w in $(worker_pids); do [ -d "/proc/$w" ] && [ "$(role_of "$w")" = leader ] && echo "$w"; done; }
contains() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }
alive() { # running, not yet reaped zombie
  [ -d "/proc/$1" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null
}

start_gateway() { # $1 port, $2 log file
  "${NET_ENV[@]}" DATA_DIR="$DATA_DIR" DATA_DIR_ALLOW_TEMP=1 PORT="$1" KHATAM_WORKERS=4 \
    bun custom-server.js > "$2" 2>&1 &
  GW_PID=$!
  GW_PIDS+=("$GW_PID")
  local i listeners
  for i in $(seq 1 120); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$1/api/health")" = 200 ]; then
      listeners=$(ss -Htlnp "sport = :$1" | grep -o 'pid=[0-9]*' | sort -u | wc -l)
      [ "$listeners" -ge 4 ] && return 0
    fi
    kill -0 "$GW_PID" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

cat > "$TMP_DIR/hold.mjs" <<'JS'
const net = await import("node:net");
const port = Number(process.argv[2]);
const n = Number(process.argv[3]);
const hold = Number(process.argv[4]);
const socks = [];
for (let i = 0; i < n; i++) {
  const s = net.connect(port, "127.0.0.1");
  s.on("error", () => {});
  s.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
  socks.push(s);
}
setTimeout(() => { for (const s of socks) s.destroy(); process.exit(0); }, hold);
JS

# Upstream: 8 chunks, one every DELAY_MS. /sent reports chunks enqueued so far (drain evidence).
cat > "$TMP_DIR/upstream.mjs" <<'JS'
const port = Number(process.argv[2]);
const DELAY_MS = 1000;
const TOTAL = 8;
let sent = 0;
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/sent") return new Response(String(sent));
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(c) {
        for (let i = 0; i < TOTAL; i++) {
          c.enqueue(enc.encode('data: {"id":"s","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"t' + i + '"}}]}\n\n'));
          sent++;
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});
JS

cat > "$TMP_DIR/seed.mjs" <<'JS'
const db = await import(process.env.KHATAM_REPO + "/src/lib/db/index.js");
const base = "http://127.0.0.1:" + process.env.MOCK_PORT + "/v1";
const nodeId = "openai-compatible-chat-smoke";
await db.createProviderNode({ id: nodeId, type: "openai-compatible", name: "smoke-mock", prefix: "smokemock", apiType: "chat", baseUrl: base });
await db.createProviderConnection({ provider: nodeId, authType: "apikey", name: "smoke-conn", apiKey: "sk-smoke", isActive: true, priority: 1, providerSpecificData: { baseUrl: base } });
const key = await db.createApiKey("smoke-key", "smoke-machine-id");
console.log("SMOKE_KEY=" + key.key);
process.exit(0);
JS

DB_BEFORE="$(stat_real_db)"
echo "real DB before: $DB_BEFORE"

# ---------- Boot A: port sharing + crash recovery ----------
echo "== boot A: KHATAM_WORKERS=4 port sharing and crash recovery"
PORT_A="$(pick_port)" || exit 1
start_gateway "$PORT_A" "$TMP_DIR/gateway-a.log" || { echo "FAIL boot A did not come up"; tail -n 40 "$TMP_DIR/gateway-a.log"; exit 1; }
WORKERS="$(worker_pids | tr '\n' ' ')"
NW=$(echo $WORKERS | wc -w)
LEADERS=0; WORKER_ROLES=0
for w in $WORKERS; do
  case "$(role_of "$w")" in leader) LEADERS=$((LEADERS + 1)) ;; worker) WORKER_ROLES=$((WORKER_ROLES + 1)) ;; esac
done
echo "primary=$GW_PID workers=[$WORKERS] roles: leader=$LEADERS worker=$WORKER_ROLES"
check "4 worker processes under primary" $([ "$NW" -eq 4 ] && echo 0 || echo 1)
check "exactly one leader and three followers" $([ "$LEADERS" -eq 1 ] && [ "$WORKER_ROLES" -eq 3 ] && echo 0 || echo 1)

"${NET_ENV[@]}" bun "$TMP_DIR/hold.mjs" "$PORT_A" 60 5000 >/dev/null 2>&1 &
HOLD_PID=$!
for i in $(seq 1 50); do
  [ "$(ss -Htn state established "( sport = :$PORT_A )" | wc -l)" -ge 60 ] && break
  sleep 0.2
done
SERVED="$(ss -Htnp state established "( sport = :$PORT_A )" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | tr '\n' ' ')"
DISTINCT_PIDS=0
for p in $SERVED; do
  contains "$WORKERS" "$p" && DISTINCT_PIDS=$((DISTINCT_PIDS + 1))
done
echo "server-side sockets owned by PIDs: [$SERVED] (worker PIDs matched: $DISTINCT_PIDS)"
wait "$HOLD_PID" 2>/dev/null
check "keep-alive connections spread over >=2 distinct worker PIDs (not primary)" $([ "$DISTINCT_PIDS" -ge 2 ] && echo 0 || echo 1)
[ "$DISTINCT_PIDS" -ge 2 ] && echo "VERTICAL_SMOKE_PORT_SHARING_OK distinct=$DISTINCT_PIDS"

# Steady loop: one timestamped line per request: start_ms end_ms http_code curl_rc.
LOOP_RUN="$TMP_DIR/loop.run"; LOOP_LOG="$TMP_DIR/loop.log"; : > "$LOOP_RUN"; : > "$LOOP_LOG"
(
  while [ -f "$LOOP_RUN" ]; do
    s=$(now_ms)
    c=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -m 3 -H 'Connection: close' "http://127.0.0.1:$PORT_A/api/health"); rc=$?
    e=$(now_ms)
    echo "$s $e $c $rc" >> "$LOOP_LOG"
  done
) &
LOOP_PID=$!
BG_PIDS+=("$LOOP_PID")
sleep 1

NONLEADER=""
for w in $WORKERS; do [ "$(role_of "$w")" = worker ] && { NONLEADER="$w"; break; }; done
echo "SIGKILL non-leader worker $NONLEADER"
KILL1_MS=$(now_ms)
kill -KILL "$NONLEADER" 2>/dev/null
REPLACED=""
for i in $(seq 1 50); do
  NOW_WORKERS="$(worker_pids | tr '\n' ' ')"
  for p in $NOW_WORKERS; do contains "$WORKERS" "$p" || { REPLACED="$p"; break; }; done
  [ -n "$REPLACED" ] && break
  sleep 0.2
done
check "replacement worker PID respawned within 10s" $([ -n "$REPLACED" ] && echo 0 || echo 1)
echo "replacement PID=$REPLACED"
WORKERS="$(worker_pids | tr '\n' ' ')"
check "pool back to 4 workers after non-leader crash" $([ "$(echo $WORKERS | wc -w)" -eq 4 ] && echo 0 || echo 1)

OLD_LEADER="$(leader_of)"
echo "SIGKILL leader worker $OLD_LEADER"
KILL2_MS=$(now_ms)
kill -KILL "$OLD_LEADER" 2>/dev/null
NEW_LEADER=""
for i in $(seq 1 50); do
  NEW_LEADER="$(leader_of)"
  [ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$OLD_LEADER" ] && break
  sleep 0.2
done
check "replacement worker takes leader role after leader crash" $([ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$OLD_LEADER" ] && echo 0 || echo 1)
WORKERS="$(worker_pids | tr '\n' ' ')"
LEADERS=0
for w in $WORKERS; do [ "$(role_of "$w")" = leader ] && LEADERS=$((LEADERS + 1)); done
check "exactly one leader after leader crash" $([ "$LEADERS" -eq 1 ] && echo 0 || echo 1)

sleep 1
rm -f "$LOOP_RUN"
wait "$LOOP_PID" 2>/dev/null
# Classify failures. Allowed: request overlapped a kill, or started <=200 ms after it (in flight on the
# killed socket or routed to a listener still dying). Hard: any other failure, incl. any new
# connection started >200 ms after a kill. Allowed failures are capped at 2.
read -r LOOP_TOTAL LOOP_OK LOOP_ALLOWED LOOP_HARD < <(awk -v k1="$KILL1_MS" -v k2="$KILL2_MS" -v win=200 '
  { total++; if ($3 == 200) { ok++; next }
    hit = (($1 <= k1 + win && $2 >= k1) || ($1 <= k2 + win && $2 >= k2))
    if (hit) allowed++; else hard++
    printf "fail start_rel_kill1=%+dms start_rel_kill2=%+dms end_rel_kill1=%+dms code=%s curl_rc=%s allowed=%s\n", $1-k1, $1-k2, $2-k1, $3, $4, hit ? "yes" : "NO" > "/dev/stderr"
  }
  END { printf "%d %d %d %d\n", total, ok, allowed + 0, hard + 0 }' "$LOOP_LOG")
echo "steady request loop across both kills: total=$LOOP_TOTAL ok=$LOOP_OK in_flight_allowed=$LOOP_ALLOWED hard_failed=$LOOP_HARD"
check "steady loop: all requests started >200 ms after a kill succeed (0 hard failures)" $([ "$LOOP_HARD" -eq 0 ] && [ "$LOOP_OK" -gt 0 ] && echo 0 || echo 1)
check "steady loop: in-flight failures capped at 2" $([ "$LOOP_ALLOWED" -le 2 ] && echo 0 || echo 1)
[ "$FAILS" -eq 0 ] && echo "VERTICAL_SMOKE_CRASH_RECOVERY_OK"

# Idle SIGTERM: no in-flight work, primary must exit 0.
kill -TERM "$GW_PID" 2>/dev/null
wait "$GW_PID" 2>/dev/null; IDLE_RC=$?
check "idle SIGTERM drain: primary exits 0" $([ "$IDLE_RC" -eq 0 ] && echo 0 || echo 1)

# ---------- Boot B: graceful drain with a real in-flight SSE stream ----------
echo "== boot B: graceful drain with a real in-flight SSE stream"
MOCK_PORT="$(pick_port)" || exit 1
"${NET_ENV[@]}" bun "$TMP_DIR/upstream.mjs" "$MOCK_PORT" > "$TMP_DIR/upstream.log" 2>&1 &
BG_PIDS+=("$!")
for i in $(seq 1 50); do [ -n "$(ss -Htln "sport = :$MOCK_PORT")" ] && break; sleep 0.2; done

KHATAM_REPO="$REPO" MOCK_PORT="$MOCK_PORT" "${NET_ENV[@]}" DATA_DIR="$DATA_DIR" DATA_DIR_ALLOW_TEMP=1 \
  bun "$TMP_DIR/seed.mjs" > "$TMP_DIR/seed.out" 2>&1
KEY="$(sed -n 's/^SMOKE_KEY=//p' "$TMP_DIR/seed.out")"
check "seed API key, provider node and connection via repo DB functions" $([ -n "$KEY" ] && echo 0 || echo 1)

PORT_B="$(pick_port)" || exit 1
start_gateway "$PORT_B" "$TMP_DIR/gateway-b.log" || { echo "FAIL boot B did not come up"; tail -n 40 "$TMP_DIR/gateway-b.log"; exit 1; }
GW_B="$GW_PID"

upstream_sent() { curl -s --noproxy '*' -m 2 "http://127.0.0.1:$MOCK_PORT/sent"; }
STREAM_START_MS=$(now_ms)
( curl -sN --noproxy '*' -m 40 -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"model":"smokemock/gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
    "http://127.0.0.1:$PORT_B/v1/chat/completions" > "$TMP_DIR/stream.out" 2>"$TMP_DIR/curl.err"
  echo "$?" > "$TMP_DIR/curl.rc"; date +%s%3N > "$TMP_DIR/curl.end" ) &
CURL_PID=$!
BG_PIDS+=("$CURL_PID")
for i in $(seq 1 100); do grep -q '"delta"' "$TMP_DIR/stream.out" 2>/dev/null && break; sleep 0.1; done
check "client received >=1 chunk before SIGTERM" $(grep -q '"delta"' "$TMP_DIR/stream.out" 2>/dev/null && echo 0 || echo 1)

# Wait until upstream has sent 3 chunks (about 2 s in), then SIGTERM the primary.
for i in $(seq 1 100); do [ "$(upstream_sent || echo 0)" -ge 3 ] && break; sleep 0.1; done
SENT_AT_SIGTERM="$(upstream_sent || echo -1)"
CHUNKS_BEFORE=$(grep -c '"delta"' "$TMP_DIR/stream.out" || true)
SIGTERM_MS=$(now_ms)
kill -TERM "$GW_B" 2>/dev/null

# Drain monitor: probe new connections until the primary is gone, then record exit time.
PROBE_LOG="$TMP_DIR/probe.log"; : > "$PROBE_LOG"
(
  while alive "$GW_B"; do
    c=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -m 1 "http://127.0.0.1:$PORT_B/api/health"); rc=$?
    echo "$(now_ms) $rc $c" >> "$PROBE_LOG"
    sleep 0.1
  done
  now_ms > "$TMP_DIR/gw.exit"
) &
MON_PID=$!
BG_PIDS+=("$MON_PID")

wait "$CURL_PID"
wait "$MON_PID" 2>/dev/null
wait "$GW_B" 2>/dev/null; GW_RC=$?
CURL_RC=$(cat "$TMP_DIR/curl.rc" 2>/dev/null || echo -1)
CURL_END_MS=$(cat "$TMP_DIR/curl.end" 2>/dev/null || echo 0)
GW_EXIT_MS=$(cat "$TMP_DIR/gw.exit" 2>/dev/null || echo 0)
CHUNKS=$(grep -c '"delta"' "$TMP_DIR/stream.out" || true)
CHUNKS_AFTER=$((CHUNKS - CHUNKS_BEFORE))
FIRST_REFUSED_MS=$(awk '$2 == 7 { print $1; exit }' "$PROBE_LOG")
PROBE_200_DURING=$(awk '$3 == 200' "$PROBE_LOG" | wc -l)
echo "drain: sigterm_ms=$SIGTERM_MS stream_start_ms=$STREAM_START_MS sent_at_sigterm=$SENT_AT_SIGTERM/8"
echo "drain: chunks_before_sigterm=$CHUNKS_BEFORE chunks_after_sigterm=$CHUNKS_AFTER total=$CHUNKS curl_exit=$CURL_RC primary_exit=$GW_RC"
echo "drain: stream_end_ms=$CURL_END_MS primary_exit_ms=$GW_EXIT_MS first_refused_ms=${FIRST_REFUSED_MS:-none} probes_200_during_drain=$PROBE_200_DURING"

check "SIGTERM sent 1.5-4.0 s into the stream" $([ $((SIGTERM_MS - STREAM_START_MS)) -ge 1500 ] && [ $((SIGTERM_MS - STREAM_START_MS)) -le 4000 ] && echo 0 || echo 1)
check "upstream still had >=3 chunks left at SIGTERM (sent_at_sigterm <= 5 of 8)" $([ "$SENT_AT_SIGTERM" -ge 1 ] && [ "$SENT_AT_SIGTERM" -lt 6 ] && echo 0 || echo 1)
check "client received >=3 chunks after SIGTERM" $([ "$CHUNKS_AFTER" -ge 3 ] && echo 0 || echo 1)
check "client receives all 8 chunks with final [DONE], curl exit 0" $([ "$CHUNKS" -eq 8 ] && [ "$CURL_RC" -eq 0 ] && grep -q '^data: \[DONE\]' "$TMP_DIR/stream.out" && echo 0 || echo 1)
check "primary exits 0 after drain" $([ "$GW_RC" -eq 0 ] && echo 0 || echo 1)
check "primary exits only after the stream ended (timestamps)" $([ "$GW_EXIT_MS" -ge "$CURL_END_MS" ] && [ "$CURL_END_MS" -gt "$SIGTERM_MS" ] && echo 0 || echo 1)
check "new connections refused once drain started (refusal seen after SIGTERM)" $([ -n "$FIRST_REFUSED_MS" ] && [ "$FIRST_REFUSED_MS" -ge "$SIGTERM_MS" ] && echo 0 || echo 1)
curl -s -o /dev/null --noproxy '*' -m 2 "http://127.0.0.1:$PORT_B/api/health"; REFUSED_RC=$?
check "new connections refused after primary exit" $([ "$REFUSED_RC" -ne 0 ] && echo 0 || echo 1)
[ "$FAILS" -eq 0 ] && echo "VERTICAL_SMOKE_GRACEFUL_DRAIN_OK"

DB_AFTER="$(stat_real_db)"
echo "real DB after:  $DB_AFTER"
check "real ~/.9router DB mtime unchanged" $([ "$DB_BEFORE" = "$DB_AFTER" ] && echo 0 || echo 1)
check "total runtime < 90 s" $([ $((SECONDS - START_S)) -lt 90 ] && echo 0 || echo 1)
[ "$FAILS" -eq 0 ] && echo "VERTICAL_SMOKE_ALL_PASS"
exit 0
