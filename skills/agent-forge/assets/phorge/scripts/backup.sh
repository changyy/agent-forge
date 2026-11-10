#!/usr/bin/env bash
# Bundle a full Phorge backup into a single tarball on the host.
#
# Contents of the bundle:
#   db.sql.gz            — `bin/storage dump --compress` (mysqldump format)
#   phorge-files.tar.gz  — /var/phorge-files (uploaded blobs)
#   phorge-repos.tar.gz  — /var/repo        (git repositories)
#   manifest.txt         — timestamp, git heads, file sizes
#
# Usage:
#   scripts/backup.sh                     # writes ./backups/phorge-backup-<TS>.tar
#   BACKUP_DIR=/path/to/dir scripts/backup.sh
#
# Safe to run on a live service. Uses --single-transaction for the DB
# (bin/storage dump does this internally). File/repo tarballs may catch
# in-flight writes, which is acceptable for non-HA dev/small-team setups.

set -euo pipefail

cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
OUT_DIR="${BACKUP_DIR:-$(pwd)/backups}"
STAGING="${OUT_DIR}/.staging-${TS}"
BUNDLE="${OUT_DIR}/phorge-backup-${TS}.tar"

# Sanity: phorge service must be up.
if ! docker compose ps --status running --services 2>/dev/null | grep -qx phorge; then
    echo "error: phorge service is not running. start it with 'docker compose up -d' first." >&2
    exit 1
fi

mkdir -p "${STAGING}"
echo "[backup] staging dir: ${STAGING}"

echo "[backup] 1/4  bin/storage dump -> db.sql.gz"
docker compose exec -T phorge runuser -u www-data -- bash -lc \
    'cd /opt/phorge/phorge && ./bin/storage dump --compress --overwrite --output /tmp/_backup_db.sql.gz' >/dev/null
docker compose exec -T phorge cat /tmp/_backup_db.sql.gz > "${STAGING}/db.sql.gz"
docker compose exec -T phorge rm -f /tmp/_backup_db.sql.gz

echo "[backup] 2/4  tar /var/phorge-files -> phorge-files.tar.gz"
docker compose exec -T phorge tar czf - -C /var/phorge-files . > "${STAGING}/phorge-files.tar.gz"

echo "[backup] 3/4  tar /var/repo -> phorge-repos.tar.gz"
docker compose exec -T phorge tar czf - -C /var/repo . > "${STAGING}/phorge-repos.tar.gz"

echo "[backup] 4/4  manifest + bundle"
# Run git as www-data (the user that owns the repos) to avoid safe.directory
# rejections, and tolerate failures since the SHA is informational only.
PHORGE_HEAD=$(docker compose exec -T phorge runuser -u www-data -- bash -lc 'cd /opt/phorge/phorge && git rev-parse HEAD 2>/dev/null' | tr -d '\r' || echo unknown)
ARC_HEAD=$(docker compose exec -T phorge runuser -u www-data -- bash -lc 'cd /opt/phorge/arcanist && git rev-parse HEAD 2>/dev/null' | tr -d '\r' || echo unknown)
PHORGE_HEAD="${PHORGE_HEAD:-unknown}"
ARC_HEAD="${ARC_HEAD:-unknown}"

cat > "${STAGING}/manifest.txt" <<EOF
phorge-backup
timestamp:      ${TS}
host:           $(hostname)
compose_project: $(basename "$PWD")
phorge_commit:  ${PHORGE_HEAD}
arcanist_commit: ${ARC_HEAD}
sizes:
  db.sql.gz:           $(stat -f%z "${STAGING}/db.sql.gz" 2>/dev/null || stat -c%s "${STAGING}/db.sql.gz") bytes
  phorge-files.tar.gz: $(stat -f%z "${STAGING}/phorge-files.tar.gz" 2>/dev/null || stat -c%s "${STAGING}/phorge-files.tar.gz") bytes
  phorge-repos.tar.gz: $(stat -f%z "${STAGING}/phorge-repos.tar.gz" 2>/dev/null || stat -c%s "${STAGING}/phorge-repos.tar.gz") bytes
EOF

# Outer is plain tar (inner files are already gzip'd, no point double-compressing).
tar -C "${STAGING}" -cf "${BUNDLE}" \
    manifest.txt db.sql.gz phorge-files.tar.gz phorge-repos.tar.gz

rm -rf "${STAGING}"

SIZE=$(du -h "${BUNDLE}" | cut -f1)
echo
echo "[backup] done: ${BUNDLE} (${SIZE})"
