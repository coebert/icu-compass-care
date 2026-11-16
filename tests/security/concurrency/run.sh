#!/usr/bin/env bash
# Starts a throwaway, local-only PostgreSQL (real multi-connection server, no
# live data) and runs the concurrency regression tests against it. Each test
# file gets its own fresh server (database roles are server-wide).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PGTEST_PORT:-55432}"
RUNAS=()
if [ "$(id -u)" = "0" ]; then
  if ! id pgtest >/dev/null 2>&1; then
    if command -v useradd >/dev/null; then useradd -M -s /bin/false pgtest
    else echo "pgtest:x:65432:65432::/tmp:/bin/false" >> /etc/passwd; grep -q "^pgtest:" /etc/group || echo "pgtest:x:65432:" >> /etc/group; fi
  fi
  RUNAS=(setpriv --reuid=pgtest --regid=pgtest --clear-groups --)
fi
DIR=""
stop_pg() {
  if [ -n "$DIR" ]; then
    "${RUNAS[@]}" pg_ctl -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$DIR"
    DIR=""
  fi
}
trap stop_pg EXIT
cd "$ROOT"
for TEST in tests/security/concurrency/admin-concurrency.test.ts tests/security/concurrency/bed-concurrency.test.ts; do
  DIR="$(mktemp -d /tmp/icu-pg-XXXX)"
  [ "$(id -u)" = "0" ] && chown -R pgtest "$DIR"
  "${RUNAS[@]}" initdb -D "$DIR/data" -U postgres -A trust -E UTF8 --locale=C >/dev/null
  "${RUNAS[@]}" pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
  export CONCURRENCY_PG_URL="$DIR:$PORT"
  bunx vitest run "$TEST"
  stop_pg
done
