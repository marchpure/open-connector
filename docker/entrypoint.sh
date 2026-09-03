#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  set -- serve
fi

case "$1" in
serve)
  shift
  exec node src/server/index.ts "$@"
  ;;
control-plane)
  shift
  export OOMOL_CONNECT_ROLE=control-plane
  exec node src/server/index.ts "$@"
  ;;
mcp-runtime)
  shift
  export OOMOL_CONNECT_ROLE=mcp-runtime
  exec node src/server/index.ts "$@"
  ;;
migrate)
  shift
  exec node scripts/runtime-data.ts migrate "$@"
  ;;
*)
  exec "$@"
  ;;
esac
