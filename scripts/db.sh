#!/bin/sh
# Base de données de développement TRY — Postgres 17 + PostGIS sans Docker ni root.
#
# Les binaires proviennent de Postgres.app (PostGIS inclus), extraits dans
# ~/.try-sport/pg17 ; le cluster vit dans ~/.try-sport/data et écoute sur :5433
# pour ne pas gêner un éventuel Postgres système. Voir docs/database.md.

set -e

PG_HOME="$HOME/.try-sport"
PG_BIN="$PG_HOME/pg17/bin"
PG_DATA="$PG_HOME/data"

if [ ! -x "$PG_BIN/pg_ctl" ]; then
  echo "Binaires introuvables dans $PG_BIN."
  echo "Télécharge Postgres-2.9.6-17.dmg depuis github.com/PostgresApp/PostgresApp/releases,"
  echo "monte-le, puis copie Contents/Versions/17 vers $PG_BIN/.."
  exit 1
fi

case "${1:-}" in
  start)
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_HOME/postgres.log" start
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$PG_DATA" stop
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$PG_DATA" status
    ;;
  psql)
    shift
    "$PG_BIN/psql" -h 127.0.0.1 -p 5433 -U try -d try_dev "$@"
    ;;
  *)
    echo "usage: scripts/db.sh {start|stop|status|psql}"
    exit 1
    ;;
esac
