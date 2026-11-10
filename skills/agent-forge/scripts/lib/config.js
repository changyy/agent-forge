// Configuration model
//
// Global profiles (shared by every project and by every agent CLI):
//   $AGENT_FORGE_CONFIG  or  $XDG_CONFIG_HOME/agent-forge/config.json
//   or  ~/.config/agent-forge/config.json
//
//   {
//     "defaultProfile": "work",
//     "profiles": {
//       "work":  { "provider": "phorge", "baseUrl": "https://phorge.example.com", "token": "api-..." },
//       "local": { "provider": "phorge", "baseUrl": "http://127.0.0.1:8081/",   "token": "api-..." }
//     }
//   }
//
// Project link (which profile this project uses, and its local sandbox if any):
//   <project>/agent-forge/project.json
//   { "profile": "local", "sandbox": { "provider": "phorge" } }
//
// Profile resolution order:
//   1. --profile NAME
//   2. $AGENT_FORGE_PROFILE
//   3. nearest <dir>/agent-forge/project.json walking up from the cwd
//   4. config.defaultProfile
//   5. the only profile, if exactly one exists
// $AGENT_FORGE_BASE_URL / $AGENT_FORGE_TOKEN / $AGENT_FORGE_PROVIDER override
// the resolved profile's fields (and can stand in for a profile entirely).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from './output.js';

export const PROJECT_DIR_NAME = 'agent-forge';
export const PROJECT_FILE = 'project.json';

export function configPath() {
  if (process.env.AGENT_FORGE_CONFIG) return process.env.AGENT_FORGE_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'agent-forge', 'config.json');
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { profiles: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.profiles ||= {};
    return data;
  } catch (err) {
    throw new ForgeError('error', `Cannot parse ${file}: ${err.message}`);
  }
}

export function saveConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function saveProfile(name, profile, { makeDefault = false } = {}) {
  const cfg = loadConfig();
  cfg.profiles[name] = profile;
  if (makeDefault || !cfg.defaultProfile) cfg.defaultProfile = name;
  saveConfig(cfg);
  return cfg;
}

export function removeProfile(name) {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) throw new ForgeError('error', `Profile not found: "${name}"`);
  delete cfg.profiles[name];
  if (cfg.defaultProfile === name) delete cfg.defaultProfile;
  saveConfig(cfg);
}

// ── Project link ────────────────────────────────────────────────

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_DIR_NAME, PROJECT_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectDir(root = process.cwd()) {
  return path.join(root, PROJECT_DIR_NAME);
}

export function loadProject(root = findProjectRoot()) {
  if (!root) return null;
  const file = path.join(projectDir(root), PROJECT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return { root, file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    throw new ForgeError('error', `Cannot parse ${file}: ${err.message}`);
  }
}

export function saveProject(root, patch) {
  const dir = projectDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PROJECT_FILE);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  ensureProjectGitignore(root);
  return next;
}

// Keep secrets and bulky state out of the user's repo by default.
export function ensureProjectGitignore(root) {
  const file = path.join(projectDir(root), '.gitignore');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, ['.env', 'backups/', '*.log', ''].join('\n'));
}

// ── Resolution ──────────────────────────────────────────────────

export function resolveProfile(args = {}) {
  const cfg = loadConfig();
  const project = loadProject();
  let name = null;
  let source = null;

  if (typeof args.profile === 'string') {
    name = args.profile;
    source = '--profile';
  } else if (process.env.AGENT_FORGE_PROFILE) {
    name = process.env.AGENT_FORGE_PROFILE;
    source = 'AGENT_FORGE_PROFILE';
  } else if (project?.data?.profile) {
    name = project.data.profile;
    source = path.relative(process.cwd(), project.file) || project.file;
  } else if (cfg.defaultProfile) {
    name = cfg.defaultProfile;
    source = 'defaultProfile';
  } else {
    const names = Object.keys(cfg.profiles);
    if (names.length === 1) {
      name = names[0];
      source = 'only profile';
    }
  }

  const envBase = process.env.AGENT_FORGE_BASE_URL;
  const envToken = process.env.AGENT_FORGE_TOKEN;
  const envProvider = process.env.AGENT_FORGE_PROVIDER;

  let profile = name ? cfg.profiles[name] : null;
  if (name && !profile && !(envBase && envToken)) {
    throw new ForgeError('unconfigured', `Profile not found: "${name}" (from ${source}).`, {
      knownProfiles: Object.keys(cfg.profiles),
    });
  }
  if (!profile && envBase && envToken) {
    name = name || '(env)';
    source = source || 'environment';
    profile = {};
  }
  if (!profile) return null;

  return {
    name,
    source,
    provider: envProvider || profile.provider || 'phorge',
    baseUrl: envBase || profile.baseUrl,
    token: envToken || profile.token,
    defaultProject: profile.defaultProject,
  };
}

export function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
