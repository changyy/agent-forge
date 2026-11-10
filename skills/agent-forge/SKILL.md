---
name: agent-forge
description: Issue tracker for coding agents. Use at the start of a session in a project that has an agent-forge/ directory or an agent-forge note in CLAUDE.md/AGENTS.md (run resume), when the user asks whether the issue tracker / task tracking is configured, wants to connect an existing tracker (Phorge, Phabricator) or create a local one with Docker, asks what to work on next or where they left off, or wants to read, create, comment on, close or search issues/tasks or read wiki pages. Also starts, stops and checks the local tracker sandbox.
---

# agent-forge

agent-forge connects this project to an issue tracker, or creates one locally with Docker, and then gives you
one command set for issues, comments, status changes, search and wiki pages. The command set does not depend on
which tracker is behind it.

Supported providers: `phorge` (Phorge and Phabricator). Phorge can be connected or provisioned locally.

## How to run commands

Every command is:

```bash
node {{SKILL_DIR}}/scripts/forge.js <command> [args]
```

- `{{SKILL_DIR}}` is this skill's directory. If the path is relative, it is relative to the project root. If it
  does not resolve, use the directory that contains this SKILL.md.
- Requires Node.js 18 or newer. If `node` is missing, tell the user to install it.
- Output: one JSON document on stdout. Errors: JSON on stderr with `error.code` and a non-zero exit code.
  Exit codes: `2` usage, `3` the provider does not support the operation, `4` not configured.
- Progress lines start with `[agent-forge]` and go to stderr.

Below, `forge` stands for `node {{SKILL_DIR}}/scripts/forge.js`.

## Session start: resume

When the project is already set up (it has `agent-forge/project.json`, or CLAUDE.md/AGENTS.md has an agent-forge
note), begin every session with:

```bash
forge resume
```

- `status: "ok"`: summarize `assignedToMe` (open issues assigned to you) and `otherOpen` briefly for the user.
  Then follow `next`. By default, continue the most recently updated issue assigned to you after reading it with
  `forge issue get`. If the user asks for something else, do that instead.
- Any other status: handle it as described in the status table below, then run `resume` again.
- Mention every entry in `warnings` to the user once (see "Warnings").

## Setup: "Is the issue tracker configured?"

Run `forge check`, then act on `status`. Every result also includes a `next` hint.

| status | What to do |
| --- | --- |
| `ok` | Tell the user which tracker (`profile.baseUrl`) and which account (`account.username`) are in use. |
| `unconfigured` | Ask the user to choose: **connect an existing service** (Connect) or **create a new local instance with Docker** (Provision). Do not choose for them. Use `docker.running` to say whether Docker is ready. |
| `profile_missing` | This project is linked to a profile that this machine does not have (new machine or fresh clone). Ask the user: connect to the original service again (Connect), or provision a new local instance (Provision) and optionally restore a backup. |
| `docker_down` | The local tracker needs Docker, and Docker is not running. Ask the user to start Docker. The containers restart on their own; then run `check` again (the first boot can take a minute). |
| `sandbox_stopped` | Run `forge sandbox start`, then `check` again. |
| `unreachable` | Report the URL that failed. A sandbox that was just started may still be booting, so retry after about 30 seconds. Otherwise offer to reconfigure with Connect. |
| `auth_failed` | Ask the user for a new API token, then use Connect. |
| `error` | Show `error` to the user and fix the profile with Connect or `forge profile`. |

## Connect an existing service

```bash
forge connect --provider phorge --base-url https://phorge.example.com --token api-xxxxxxxx [--profile NAME]
```

- This validates the token with the provider, saves a profile, and links the current project to it in
  `./agent-forge/project.json`.
- For Phorge/Phabricator, the token is created at `<base-url>/settings/` → Conduit API Tokens. A bot account's
  token works best (see `references/phorge.md`).
- `--no-link` saves the profile without linking the project. `--default` also makes it the global default.
- Never repeat the full token back to the user. The output masks it.
- Then handle `memo` in the output (see "Project memo").

## Provision a local instance (Docker)

1. If `check` reported `docker.running: false`, ask the user to start Docker first.
2. Run:
   ```bash
   forge provision --provider phorge
   ```
   - The first run builds an image and can take 3–10 minutes. Give the shell command a long timeout (10 minutes),
     or run it in the background and wait for it to finish.
   - The command is idempotent. If it times out or is interrupted, run the same command again: it reuses the
     existing `.env` and containers and resumes waiting.
   - Options: `--port N` (default: first free port from 8080), `--timezone Area/City` (default: host timezone),
     `--refresh-assets` (re-copy the Docker files from the skill and rebuild; data is kept).
