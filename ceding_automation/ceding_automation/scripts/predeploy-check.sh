#!/usr/bin/env bash
# scripts/predeploy-check.sh
#
# Offline pre-deploy migration scanner. DETECTION ONLY.
#
# This script does NOT:
#   - connect to any database
#   - apply any migrations
#   - open or modify any firewall rules
#   - touch any Azure resource
#
# What it does:
#   - Walks every directory under backend/prisma/migrations/
#   - Reads each migration.sql (line comments stripped to avoid false positives)
#   - Flags destructive operations so they get a manual audit before
#     'prisma migrate deploy' runs:
#         DROP COLUMN / DROP TABLE / DROP TYPE / DROP INDEX / DROP CONSTRAINT
#         ALTER COLUMN
#         RENAME (TO / COLUMN / CONSTRAINT)
#         DELETE FROM
#         UPDATE <table> SET (data migration that rewrites rows)
#         TRUNCATE
#
# Usage (from anywhere):
#   ./scripts/predeploy-check.sh
#
# Always exits 0. Output is informational; it does not gate anything.
# Output is ASCII-only (no Unicode glyphs) so it survives Windows cp1252
# terminals and the local az CLI's encoding quirks.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MIGRATIONS_DIR="${SCRIPT_DIR}/../backend/prisma/migrations"

echo "================================================================"
echo " Pre-deploy migration scan (offline, detection only)"
echo "================================================================"
echo " Migrations dir: $MIGRATIONS_DIR"
echo ""

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "  [error] migrations directory not found"
  echo "          expected: $MIGRATIONS_DIR"
  echo "          run this script from the repo (it resolves paths"
  echo "          relative to its own location)"
  exit 0
fi

# Destructive patterns. Each is a POSIX-ERE alternative joined with |.
# We strip line comments before matching so narrative comment blocks
# don't trigger false positives.
DESTRUCTIVE_PATTERN='\bDROP[[:space:]]+(COLUMN|TABLE|TYPE|INDEX|CONSTRAINT|SCHEMA|VIEW)\b|\bALTER[[:space:]]+COLUMN\b|\bRENAME[[:space:]]+(TO|COLUMN|CONSTRAINT)\b|\bDELETE[[:space:]]+FROM\b|\bUPDATE[[:space:]]+["a-zA-Z_][a-zA-Z0-9_"]*[[:space:]]+SET\b|\bTRUNCATE([[:space:]]+TABLE)?\b'

total=0
destructive=0
additive=0
destructive_names=""

# Iterate every directory directly under migrations/ in lexical order.
for dir in "$MIGRATIONS_DIR"/*/; do
  [ -d "$dir" ] || continue
  total=$((total + 1))
  name=$(basename "$dir")
  sql="${dir}migration.sql"

  if [ ! -f "$sql" ]; then
    echo "  [skip] $name"
    echo "         (no migration.sql in this directory)"
    continue
  fi

  # Strip line comments (lines whose first non-whitespace chars are "--").
  # Keep block comments and trailing comments as-is; they almost never
  # contain SQL keywords that would false-positive in practice, and bash
  # regex doesn't handle multi-line patterns well.
  body=$(grep -vE '^[[:space:]]*--' "$sql")

  if echo "$body" | grep -qiE "$DESTRUCTIVE_PATTERN"; then
    destructive=$((destructive + 1))
    destructive_names="${destructive_names}\n    - ${name}"
    echo "  [DESTRUCTIVE] $name"
    echo "                audit before applying"
    # Show the offending lines (with line numbers from the original file
    # so the reviewer can jump straight to them).
    echo "    matching lines:"
    grep -niE "$DESTRUCTIVE_PATTERN" "$sql" | head -10 | sed 's/^/      /'
  else
    additive=$((additive + 1))
    echo "  [additive]    $name"
  fi
done

echo ""
echo "================================================================"
echo " Summary"
echo "================================================================"
echo "  total migrations:        $total"
echo "  additive (safe):         $additive"
echo "  destructive (audit):     $destructive"

if [ "$destructive" -gt 0 ]; then
  echo ""
  echo "  Migrations that need a row-count audit before applying:"
  printf "%b\n" "$destructive_names"
  echo ""
  echo "  Audit pattern: write a row-count query proving zero data loss"
  echo "  for whatever the destructive migration would drop / update /"
  echo "  rename. See the LOA migration audit from 2026-06-16 in"
  echo "  docs/DEPLOY_CHECKLIST.md as the reference template."
fi

echo ""
echo "  This was OFFLINE detection only. Nothing has been applied."
echo "  Compare this list against 'prisma migrate status' (which needs"
echo "  a live DB connection) to see which of these are actually"
echo "  pending on staging vs already applied."
echo ""

exit 0
