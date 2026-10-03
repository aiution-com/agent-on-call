#!/bin/sh
# Runs as PID 1 in the container.
#
# Migrations are opt-in. A schema change should be a deliberate, observable
# step, not something that happens implicitly every time a container restarts —
# but a first run against an empty database should just work, which is why
# docker-compose.yml sets RUN_MIGRATIONS=1.
#
# `exec` replaces this shell with the server process so that SIGTERM reaches
# Node and the application's own shutdown handler runs, rather than being
# swallowed by a shell that has no idea what to do with it.
set -e

case "${RUN_MIGRATIONS:-}" in
  1|true|yes)
    echo "RUN_MIGRATIONS is set; applying migrations before start."
    node /app/scripts/migrate.mjs
    ;;
esac

exec "$@"
