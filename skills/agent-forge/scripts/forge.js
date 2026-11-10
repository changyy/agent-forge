#!/usr/bin/env node
// agent-forge runtime CLI. Every command prints one JSON document.
// Run `node forge.js help` for the command list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.js';
import {
  configPath,
  findProjectRoot,
  loadConfig,
  loadProject,
  maskToken,
  removeProfile,
  resolveProfile,
  saveConfig,
  saveProfile,
  saveProject,
} from './lib/config.js';
import { dockerStatus } from './lib/docker.js';
import { memoState, removeMemo, writeMemo } from './lib/memo.js';
import { ForgeError, handleError, ok, progress, unsupported, usage } from './lib/output.js';
import { getProvider, listProviders } from './lib/providers/index.js';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function version() {
  try {
    return fs.readFileSync(path.join(SKILL_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

const HELP = {
  usage: 'node forge.js <command> [args] [--profile NAME]',
  commands: {
    'version': 'Show skill version and runtime info.',
    'check': 'Diagnose the tracker setup for this project (status + next step).',
    'resume [--limit N]': 'Start-of-session summary: tracker status, open issues assigned to you, other open issues.',
    'memo status|enable|disable': 'Add/remove the issue-tracker note in CLAUDE.md and AGENTS.md (the choice is remembered).',
    'providers': 'List supported providers and their capabilities.',
    'connect --provider P --base-url URL --token T [--profile NAME] [--no-link] [--default]':
      'Validate credentials for an existing service, save them as a profile and link this project to it.',
    'provision --provider P [--port N] [--timezone TZ] [--refresh-assets] [--wait-seconds N] [--profile NAME]':
      'Create a local Docker instance in ./agent-forge/, save its profile and link this project to it.',
    'sandbox status|start|stop|logs [--tail N]|destroy --yes': 'Manage the local Docker instance of this project.',
    'profile list|show [NAME]|use NAME [--global]|remove NAME': 'Manage saved profiles.',
    'whoami': 'Show the account behind the active profile.',
    'issue get REF [--comments N]': 'Fetch an issue with its latest comments.',
    'issue create --title T [--description D | --description-file F] [--priority P] [--assignee USER] [--tag TAG ...]':
      'Create an issue.',
    'issue comment REF (--body TEXT | --body-file F | TEXT...)': 'Add a comment.',
    'issue status REF STATUS': 'Set status: open, closed, or a provider-native status.',
    'issue search [QUERY...] [--status open|closed|NATIVE] [--assignee USER] [--limit N]': 'Search issues.',
    'wiki get SLUG|URL': 'Fetch a wiki page.',
    'user get USERNAME': 'Look up a user.',
  },
};

function textArg(args, key, fileKey, rest) {
  if (typeof args[fileKey] === 'string') return fs.readFileSync(args[fileKey], 'utf8');
  if (typeof args[key] === 'string') return args[key];
  if (rest && rest.length) return rest.join(' ');
  return undefined;
}

function activeClient(args) {
  const profile = resolveProfile(args);
  if (!profile) {
    throw new ForgeError('unconfigured', 'No issue tracker is configured for this project.', {
      hint: 'Run "check", then "connect" (existing service) or "provision" (local Docker instance).',
    });
  }
  const provider = getProvider(profile.provider);
  return { profile, provider, client: provider.createClient(profile) };
}

function need(client, provider, group, op) {
  const fn = client[group]?.[op];
  if (!fn) throw unsupported(provider.id, `${group} ${op}`);
  return fn;
}

function profileView(name, p) {
  return { name, provider: p.provider, baseUrl: p.baseUrl, token: maskToken(p.token), defaultProject: p.defaultProject };
}

// ── Commands ────────────────────────────────────────────────────

function sameUrl(a, b) {
  return Boolean(a && b) && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

// Status values, in the order they are diagnosed:
//   unconfigured     no profile at all
//   profile_missing  project.json names a profile this machine does not have
//   docker_down      the project's local sandbox needs Docker, which is not running
//   sandbox_stopped  Docker runs, but the sandbox containers do not
//   unreachable      the service did not answer (network, URL, still booting)
//   auth_failed      the token was rejected
//   error            anything else
//   ok
const NEXT = {
  ok: 'Ready.',
  unconfigured: 'Ask the user: connect an existing service ("connect") or create a local Docker instance ("provision")?',
  profile_missing:
    'This project is linked to a profile that does not exist on this machine (new machine or fresh clone). Ask the user: ' +
    'connect to the original service again ("connect"), or, if it was a local sandbox, "provision" a new one ' +
    '(optionally restore a backup with agent-forge/scripts/restore.sh afterwards).',
  docker_down: 'The local tracker runs in Docker, and Docker is not running. Ask the user to start Docker (Docker Desktop), then run "check" again. The containers restart on their own.',
  sandbox_stopped: 'The local tracker is stopped. Run "sandbox start", then "check" again.',
  unreachable: 'The service did not respond. Check the URL / network (a sandbox may still be booting; retry in a minute), or reconfigure with "connect".',
  auth_failed: 'The token was rejected. Ask the user for a new token and run "connect" again.',
  error: 'See "error". Fix the profile with "connect" or "profile".',
};

async function diagnose(args) {
  const result = {
    status: 'unconfigured',
    skillVersion: version(),
    node: process.versions.node,
    config: configPath(),
    project: null,
    profile: null,
    account: null,
    sandbox: null,
    docker: dockerStatus(),
    memo: null,
    warnings: [],
    providers: listProviders(),
  };

  const project = loadProject();
  if (project) result.project = { root: project.root, file: project.file, ...project.data };

  if (project?.data?.sandbox) {
    try {
      const provider = getProvider(project.data.sandbox.provider);
      result.sandbox = provider.provision.status({ root: project.root });
    } catch (err) {
      result.sandbox = { error: err.message };
    }
    const av = project.data.assetsVersion;
    if (av && av !== version()) {
      result.warnings.push({
        code: 'assets_outdated',
        message: `The Docker files in agent-forge/ come from skill ${av}; the skill is now ${version()}. Run "provision --refresh-assets" to update and rebuild (data is kept).`,
      });
    }
  }

  let profile = null;
  try {
    profile = resolveProfile(args);
  } catch (err) {
    result.status = project?.data?.profile && err.code === 'unconfigured' ? 'profile_missing' : 'error';
    result.error = err.message;
  }

  if (profile) {
    result.profile = { name: profile.name, source: profile.source, provider: profile.provider, baseUrl: profile.baseUrl };
    const usesSandbox = result.sandbox && sameUrl(result.sandbox.baseUrl, profile.baseUrl);
    if (usesSandbox && !result.docker.running) {
      result.status = 'docker_down';
    } else if (usesSandbox && !result.sandbox.running) {
      result.status = 'sandbox_stopped';
    } else {
      try {
        result.account = await getProvider(profile.provider).createClient(profile).whoami();
        result.status = 'ok';
      } catch (err) {
        result.status = ['auth_failed', 'unreachable'].includes(err.code) ? err.code : 'error';
        result.error = err.message;
      }
    }
  }

  if (project) {
    result.memo = { setting: project.data.memo ?? null, files: memoState(project.root) };
    if (result.status === 'ok' && project.data.memo === undefined) {
      result.warnings.push({
        code: 'memo_undecided',
        message: 'Ask the user once whether to add an issue-tracker note to CLAUDE.md / AGENTS.md, then run "memo enable" or "memo disable".',
      });
    } else if (project.data.memo === true && !Object.values(result.memo.files).every(Boolean)) {
      result.warnings.push({ code: 'memo_missing', message: 'The tracker note is missing from CLAUDE.md / AGENTS.md. Run "memo enable" to restore it.' });
    }
  }

  result.next = NEXT[result.status];
  return result;
}

async function cmdCheck(args) {
  return diagnose(args);
}

async function cmdResume(args) {
  const d = await diagnose(args);
  if (d.status !== 'ok') {
    return { status: d.status, next: d.next, error: d.error, warnings: d.warnings, diagnostics: d };
  }
  const profile = resolveProfile(args);
  const client = getProvider(profile.provider).createClient(profile);
  const me = d.account.username;
  const limit = Number(args.limit) || 20;
  const [mine, recent] = await Promise.all([
    client.issue?.search ? client.issue.search('', { assignee: me, status: 'open', limit }) : null,
    client.issue?.search ? client.issue.search('', { status: 'open', limit: 10 }) : null,
  ]);
  const mineRefs = new Set((mine?.items || []).map((i) => i.ref));
  return {
    status: 'ok',
    tracker: { provider: profile.provider, baseUrl: profile.baseUrl, profile: profile.name, account: me },
    assignedToMe: mine?.items || [],
    otherOpen: (recent?.items || []).filter((i) => !mineRefs.has(i.ref)),
    warnings: d.warnings,
    next:
      mineRefs.size > 0
        ? 'Summarize the open issues for the user and continue the most recently updated one unless they say otherwise. Read it first with "issue get".'
        : 'No open issues are assigned to you. Ask the user what to work on, then create an issue for it.',
  };
}

// Applies the remembered memo preference after connect/provision.
function applyMemo(root) {
  const project = loadProject(root);
  const setting = project?.data?.memo;
  if (setting === false) return { setting: false };
  if (setting === undefined) {
    return {
      setting: null,
      ask: 'Ask the user once: add a short issue-tracker note to CLAUDE.md and AGENTS.md so future sessions resume from the tracker? Then run "memo enable" or "memo disable".',
    };
  }
  return { setting: true, files: writeMemoFor(root, project.data) };
}

function writeMemoFor(root, data) {
  const cfg = loadConfig();
  const p = cfg.profiles[data.profile];
  if (!p) throw new ForgeError('unconfigured', `Profile "${data.profile}" not found; connect or provision first.`);
  return writeMemo(root, { provider: p.provider, baseUrl: p.baseUrl, sandbox: sameUrl(p.baseUrl, readSandboxUrl(root, data)) });
}

function readSandboxUrl(root, data) {
  if (!data.sandbox) return null;
  try {
    return getProvider(data.sandbox.provider).provision.info({ root }).baseUrl;
  } catch {
    return null;
  }
}

function cmdMemo(args) {
  const sub = args._[1] || 'status';
  const project = loadProject();
  if (!project) throw new ForgeError('unconfigured', 'This project is not linked to a tracker yet. Run "connect" or "provision" first.');
  const root = project.root;
  switch (sub) {
    case 'status':
      return { setting: project.data.memo ?? null, files: memoState(root) };
    case 'enable': {
      saveProject(root, { memo: true });
      return { setting: true, files: writeMemoFor(root, project.data) };
    }
    case 'disable': {
      saveProject(root, { memo: false });
      return { setting: false, files: removeMemo(root) };
    }
    default:
      throw usage('memo status|enable|disable');
  }
}

async function cmdConnect(args) {
  const providerId = args.provider || 'phorge';
  const baseUrl = args.baseUrl;
  const token = args.token;
  if (typeof baseUrl !== 'string' || typeof token !== 'string') {
    throw usage('connect requires --base-url URL and --token TOKEN.');
  }
  const provider = getProvider(providerId);
  const profile = { provider: providerId, baseUrl, token };
  if (typeof args.defaultProject === 'string') profile.defaultProject = args.defaultProject;

  progress(`validating credentials against ${baseUrl}`);
  const account = await provider.createClient(profile).whoami();

  let name = typeof args.profile === 'string' ? args.profile : null;
  if (!name) {
    const host = new URL(baseUrl).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    name = `${providerId}-${host}`;
  }
  saveProfile(name, profile, { makeDefault: Boolean(args.default) });

  let project = null;
  let memo = null;
  if (!args.noLink) {
    const root = findProjectRoot() || process.cwd();
    project = { root, ...saveProject(root, { profile: name }) };
    memo = applyMemo(root);
  }
  return { connected: true, profile: profileView(name, profile), account, project, memo };
}

async function cmdProvision(args) {
  const providerId = args.provider || 'phorge';
  const provider = getProvider(providerId);
  if (!provider.provision) throw unsupported(providerId, 'provision');

  const root = findProjectRoot() || process.cwd();
  const r = await provider.provision.run({
    root,
    port: args.port,
    timezone: args.timezone,
    refreshAssets: Boolean(args.refreshAssets),
    waitSeconds: args.waitSeconds,
    agentUsername: args.agentUsername,
  });

  const name = typeof args.profile === 'string' ? args.profile : r.composeProject;
  const profile = { provider: providerId, baseUrl: r.baseUrl, token: r.token };
  saveProfile(name, profile);
  const patch = { profile: name, sandbox: { provider: providerId } };
  if (r.assetsCopied) patch.assetsVersion = version();
  saveProject(root, patch);
  const memo = applyMemo(root);

  return {
    provisioned: true,
    reused: !r.fresh,
    provider: providerId,
    baseUrl: r.baseUrl,
    dir: r.dir,
    profile: profileView(name, profile),
    agentAccount: r.agent,
    adminLogin: r.admin,
    memo,
    notes: [
      'The agent account is a bot: API only, no web login.',
      'Log in to the web UI as the admin account to watch what the agent does.',
      `Credentials and ports live in ${path.join(r.dir, '.env')} (git-ignored).`,
    ],
  };
}

async function cmdSandbox(args) {
  const sub = args._[1] || 'status';
  const project = loadProject();
  const root = project?.root || process.cwd();
  const providerId = project?.data?.sandbox?.provider || args.provider || 'phorge';
  const provider = getProvider(providerId);
  if (!provider.provision) throw unsupported(providerId, 'sandbox');
  const ctx = { root };
  switch (sub) {
    case 'status':
      return provider.provision.status(ctx);
    case 'start':
      return provider.provision.start(ctx);
    case 'stop':
      return provider.provision.stop(ctx);
    case 'logs':
      return provider.provision.logs(ctx, { tail: Number(args.tail) || 100 });
    case 'destroy':
      if (!args.yes) {
        throw usage('sandbox destroy deletes all tracker data (containers + volumes). Confirm with the user, then pass --yes.');
      }
      return provider.provision.destroy(ctx);
    default:
      throw usage(`Unknown sandbox command: ${sub}`);
  }
}

function cmdProfile(args) {
  const sub = args._[1] || 'list';
  const name = args._[2];
  const cfg = loadConfig();
  switch (sub) {
    case 'list': {
      let active = null;
      try {
        active = resolveProfile(args)?.name || null;
      } catch {}
      return {
        config: configPath(),
        defaultProfile: cfg.defaultProfile || null,
        active,
        profiles: Object.entries(cfg.profiles).map(([n, p]) => profileView(n, p)),
      };
    }
    case 'show': {
      const p = name ? cfg.profiles[name] : resolveProfile(args);
      if (!p) throw new ForgeError('unconfigured', name ? `Profile not found: "${name}"` : 'No active profile.');
      return profileView(name || p.name, p);
    }
    case 'use': {
      if (!name || !cfg.profiles[name]) throw usage(`profile use: unknown profile "${name}".`);
      if (args.global) {
        cfg.defaultProfile = name;
        saveConfig(cfg);
        return { defaultProfile: name };
      }
      const root = findProjectRoot() || process.cwd();
      return { project: root, ...saveProject(root, { profile: name }) };
    }
    case 'remove':
      if (!name) throw usage('profile remove NAME');
      removeProfile(name);
      return { removed: name };
    default:
      throw usage(`Unknown profile command: ${sub}`);
  }
}

async function cmdIssue(args) {
  const sub = args._[1];
  const { provider, client } = activeClient(args);
  switch (sub) {
    case 'get': {
      if (!args._[2]) throw usage('issue get REF');
      const comments = args.comments === undefined ? 20 : Number(args.comments);
      return need(client, provider, 'issue', 'get')(args._[2], { comments });
    }
    case 'create': {
      const tags = (args.all.tag || []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
      return need(client, provider, 'issue', 'create')({
        title: typeof args.title === 'string' ? args.title : undefined,
        description: textArg(args, 'description', 'descriptionFile'),
        priority: args.priority,
        assignee: args.assignee,
        tags,
      });
    }
    case 'comment': {
      if (!args._[2]) throw usage('issue comment REF TEXT');
      return need(client, provider, 'issue', 'comment')(args._[2], textArg(args, 'body', 'bodyFile', args._.slice(3)));
    }
    case 'status':
      if (!args._[2] || !args._[3]) throw usage('issue status REF STATUS');
      return need(client, provider, 'issue', 'setStatus')(args._[2], args._[3]);
    case 'search':
      return need(client, provider, 'issue', 'search')(args._.slice(2).join(' '), {
        limit: Number(args.limit) || 20,
        status: args.status,
        assignee: args.assignee,
      });
    default:
      throw usage('issue get|create|comment|status|search');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  switch (cmd) {
    case 'help':
      return ok(HELP);
    case 'version':
      return ok({ skill: 'agent-forge', version: version(), skillDir: SKILL_ROOT, config: configPath(), node: process.versions.node, platform: process.platform });
    case 'check':
      return ok(await cmdCheck(args));
    case 'resume':
      return ok(await cmdResume(args));
    case 'memo':
      return ok(cmdMemo(args));
    case 'providers':
      return ok(listProviders());
    case 'connect':
      return ok(await cmdConnect(args));
    case 'provision':
      return ok(await cmdProvision(args));
    case 'sandbox':
      return ok(await cmdSandbox(args));
    case 'profile':
      return ok(cmdProfile(args));
    case 'whoami': {
      const { profile, client } = activeClient(args);
      return ok({ profile: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, account: await client.whoami() });
    }
    case 'issue':
      return ok(await cmdIssue(args));
    case 'wiki': {
      if (args._[1] !== 'get' || !args._[2]) throw usage('wiki get SLUG|URL');
      const { provider, client } = activeClient(args);
      return ok(await need(client, provider, 'wiki', 'get')(args._[2]));
    }
    case 'user': {
      if (args._[1] !== 'get' || !args._[2]) throw usage('user get USERNAME');
      const { provider, client } = activeClient(args);
      return ok(await need(client, provider, 'user', 'get')(args._[2]));
    }
    default:
      throw usage(`Unknown command: ${cmd}. Run "help".`);
  }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  handleError(new ForgeError('error', `Node.js >= 18 is required (found ${process.versions.node}).`));
} else {
  main().catch(handleError);
}
