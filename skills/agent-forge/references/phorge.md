# Phorge / Phabricator notes

## API token

- Personal token: `<base-url>/settings/user/<username>/page/apitokens/` → Generate Token.
- Bot account (recommended for agents): an admin creates a bot at `<base-url>/people/new/bot/`. Then open the
  bot's profile → Manage → Edit Settings → Conduit API Tokens.
- Tokens look like `api-` followed by 28 characters.
- Locally provisioned instances create the bot and its token automatically.

## References

- Tasks: `T123`. A bare `123` or `<base-url>/T123` also works.
- Wiki (Phriction): the path after `/w/`, for example `projects/backend` or `<base-url>/w/projects/backend/`.
  The root page is `/`.

## Statuses

Default statuses: `open`, `resolved`, `wontfix`, `invalid`, `duplicate`, `spite`. An installation can define
its own statuses. agent-forge reads the open/closed sets from `maniphest.querystatuses`, so normalization still
works when statuses are customized.

- `forge issue status T1 closed` sets the installation's default closed status (usually `resolved`).
- `forge issue status T1 wontfix` sets a native status directly.

## Priorities

`unbreak`, `triage`, `high`, `normal`, `low`, `wish`. Installations can rename them. Use the keyword shown in the
task's priority menu.

## Tags

`--tag` takes a project slug (hashtag): the part after `#`, lowercase, with spaces written as `_`.

## Remarkup cheatsheet

```
**bold**  //italic//  `code`  ~~strike~~
= Header =   == Subheader ==
- list item
[[ wiki/path | link text ]]   T123   @username
```lang=python
code block
```
```

## Local instance details

- Web URL and ports: `./agent-forge/.env` (`PHORGE_BASE_URI`, `PHORGE_HOST_PORT`).
- The base URI host must contain a dot. Phorge rejects `localhost`, so `127.0.0.1` is used.
- To reach the instance under another hostname (for example from the LAN), add the URL to
  `PHORGE_ALLOWED_URIS` in `.env` and run `forge sandbox start`.
