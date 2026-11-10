# agent-forge

An agent skill for **Claude Code** and **Codex CLI** that gives a coding agent an issue tracker.

- **Connect** an existing tracker, or **create** a local one with Docker in one step.
- Then work with issues, comments, statuses, search and wiki pages through a single command set.
- The command set does not depend on which tracker is behind it.

Supported providers:

| Provider | Connect existing | Local Docker instance |
| --- | --- | --- |
| Phorge / Phabricator | ✅ | ✅ |
| GitLab, Bitbucket, … | planned | — |

## Install

Run this in your project directory:

```bash
npx github:changyy/agent-forge install            # this project (same as --local)
npx github:changyy/agent-forge install --global   # every project
```

| | `--local` (default) | `--global` |
| --- | --- | --- |
| Claude Code | `./.claude/skills/agent-forge` | `~/.claude/skills/agent-forge` |
| Codex CLI | `./.agents/skills/agent-forge` | `~/.agents/skills/agent-forge` |

The installer targets every CLI it detects. To choose explicitly, add `--claude`, `--codex` or `--all`.

`install` always overwrites the installed copy, so running it again updates the skill. Other commands:

```bash
npx github:changyy/agent-forge status        # what is installed where, and which version
npx github:changyy/agent-forge uninstall [--local|--global]
```

Requirements: Node.js 18+. Docker is needed only for the local instance.

## Usage scenarios

### 1. First time: from an empty directory to a working tracker

```bash
mkdir my-project && cd my-project
npx github:changyy/agent-forge install
claude            # or: codex
```

> **You:** Check whether the issue tracker is configured.
>
> **Agent:** No issue tracker is configured for this project. Should I connect an existing service, or create a
> new local one with Docker? (Docker is running.)
>
> **You:** Create a new one.
>
> **Agent:** *(runs `provision`, about 5 minutes the first time)* Done. Phorge is at http://127.0.0.1:8080/. Admin
> login: `admin` / `…` (also in `agent-forge/.env`). I'll work through the bot account `agent`.
> Should I add a short note about the tracker to CLAUDE.md and AGENTS.md, so future sessions resume from it
> automatically?
>
> **You:** Yes.
>
> **Agent:** *(runs `memo enable`)* Added.

To connect an existing tracker instead, answer "connect" and give the agent the URL and an API token. The agent
validates them, saves a profile and links the project.

The memo question is asked only once per project. The answer is stored in `agent-forge/project.json` and reused.
To change it later, ask the agent, or run `forge memo enable` / `forge memo disable`.

### 2. Next session: pick up where you left off

Open the project again and start the agent. Because of the CLAUDE.md / AGENTS.md note, the agent begins with
`resume`:

> **Agent:** The tracker is up. You have 2 open issues assigned to me: T7 "Add login rate limiting" (last updated
> yesterday, comment: tests pending) and T9 "Document the API". Continue with T7?

`resume` handles the usual interruptions and tells the agent (and you) what to do:

| Situation | `status` | What happens |
| --- | --- | --- |
| Everything is up | `ok` | Lists open issues assigned to the agent, plus other open issues |
| Machine rebooted, Docker not started yet | `docker_down` | Asks you to start Docker; the containers restart on their own |
| Containers were stopped | `sandbox_stopped` | The agent runs `sandbox start` |
| Project cloned on another machine | `profile_missing` | Asks whether to connect to the original service or provision a new local one (optionally restoring a backup) |
| Token revoked or expired | `auth_failed` | Asks you for a new token |
| Skill updated since the instance was created | warning `assets_outdated` | Offers `provision --refresh-assets` (rebuilds, keeps data) |

While working, the agent follows simple conventions: one issue per piece of work, progress comments, and a
summary comment before closing. That record is what the next session resumes from.

### Updating the skill

```bash
npx github:changyy/agent-forge install    # same command; overwrites with the latest version
```

If the project has a local instance, the next `resume` reports `assets_outdated`. Let the agent run
`provision --refresh-assets` to rebuild with the new Docker files. The data is kept.

### What ends up in your project

```
your-project/
├── .claude/skills/agent-forge/   # or .agents/skills/… for Codex (local install)
├── CLAUDE.md, AGENTS.md         # only if you accept the memo: a marked tracker note
└── agent-forge/
    ├── project.json              # linked profile, memo choice, Docker-files version
    ├── .env                      # local instance: port, URL, passwords (git-ignored)
    ├── docker-compose.yml, Dockerfile, config/, scripts/
    └── README.md                 # start/stop, login, backup/restore
```

Saved connections (profiles) live in `~/.config/agent-forge/config.json`, shared by all projects and agents.

## Command reference

The agent runs `node <skill-dir>/scripts/forge.js <command>`. You can run it yourself too:

```text
check | resume | providers | version
connect --provider phorge --base-url URL --token TOKEN [--profile NAME] [--no-link] [--default]
provision --provider phorge [--port N] [--timezone TZ] [--refresh-assets]
sandbox status | start | stop | logs | destroy --yes
memo status | enable | disable
profile list | show | use NAME [--global] | remove NAME
whoami
issue get REF | create --title … | comment REF --body … | status REF open|closed|… | search [QUERY]
wiki get SLUG
user get USERNAME
```

Every command prints JSON. See [`skills/agent-forge/SKILL.md`](skills/agent-forge/SKILL.md).

## Development

```
bin/agent-forge.js                 installer (npx entry point)
skills/agent-forge/                the skill itself (copied as-is on install)
  SKILL.md                         {{SKILL_DIR}} / {{VERSION}} are filled in by the installer
  scripts/forge.js                 runtime CLI
  scripts/lib/providers/<id>/      one directory per tracker
  assets/<id>/                     Docker files for providers that can run locally
  references/                      provider contract and per-provider notes
tools/bump-version.js              stamps a new version
tools/smoke-test.js                offline install + CLI checks
```

- Add a provider: see [`references/providers.md`](skills/agent-forge/references/providers.md).
- Versions use the format `1.YYYYmmdd.1HHmmss`, for example `1.20261111.1001220`. Run `npm run bump` before
  tagging a release. It updates `package.json` and `skills/agent-forge/VERSION`.
- Tests: `npm test`. These are offline and do not need Docker.
- Try a local checkout: `node bin/agent-forge.js install` from the target directory.

## License

MIT © Yuan-Yi Chang
