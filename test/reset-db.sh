#!/usr/bin/env bash
# Recreates the local test database: Supabase shim + all migrations.
# Usage: PGHOST=/socket/dir PGPORT=54329 test/reset-db.sh [dbname]
set -euo pipefail
DB=${1:-toefl}
cd "$(dirname "$0")/.."
psql -U postgres -d postgres -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -U postgres -q -v ON_ERROR_STOP=1 -d "$DB" -f test/supabase-shim.sql
for f in supabase/migrations/*.sql; do psql -U postgres -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
echo "reset $DB"
