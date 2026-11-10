// Project memo: a short marked block in CLAUDE.md (Claude Code) and AGENTS.md
// (Codex CLI and others) telling any new agent session that this project has
// an issue tracker and how to resume work.
//
// The user is asked once (the agent does the asking); the answer is stored in
// agent-forge/project.json as "memo": true | false and reused afterwards.

import fs from 'node:fs';
import path from 'node:path';

export const MEMO_FILES = ['CLAUDE.md', 'AGENTS.md'];
const BEGIN = '<!-- agent-forge:begin -->';
const END = '<!-- agent-forge:end -->';
const BLOCK_RE = new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n*`, 'm');

export function renderMemo({ provider, baseUrl, sandbox }) {
  const lines = [
    BEGIN,
    '## Issue tracker',
    '',
    `Work in this project is tracked in ${provider === 'phorge' ? 'Phorge' : provider} at ${baseUrl}, through the`,
    '**agent-forge** skill (installed under `.claude/skills/` or `.agents/skills/`).',
    '',
    '- At the start of every session, run the agent-forge `resume` command to see the tracker status',
    '  and the open issues, then continue from there.',
    '- Before you start a piece of work, make sure it has an issue (create one if needed).',
    '- Post progress and decisions as comments on that issue.',
    '- When the work is done, close the issue with a short summary comment.',
  ];
  if (sandbox) {
    lines.push('- The tracker runs locally in Docker (`./agent-forge/`). If it is down, the `resume` output says how to start it.');
  }
  lines.push(END);
  return lines.join('\n');
}

function upsert(file, block) {
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  let next;
  if (BLOCK_RE.test(text)) {
    next = text.replace(BLOCK_RE, (m) => {
      const lead = m.match(/^\n*/)[0];
      const trail = m.match(/\n*$/)[0];
      return `${lead}${block}${trail || '\n'}`;
    });
  } else if (text.trim()) {
    next = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    next = `${block}\n`;
  }
  if (next === text) return 'unchanged';
  fs.writeFileSync(file, next);
  return exists ? 'updated' : 'created';
}

function strip(file) {
  if (!fs.existsSync(file)) return 'absent';
  const text = fs.readFileSync(file, 'utf8');
  if (!BLOCK_RE.test(text)) return 'absent';
  const next = text.replace(BLOCK_RE, '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  if (!next.trim()) {
    fs.rmSync(file);
    return 'deleted';
  }
  fs.writeFileSync(file, next.endsWith('\n') ? next : next + '\n');
  return 'removed';
}

export function writeMemo(root, info) {
  const block = renderMemo(info);
  const files = {};
  for (const f of MEMO_FILES) files[f] = upsert(path.join(root, f), block);
  return files;
}

export function removeMemo(root) {
  const files = {};
  for (const f of MEMO_FILES) files[f] = strip(path.join(root, f));
  return files;
}

export function memoState(root) {
  const files = {};
  for (const f of MEMO_FILES) {
    const p = path.join(root, f);
    files[f] = fs.existsSync(p) && BLOCK_RE.test(fs.readFileSync(p, 'utf8'));
  }
  return files;
}
