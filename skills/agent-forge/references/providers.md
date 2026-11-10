# Provider contract

A provider adapts one tracker (Phorge, GitLab, Bitbucket, …) to the agent-forge command set.
Providers live in `scripts/lib/providers/<id>/` and are registered in `scripts/lib/providers/index.js`.

## Module shape

```js
export default {
  id: 'gitlab',                       // used in profiles and --provider
  displayName: 'GitLab',
  capabilities: { wiki: true },       // informational, shown by `forge providers`
  createClient(profile) { ... },      // required
  provision: { ... },                 // optional: only for providers that can run locally in Docker
};
```

`profile` is `{ provider, baseUrl, token, defaultProject }`. `defaultProject` is free-form and provider-specific,
for example `group/project` on GitLab or `workspace/repo` on Bitbucket. Use it when an issue reference or a
create call needs a container.

## Client operations

Leave out any operation the provider cannot do. The CLI then reports it as `unsupported` (exit code 3).
Do not fake it.

| Operation | Signature | Returns |
| --- | --- | --- |
| `whoami()` | | `Account` |
| `issue.get(ref, { comments })` | `comments`: max number of latest comments | `Issue` with `comments: Comment[]` |
| `issue.create({ title, description, priority, assignee, tags })` | `assignee`: a username; `tags`: string[] | `{ ref, id, url }` |
| `issue.comment(ref, body)` | | `{ ref, url, commented: true }` |
| `issue.setStatus(ref, status)` | `status`: `open`, `closed`, or a native value | `{ ref, url, status, nativeStatus }` |
| `issue.search(query, { limit, status, assignee })` | `status`: `open`, `closed`, or a native value | `{ count, items: Issue[] }` (without `description`) |
| `wiki.get(slugOrUrl)` | | `WikiPage` |
| `user.get(username)` | | `Account` |

`ref` is whatever the user gives you: the native form (`T12`, `group/proj#12`), a bare number (resolved
against `defaultProject` when needed), or the issue's web URL. Parse it in the provider.

## Normalized shapes

```ts
Account  = { username, realName, id, url?, roles? }

Issue    = {
  ref,            // native display reference, e.g. "T12" or "group/proj#12"
  id,             // native id
  url,
  title,
  description,    // raw markup
  status,         // "open" | "closed"
  nativeStatus,   // the provider's own value
  priority,       // display name or null
  author,         // username
  assignee,       // username or null
  createdAt, updatedAt,   // ISO-8601
  comments?: Comment[]
}

Comment  = { author, createdAt, body }

WikiPage = { path, url, title, body, updatedAt }
```

## Errors

Throw `ForgeError` from `scripts/lib/output.js` with one of these codes:

| code | Meaning |
| --- | --- |
| `unreachable` | network error, non-2xx response, or a response that is not from this kind of server |
| `auth_failed` | the token was rejected |
| `usage` | bad input (unparseable ref, missing title…) |
| `error` | anything else (not found, API error) |

`forge check` relies on `whoami()` to tell `unreachable` and `auth_failed` apart. Map these errors carefully.

## Provisioning (optional)

Implement this only if the tracker can run self-hosted in Docker (GitLab CE, Gitea, …). Cloud-only services
(Bitbucket Cloud, GitHub.com) leave `provision` out.

```js
provision: {
  async run({ root, port, timezone, refreshAssets, waitSeconds }),
      // -> { baseUrl, token, dir, composeProject, agent: Account, admin: {...}, fresh }
  // -> also { assetsCopied } so the CLI can record which skill version the Docker files came from
  info({ root }),      // static facts without touching Docker: { dir, baseUrl, composeProject }
  status({ root }), start({ root }), stop({ root }), logs({ root }, { tail }), destroy({ root }),
}
```

Conventions to follow, as in `providers/phorge/provision.js`:

- Put everything under `<root>/agent-forge/`. Docker assets come from `assets/<id>/`.
- Generate `.env` once, with random secrets, a free port and a unique `COMPOSE_PROJECT_NAME`. Never overwrite it.
- Send long `docker compose` output to `agent-forge/provision.log`, not to stdout.
- Be idempotent: a second `run` must resume, not fail or duplicate.
- Create a dedicated bot account for the agent and return its API token. Never return an admin token.

## Checklist for a new provider

1. `scripts/lib/providers/<id>/index.js` (+ `api.js`, optionally `provision.js` and `assets/<id>/`).
2. Register it in `scripts/lib/providers/index.js`.
3. Add `references/<id>.md` with its quirks (ref format, statuses, how to create a token).
4. Mention it under "Supported providers" in `SKILL.md` and in the repository README.
5. Run `npm test` from the repository root.
