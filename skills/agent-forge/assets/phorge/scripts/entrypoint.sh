#!/bin/bash
# Phorge container entrypoint.
# Responsibilities (idempotent — safe to re-run on every boot):
#   1. Wait for MySQL to be reachable.
#   2. Write local Phorge config (mysql + base_uri + storage + repository paths).
#   3. Run bin/storage upgrade --force to (re)apply schema.
#   4. On first run, create the admin + agent users, enable username/password
#      login, and mint a Conduit token for the agent. The token is persisted to
#      /var/run/phorge/agent.token so the host can read it via the named volume.
#   5. Start the Phorge daemons (search indexing, feed, repositories, ...).
#   6. Exec apache in the foreground.

set -euo pipefail

PHORGE_DIR="${PHORGE_DIR:-/opt/phorge}"
PHORGE_ROOT="${PHORGE_DIR}/phorge"
STATE_DIR="/var/run/phorge"
TOKEN_FILE="${STATE_DIR}/agent.token"
PHORGE_TIMEZONE="${PHORGE_TIMEZONE:-UTC}"
INIT_FLAG="${STATE_DIR}/.initialized"

log() { printf '[entrypoint] %s\n' "$*"; }

# Phorge bin scripts refuse to run as root, so always go through www-data.
as_www() {
    runuser -u www-data -- "$@"
}

wait_for_mysql() {
    log "waiting for mysql at ${MYSQL_HOST}:${MYSQL_PORT}..."
    for i in $(seq 1 60); do
        if mariadb -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" -e 'SELECT 1' >/dev/null 2>&1; then
            log "mysql is up"
            return 0
        fi
        sleep 2
    done
    log "mysql did not become reachable in time" >&2
    return 1
}

configure_php() {
    printf 'date.timezone = %s\n' "${PHORGE_TIMEZONE}" > /usr/local/etc/php/conf.d/zz-phorge-timezone.ini
}

configure_phorge() {
    log "writing phorge config..."
    cd "${PHORGE_ROOT}"
    as_www ./bin/config set mysql.host       "${MYSQL_HOST}"
    as_www ./bin/config set mysql.port       "${MYSQL_PORT}"
    as_www ./bin/config set mysql.user       "${MYSQL_USER}"
    as_www ./bin/config set mysql.pass       "${MYSQL_PASSWORD}"
    as_www ./bin/config set phabricator.base-uri "${PHORGE_BASE_URI}"
    if [[ -n "${PHORGE_ALLOWED_URIS:-}" ]]; then
        # Comma-separated list of additional URIs whose Host header Phorge will
        # accept without redirecting. Useful when the same instance is reached
        # via multiple hostnames (e.g. localhost + LAN IP).
        IFS=',' read -r -a _uris <<< "${PHORGE_ALLOWED_URIS}"
        _json='['
        for _u in "${_uris[@]}"; do
            _u="${_u## }"; _u="${_u%% }"
            _json+="\"${_u}\","
        done
        _json="${_json%,}]"
        as_www ./bin/config set phabricator.allowed-uris "${_json}"
    fi
    as_www ./bin/config set phabricator.timezone "${PHORGE_TIMEZONE}"
    as_www ./bin/config set repository.default-local-path /var/repo
    as_www ./bin/config set storage.local-disk.path /var/phorge-files
}

storage_upgrade() {
    log "applying storage schema..."
    cd "${PHORGE_ROOT}"
    as_www ./bin/storage upgrade --force
}

init_users() {
    if [[ -f "${INIT_FLAG}" ]]; then
        log "users already initialized; skipping (delete ${INIT_FLAG} to redo)"
        return 0
    fi

    log "creating admin + agent users and the agent Conduit token..."
    cd "${PHORGE_ROOT}"
    as_www php scripts/init-users.php \
        --admin-username "${ADMIN_USERNAME}" \
        --admin-email "${ADMIN_EMAIL}" \
        --admin-realname "${ADMIN_REALNAME}" \
        --admin-password "${ADMIN_PASSWORD}" \
        --agent-username "${AGENT_USERNAME}" \
        --agent-email "${AGENT_EMAIL}" \
        --agent-realname "${AGENT_REALNAME}" \
        --token-out "${TOKEN_FILE}"

    chmod 600 "${TOKEN_FILE}" || true
    chown www-data:www-data "${TOKEN_FILE}" || true
    touch "${INIT_FLAG}"

    log "agent Conduit token written to ${TOKEN_FILE}"
}

start_daemons() {
    log "starting phorge daemons..."
    cd "${PHORGE_ROOT}"
    # Stale pid files from a previous container run would block a clean start.
    as_www ./bin/phd stop >/dev/null 2>&1 || true
    as_www ./bin/phd start || log "warning: phd failed to start; search indexing will lag"
}

main() {
    configure_php
    wait_for_mysql
    configure_phorge
    storage_upgrade
    init_users
    start_daemons

    case "${1:-apache}" in
        apache)
            log "starting apache in foreground"
            exec apache2-foreground
            ;;
        bash|sh)
            exec "$@"
            ;;
        *)
            exec "$@"
            ;;
    esac
}

main "$@"
