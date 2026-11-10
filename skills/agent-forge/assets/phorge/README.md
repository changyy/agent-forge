# Local Phorge instance

Created by [agent-forge](https://github.com/changyy/agent-forge). This directory holds a self-contained
[Phorge](https://we.phorge.it/) (Phabricator fork) plus MariaDB, run with Docker Compose. Coding agents use it as
their issue tracker and wiki.

| File | Purpose |
| --- | --- |
| `.env` | Ports, URL, passwords. Generated once with random secrets; git-ignored. |
| `project.json` | Which agent-forge profile this project uses. |
| `docker-compose.yml` | `phorge` and `mysql` services with named volumes. |
| `Dockerfile` | PHP 8.3 + Apache + Phorge cloned from upstream. |
| `config/` | Apache vhost, PHP and MariaDB client settings. |
| `scripts/entrypoint.sh` | Boot: wait for DB, configure, migrate schema, create users on first run. |
| `scripts/init-users.php` | Creates the admin and the agent bot, enables password login, mints the API token. |
| `scripts/backup.sh` / `restore.sh` | Bundle or restore DB + uploaded files + repos. |

## Everyday commands

Run these from this directory:

```bash
docker compose ps            # status
docker compose up -d         # start
docker compose stop          # stop (data is kept)
docker compose logs -f phorge
```

Or ask your agent: "start / stop / show the status of the issue tracker".

## Logging in

Open `PHORGE_BASE_URI` from `.env` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
The agent account (`AGENT_USERNAME`) is a bot: it has an API token but cannot log in to the web UI.

The agent's token is stored in the `phorge-state` volume:

```bash
docker compose exec phorge cat /var/run/phorge/agent.token
```

## Backup and restore

```bash
scripts/backup.sh                                   # -> ./backups/phorge-backup-<timestamp>.tar
scripts/restore.sh ./backups/phorge-backup-<ts>.tar # DESTRUCTIVE, asks for confirmation
```

The bundle contains `manifest.txt`, `db.sql.gz` (`bin/storage dump`), `phorge-files.tar.gz` and
`phorge-repos.tar.gz`. Restoring the same bundle twice is skipped unless `--force` is given.

## Starting over

```bash
docker compose down --volumes   # deletes ALL tracker data
rm .env                         # optional: new port + passwords next time
```

Then ask the agent to provision again.
