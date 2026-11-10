#!/usr/bin/env node
// Offline smoke test: installer (local + global, both CLIs) and the runtime
// CLI's non-network commands. Runs entirely inside a temp HOME.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'agent-forge.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-test-'));
const home = path.join(tmp, 'home');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(home);
fs.mkdirSync(proj);
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
delete env.CODEX_HOME;
delete env.AGENT_FORGE_PROFILE;
delete env.AGENT_FORGE_BASE_URL;
delete env.AGENT_FORGE_TOKEN;

function run(file, args, { expect = 0 } = {}) {
  const r = spawnSync(process.execPath, [file, ...args], { cwd: proj, env, encoding: 'utf8' });
  assert.equal(r.status, expect, `${path.basename(file)} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r;
}

// stderr may hold [agent-forge] progress lines before the JSON error document.
function errJson(r) {
  return JSON.parse(r.stderr.slice(r.stderr.search(/^\{/m)));
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

try {
  test('version matches package.json and VERSION file', () => {
    assert.equal(run(BIN, ['version']).stdout.trim(), VERSION);
    assert.equal(fs.readFileSync(path.join(ROOT, 'skills/agent-forge/VERSION'), 'utf8').trim(), VERSION);
    assert.match(VERSION, /^1\.\d{8}\.1\d{6}$/);
  });

  const localClaude = path.join(proj, '.claude/skills/agent-forge');
  const localCodex = path.join(proj, '.agents/skills/agent-forge');

  test('install --all defaults to local and renders placeholders', () => {
    run(BIN, ['install', '--all']);
    for (const dir of [localClaude, localCodex]) {
      const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      assert.ok(!md.includes('{{'), 'placeholders left in SKILL.md');
      assert.ok(md.includes(`node ${path.relative(proj, dir)}/scripts/forge.js`));
      assert.ok(md.includes(VERSION));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.install.json'), 'utf8')).scope, 'local');
    }
  });

  test('install again overwrites (update)', () => {
    fs.writeFileSync(path.join(localClaude, 'stale.txt'), 'x');
    const out = run(BIN, ['install', '--claude']).stdout;
    assert.match(out, /reinstalled/);
    assert.ok(!fs.existsSync(path.join(localClaude, 'stale.txt')));
  });

  test('install refuses to clobber a foreign directory without --force', () => {
    const foreign = path.join(proj, '.agents/skills/agent-forge');
    fs.rmSync(foreign, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: something-else\n---\n');
    run(BIN, ['install', '--codex'], { expect: 1 });
    run(BIN, ['install', '--codex', '--force']);
  });

  test('install --global uses absolute paths under HOME', () => {
    run(BIN, ['install', '--global', '--all']);
    const dir = path.join(home, '.claude/skills/agent-forge');
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(md.includes(`node ${dir}/scripts/forge.js`));
    assert.ok(fs.existsSync(path.join(home, '.agents/skills/agent-forge/SKILL.md')));
  });

  test('status lists both scopes', () => {
    const out = run(BIN, ['status']).stdout;
    assert.equal(out.match(new RegExp(VERSION.replace(/\./g, '\\.'), 'g')).length >= 4, true);
  });

  const FORGE = path.join(localClaude, 'scripts/forge.js');

  test('forge check reports unconfigured with no profile', () => {
    const j = JSON.parse(run(FORGE, ['check']).stdout);
    assert.equal(j.status, 'unconfigured');
    assert.equal(j.skillVersion, VERSION);
    assert.ok(j.providers.some((p) => p.id === 'phorge' && p.capabilities.provision));
  });

  test('issue commands fail with exit 4 when unconfigured', () => {
    const r = run(FORGE, ['issue', 'search', 'x'], { expect: 4 });
    assert.equal(errJson(r).error.code, 'unconfigured');
  });

  test('connect to an unreachable URL reports unreachable', () => {
    const r = run(FORGE, ['connect', '--base-url', 'http://127.0.0.1:9/', '--token', 'api-x'], { expect: 1 });
    assert.equal(errJson(r).error.code, 'unreachable');
  });

  test('profile resolution via project.json', () => {
    const cfgFile = path.join(home, '.config/agent-forge/config.json');
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({ profiles: { a: { provider: 'phorge', baseUrl: 'http://a.example', token: 'api-aaaaaaaaaa' }, b: { provider: 'phorge', baseUrl: 'http://b.example', token: 'api-bbbbbbbbbb' } }, defaultProfile: 'a' }));
    let j = JSON.parse(run(FORGE, ['profile', 'list']).stdout);
    assert.equal(j.active, 'a');
    run(FORGE, ['profile', 'use', 'b']);
    j = JSON.parse(run(FORGE, ['profile', 'list']).stdout);
    assert.equal(j.active, 'b');
    assert.ok(fs.existsSync(path.join(proj, 'agent-forge/.gitignore')));
    assert.ok(!JSON.stringify(j).includes('api-bbbbbbbbbb'), 'token must be masked');
  });

  test('memo enable writes a marked block, keeps user content, is idempotent', () => {
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My project\n\nHouse rules.\n');
    let j = JSON.parse(run(FORGE, ['memo', 'enable']).stdout);
    assert.deepEqual(j.files, { 'CLAUDE.md': 'updated', 'AGENTS.md': 'created' });
    const claude = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# My project\n\nHouse rules.\n\n<!-- agent-forge:begin -->'));
    assert.ok(claude.includes('http://b.example'));
    j = JSON.parse(run(FORGE, ['memo', 'enable']).stdout);
    assert.deepEqual(j.files, { 'CLAUDE.md': 'unchanged', 'AGENTS.md': 'unchanged' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(proj, 'agent-forge/project.json'), 'utf8')).memo, true);
  });

  test('connect-style refresh rewrites the block in place when the URL changes', () => {
    run(FORGE, ['profile', 'use', 'a']);
    run(FORGE, ['memo', 'enable']);
    const claude = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.includes('http://a.example') && !claude.includes('http://b.example'));
    assert.equal(claude.match(/agent-forge:begin/g).length, 1);
  });

  test('memo disable removes the block and remembers the choice', () => {
    const j = JSON.parse(run(FORGE, ['memo', 'disable']).stdout);
    assert.deepEqual(j.files, { 'CLAUDE.md': 'removed', 'AGENTS.md': 'deleted' });
    assert.equal(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8'), '# My project\n\nHouse rules.\n');
    assert.ok(!fs.existsSync(path.join(proj, 'AGENTS.md')));
    assert.equal(JSON.parse(run(FORGE, ['memo', 'status']).stdout).setting, false);
  });

  test('check reports profile_missing for a project linked to an unknown profile', () => {
    const pj = path.join(proj, 'agent-forge/project.json');
    const data = JSON.parse(fs.readFileSync(pj, 'utf8'));
    fs.writeFileSync(pj, JSON.stringify({ ...data, profile: 'from-another-machine' }));
    const j = JSON.parse(run(FORGE, ['check']).stdout);
    assert.equal(j.status, 'profile_missing');
    assert.match(j.next, /connect/);
    const r = JSON.parse(run(FORGE, ['resume']).stdout);
    assert.equal(r.status, 'profile_missing');
  });

  test('uninstall removes local copies only', () => {
    run(BIN, ['uninstall']);
    assert.ok(!fs.existsSync(localClaude));
    assert.ok(fs.existsSync(path.join(home, '.claude/skills/agent-forge')));
  });

  console.log(`\n${passed} passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
