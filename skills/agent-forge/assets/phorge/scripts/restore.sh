#!/usr/bin/env bash
# Restore a full Phorge backup created by scripts/backup.sh.
#
# DESTRUCTIVE — replaces the current DB, /var/phorge-files, and /var/repo.
#
# Usage:
#   scripts/restore.sh ./backups/phorge-backup-YYYYMMDD-HHMMSS.tar
#   scripts/restore.sh ./backups/phorge-backup-...tar --force   # skip confirm
#
# Requires the phorge container to be running. After restore, the entrypoint's
# /var/run/phorge/.initialized flag is left untouched, so init-users.php still
# won't re-run (the admin/agent rows in the restored DB are already there).

set -euo pipefail

cd "$(dirname "$0")/.."

BUNDLE="${1:-}"
FORCE="${2:-}"

if [[ -z "${BUNDLE}" || ! -f "${BUNDLE}" ]]; then
    echo "usage: $0 <path/to/phorge-backup-*.tar> [--force]" >&2
    [[ -d ./backups ]] && { echo "available bundles:" >&2; ls -1 ./backups/phorge-backup-*.tar 2>/dev/null >&2 || echo "  (none)" >&2; }
    exit 1
fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx phorge; then
    echo "error: phorge service is not running. start it with 'docker compose up -d' first." >&2
    exit 1
fi

# Hash-marker: skip restore if this exact bundle was already applied.
# Marker lives in /var/run/phorge/.last-restored inside the phorge-state volume,
# so it survives container restarts but is lost if the volume is destroyed (which
# would correctly invalidate the "already restored" claim).
if command -v shasum >/dev/null 2>&1; then
    NEW_HASH=$(shasum -a 256 "${BUNDLE}" | awk '{print $1}')
else
    NEW_HASH=$(sha256sum "${BUNDLE}" | awk '{print $1}')
fi
CURRENT_HASH=$(docker compose exec -T phorge bash -lc 'cat /var/run/phorge/.last-restored 2>/dev/null' | tr -d '\r\n[:space:]' || true)

if [[ "${FORCE}" != "--force" && -n "${CURRENT_HASH}" && "${CURRENT_HASH}" == "${NEW_HASH}" ]]; then
    cat <<EOF
[restore] this bundle has already been applied to this instance.
          bundle: ${BUNDLE}
          sha256: ${NEW_HASH}
          marker: /var/run/phorge/.last-restored (phorge-state volume)

skipping. pass --force to re-import anyway.
EOF
    exit 0
fi

if [[ "${FORCE}" != "--force" ]]; then
    cat <<EOF
This will OVERWRITE all Phorge data with the contents of:

    ${BUNDLE}

Steps:
  1. bin/storage destroy --force      (drops every phorge_* database)
  2. mariadb < db.sql.gz              (restore DB)
  3. wipe + untar /var/phorge-files   (restore uploaded blobs)
  4. wipe + untar /var/repo           (restore git repos)
  5. bin/storage upgrade --force      (apply migrations if dump is older)

EOF
    read -r -p "Type 'restore' to proceed: " confirm
    [[ "${confirm}" == "restore" ]] || { echo "aborted"; exit 1; }
fi

WORK_DIR=$(mktemp -d -t phorge-restore-XXXXXX)
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "[restore] 0/5  extract bundle"
tar -C "${WORK_DIR}" -xf "${BUNDLE}"
echo "         bundle manifest:"; sed 's/^/         | /' "${WORK_DIR}/manifest.txt"

CID=$(docker compose ps -q phorge)
[[ -n "${CID}" ]] || { echo "error: cannot resolve phorge container id" >&2; exit 1; }

echo "[restore] 1/5  destroy current DB"
docker compose exec -T phorge runuser -u www-data -- bash -lc \
    'cd /opt/phorge/phorge && ./bin/storage destroy --force' | tail -3

echo "[restore] 2/5  restore DB ($(du -h "${WORK_DIR}/db.sql.gz" | cut -f1))"
docker cp "${WORK_DIR}/db.sql.gz" "${CID}:/tmp/_restore_db.sql.gz"
docker compose exec -T phorge bash -lc '
  set -e
  gunzip -c /tmp/_restore_db.sql.gz | mariadb -h "${MYSQL_HOST}" -P "${MYSQL_PORT}" -u "${MYSQL_USER}" -p"${MYSQL_PASSWORD}"
  rm -f /tmp/_restore_db.sql.gz
'

echo "[restore] 3/5  restore /var/phorge-files ($(du -h "${WORK_DIR}/phorge-files.tar.gz" | cut -f1))"
docker cp "${WORK_DIR}/phorge-files.tar.gz" "${CID}:/tmp/_restore_files.tar.gz"
docker compose exec -T phorge bash -lc '
  set -e
  find /var/phorge-files -mindepth 1 -delete 2>/dev/null || true
  tar xzf /tmp/_restore_files.tar.gz -C /var/phorge-files
  chown -R www-data:www-data /var/phorge-files
  rm -f /tmp/_restore_files.tar.gz
'

echo "[restore] 4/5  restore /var/repo ($(du -h "${WORK_DIR}/phorge-repos.tar.gz" | cut -f1))"
docker cp "${WORK_DIR}/phorge-repos.tar.gz" "${CID}:/tmp/_restore_repos.tar.gz"
docker compose exec -T phorge bash -lc '
  set -e
  find /var/repo -mindepth 1 -delete 2>/dev/null || true
  tar xzf /tmp/_restore_repos.tar.gz -C /var/repo
  chown -R www-data:www-data /var/repo
  rm -f /tmp/_restore_repos.tar.gz
'

echo "[restore] 5/5  bin/storage upgrade --force"
docker compose exec -T phorge runuser -u www-data -- bash -lc \
    'cd /opt/phorge/phorge && ./bin/storage upgrade --force' | tail -5

# Persist the bundle hash so a re-run with the same bundle short-circuits.
echo "${NEW_HASH}" | docker compose exec -T phorge tee /var/run/phorge/.last-restored >/dev/null

echo
BASE_URI=$(grep -E '^PHORGE_BASE_URI=' .env 2>/dev/null | cut -d= -f2- || true)
echo "[restore] done (marker sha256: ${NEW_HASH:0:12}...). visit ${BASE_URI:-the Phorge URL} to verify."