3. Tell the user what was produced (all values are in the JSON output):
   - The URL (`baseUrl`) and the admin web login (`adminLogin.username` / `adminLogin.password`).
   - The agent works through a bot account (`agentAccount.username`). The bot is API only.
   - Files are in `./agent-forge/`. `.env` holds the secrets and is git-ignored.
4. Handle `memo` in the output (see "Project memo").
5. Run `forge check` once more to confirm `status: ok`.

## Project memo (asked once, then remembered)

`connect` and `provision` return `memo`:

- `memo.ask` is present: the user has not decided yet. Ask once: *"Add a short note about the issue tracker to
  CLAUDE.md and AGENTS.md, so future sessions automatically resume from it?"* Then run `forge memo enable` or
  `forge memo disable`. The answer is stored in `agent-forge/project.json`.
- `memo.setting: true`: the note was refreshed automatically (for example with a new URL). Do not ask again.
- `memo.setting: false`: the user declined. Do not ask again.

Use `forge memo status` to check the setting. The note sits between `<!-- agent-forge:begin -->` and
`<!-- agent-forge:end -->`. Everything else in those files is left untouched.

## Working conventions

Follow these conventions so the tracker holds a usable record of the work, and the next session (yours or
another agent's) can pick it up:

1. **One issue per piece of work.** Before you start a non-trivial task, find its issue
   (`forge issue search`) or create one. Assign it to yourself with `--assignee <your username>`; `resume` and
   `whoami` show your username.
2. **Comment as you go.** Post a comment when you make a decision, finish a meaningful step, get blocked, or stop
   for the day. Say what changed, why, and what is next. Keep comments short and factual.
3. **Close with a summary.** When the work is done, comment with a summary (what was done, where: files,
   commits, PRs), then run `forge issue status REF closed`.
4. **Tell the user.** After you create or close an issue, give the user its `url`.
5. **Do not invent work.** Do not create issues the user did not ask for, other than to track the work you are
   doing for them.

## Managing the local instance

```bash
forge sandbox status          # containers and URL
forge sandbox start           # docker compose up -d
forge sandbox stop            # stop, keep data
forge sandbox logs --tail 200
forge sandbox destroy --yes   # DELETES ALL DATA (containers + volumes)
```

Only run `destroy` after the user has explicitly confirmed that all tracker data may be deleted. Backup and
restore scripts are in `./agent-forge/scripts/`. See `./agent-forge/README.md`.

## Issue commands

```bash
forge whoami
forge issue search [words...] [--status open|closed|<native>] [--assignee USER] [--limit 20]
forge issue get T123 [--comments 20]
forge issue create --title "..." [--description "..." | --description-file path] \
                   [--priority high] [--assignee USER] [--tag project-slug ...]
forge issue comment T123 --body "..."        # or --body-file path for long text
forge issue status T123 closed               # open | closed | a native status such as wontfix
forge wiki get some/page                     # or a full wiki URL
forge user get USERNAME
```

- Issue references: provider-native IDs (`T123` for Phorge). A bare number or the issue URL also works.
- `status` is normalized to `open` / `closed`. `nativeStatus` keeps the provider's own value.
- For multi-line text, write it to a temporary file and use `--description-file` or `--body-file`. This avoids
  shell-quoting problems.
- Phorge text is Remarkup: `**bold**`, `` `code` ``, fenced code blocks with ```, and `T123` auto-links.

## Warnings

`check` and `resume` can return these warnings:

- `assets_outdated`: the skill was updated after the local instance was created. Offer to run
  `forge provision --refresh-assets`, which rebuilds the instance and keeps the data.
- `memo_undecided`: ask the memo question (see "Project memo").
- `memo_missing`: the memo is enabled, but the note was removed from CLAUDE.md/AGENTS.md. Run `forge memo enable`
  to restore it, or `forge memo disable` if the user removed it on purpose.

## Profiles

A profile is a saved connection (provider + URL + token). Profiles are stored in
`~/.config/agent-forge/config.json` and shared by all projects and agents. The profile is chosen in this order:

1. `--profile NAME`
2. `$AGENT_FORGE_PROFILE`
3. `./agent-forge/project.json` (searched upward from the cwd)
4. the global default profile

`$AGENT_FORGE_BASE_URL`, `$AGENT_FORGE_TOKEN` and `$AGENT_FORGE_PROVIDER` override the profile's fields for one call.

```bash
forge profile list
forge profile use NAME            # link this project to NAME
forge profile use NAME --global   # make NAME the global default
forge profile remove NAME
```

## Unsupported operations

If a command exits with code `3` (`error.code: "unsupported"`), the active provider cannot do that operation.
Tell the user so. Do not emulate it.

## More

- `references/providers.md`: the provider contract, for adding GitLab, Bitbucket and others.
- `references/phorge.md`: Phorge-specific notes (statuses, priorities, tokens).
- Skill version: {{VERSION}} (`forge version`).
