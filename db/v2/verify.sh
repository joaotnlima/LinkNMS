#!/usr/bin/env bash
# Build the to-be schema in a throwaway database, load the "Casa Silva" seed and run the checks.
# Usage: DATABASE_URL=postgres://user@localhost:5432/postgres ./db/v2/verify.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
url="${DATABASE_URL:-postgres://postgres@localhost:5432/postgres}"
db="linknms_v2_verify"
psql "$url" -qc "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"
target="${url%/*}/$db"
psql "$target" -v ON_ERROR_STOP=1 -q -f "$here/0001_schema.sql"
psql "$target" -v ON_ERROR_STOP=1 -q -f "$here/seed_casa_silva.sql" > /dev/null
cd "$here" && psql "$target" -q -f checks.sql 2>&1 | tee checks.out
echo; echo "Compare with checks.expected.txt:"; diff -q "$here/checks.out" "$here/checks.expected.txt" && echo "identical"
