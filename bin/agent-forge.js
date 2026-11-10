#!/usr/bin/env node
// agent-forge installer.
//
//   npx github:changyy/agent-forge install            # current project (default: --local)
//   npx github:changyy/agent-forge install --global   # user-wide
//   npx github:changyy/agent-forge uninstall [--local|--global]
//   npx github:changyy/agent-forge status
//
// `install` always overwrites the installed copy, so it doubles as `update`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'agent-forge';
const SKILL_SRC = path.join(PKG_ROOT, 'skills', SKILL_NAME);
const MARKER = '.install.json';
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

// Where each agent looks for skills.
//   Claude Code: ./.claude/skills, ~/.claude/skills
//   Codex CLI:   ./.agents/skills, ~/.agents/skills
const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    home: () => path.join(os.homedir(), '.claude'),
    local: (cwd) => path.join(cwd, '.claude', 'skills'),
    global: () => path.join(os.homedir(), '.claude', 'skills'),
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    home: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    local: (cwd) => path.join(cwd, '.agents', 'skills'),
    global: () => path.join(os.homedir(), '.agents', 'skills'),
  },
};

const HELP = `agent-forge ${VERSION}

Usage:
  npx github:changyy/agent-forge <command> [options]

Commands:
  install      Install (or overwrite / update) the skill. Default command.
  uninstall    Remove the installed skill.
  status       Show where the skill is installed and which version.
  version      Print the package version.
  help         Show this help.

Options:
  --local      Install into the current directory (default).
               Claude Code: ./.claude/skills/agent-forge
               Codex CLI:   ./.agents/skills/agent-forge
  --global     Install into your home directory.
               Claude Code: ~/.claude/skills/agent-forge
               Codex CLI:   ~/.agents/skills/agent-forge
  --claude     Target Claude Code only.
  --codex      Target Codex CLI only.
  --all        Target both, even if a CLI is not detected.
  --force      Overwrite a target directory that was not created by agent-forge.

Without --claude/--codex/--all, every detected CLI is targeted.
`;

function parseArgs(argv) {
  const opts = { command: 'install', scope: 'local', agents: [], all: false, force: false };
  let commandSeen = false;
  for (const a of argv) {
    if (a === '--local') opts.scope = 'local';
    else if (a === '--global') opts.scope = 'global';
    else if (a === '--claude') opts.agents.push('claude');
    else if (a === '--codex') opts.agents.push('codex');
    else if (a === '--all') opts.all = true;
    else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') opts.command = 'help';
    else if (a === '-v' || a === '--version') opts.command = 'version';
    else if (!a.startsWith('-') && !commandSeen) {
      opts.command = a;
      commandSeen = true;
    } else {
      fail(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`agent-forge: ${msg}\n`);
  process.exit(1);
}

function onPath(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detected(id) {
  const a = AGENTS[id];
  return onPath(a.bin) || fs.existsSync(a.home());
}

function resolveAgents(opts) {
  if (opts.all) return Object.keys(AGENTS);
  if (opts.agents.length) return [...new Set(opts.agents)];
  const found = Object.keys(AGENTS).filter(detected);
  if (!found.length) {
    fail('Neither Claude Code nor Codex CLI was detected. Pass --claude, --codex or --all.');
  }
  return found;
}

function targetDir(id, scope, cwd) {
  const base = scope === 'global' ? AGENTS[id].global() : AGENTS[id].local(cwd);
  return path.join(base, SKILL_NAME);
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function isOurs(dir) {
  if (readMarker(dir)) return true;
  try {
    const head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 300);
    return /^name:\s*agent-forge\s*$/m.test(head);
  } catch {
    return false;
  }
}

// SKILL.md uses {{SKILL_DIR}} so the same file works for both CLIs (neither
// substitutes a skill-path variable that the other understands). Local installs
// get a project-relative path so the directory can be committed and shared.
function renderSkillMd(dir, scope, cwd) {
  const file = path.join(dir, 'SKILL.md');
  const skillDir = scope === 'global' ? dir : path.relative(cwd, dir).split(path.sep).join('/');
  const text = fs
    .readFileSync(file, 'utf8')
    .replaceAll('{{SKILL_DIR}}', skillDir)
    .replaceAll('{{VERSION}}', VERSION);
  fs.writeFileSync(file, text);
}

function install(opts) {
  const cwd = process.cwd();
  const agents = resolveAgents(opts);
  for (const id of agents) {
    const dir = targetDir(id, opts.scope, cwd);
    const existed = fs.existsSync(dir);
    if (existed && !isOurs(dir) && !opts.force) {
      fail(`${dir} exists and was not installed by agent-forge. Re-run with --force to overwrite it.`);
    }
    const previous = existed ? readMarker(dir)?.version : null;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(SKILL_SRC, dir, { recursive: true });
    renderSkillMd(dir, opts.scope, cwd);
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify(
        { name: SKILL_NAME, version: VERSION, agent: id, scope: opts.scope, installedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
    );
    const action = !existed ? 'installed' : previous && previous !== VERSION ? `updated from ${previous}` : 'reinstalled';
    console.log(`${AGENTS[id].label.padEnd(12)} ${action} ${VERSION} -> ${dir}`);
  }
  console.log('');
  console.log('Next: start (or restart) your agent here and ask it, e.g.');
  console.log('  "Check whether the issue tracker is configured."');
}

function uninstall(opts) {
  const cwd = process.cwd();
  const agents = opts.agents.length || opts.all ? resolveAgents(opts) : Object.keys(AGENTS);
  let removed = 0;
  for (const id of agents) {
    const dir = targetDir(id, opts.scope, cwd);
    if (!fs.existsSync(dir)) continue;
    if (!isOurs(dir) && !opts.force) {
      fail(`${dir} was not installed by agent-forge. Re-run with --force to remove it.`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`${AGENTS[id].label.padEnd(12)} removed ${dir}`);
    removed++;
  }
  if (!removed) console.log(`Nothing to remove (${opts.scope}).`);
}

function status() {
  const cwd = process.cwd();
  console.log(`agent-forge package ${VERSION}\n`);
  for (const id of Object.keys(AGENTS)) {
    for (const scope of ['local', 'global']) {
      const dir = targetDir(id, scope, cwd);
      const m = fs.existsSync(dir) ? readMarker(dir) : null;
      const state = !fs.existsSync(dir) ? '-' : m ? m.version : 'present (unknown version)';
      console.log(`${AGENTS[id].label.padEnd(12)} ${scope.padEnd(7)} ${state.padEnd(22)} ${dir}`);
    }
  }
}

const opts = parseArgs(process.argv.slice(2));
switch (opts.command) {
  case 'install':
  case 'update':
    install(opts);
    break;
  case 'uninstall':
  case 'remove':
    uninstall(opts);
    break;
  case 'status':
    status();
    break;
  case 'version':
    console.log(VERSION);
    break;
  case 'help':
    console.log(HELP);
    break;
  default:
    fail(`Unknown command: ${opts.command}\n\n${HELP}`);
}
