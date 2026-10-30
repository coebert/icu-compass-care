#!/usr/bin/env bash
# Starts a throwaway, local-only PostgreSQL (real multi-connection server, no
# live data) and runs the concurrency regression tests against it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$(mktemp -d /tmp/icu-pg-XXXX)"
PORT="${PGTEST_PORT:-55432}"
RUNAS=()
if [ "$(id -u)" = "0" ]; then
  if ! id pgtest >/dev/null 2>&1; then
    if command -v useradd >/dev/null; then useradd -M -s /bin/false pgtest
    else echo "pgtest:x:65432:65432::/tmp:/bin/false" >> /etc/passwd; echo "pgtest:x:65432:" >> /etc/group; fi
  fi
  chown -R pgtest "$DIR"
  RUNAS=(runuser -u pgtest --)
fi
"${RUNAS[@]}" initdb -D "$DIR/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
trap '"${RUNAS[@]}" pg_ctl -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
export CONCURRENCY_PG_URL="postgres://postgres@localhost:$PORT/postgres?host=$DIR"
cd "$ROOT"
bunx vitest run tests/security/concurrency/admin-concurrency.test.ts
