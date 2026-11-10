#!/usr/bin/env node
// Stamp a new version in the 1.YYYYmmdd.1HHmmss format (local time).
//
// The leading "1" on the patch part keeps it a valid semver number even when
// the hour is 00-09 (semver forbids leading zeros).
//
// Writes the same value to:
//   package.json                      (npm / npx)
//   skills/agent-forge/VERSION        (read by the skill at runtime)
//
// Usage: node tools/bump-version.js [--print]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pad(n) {
  return String(n).padStart(2, '0');
}

export function makeVersion(d = new Date()) {
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `1.${ymd}.1${hms}`;
}

const version = makeVersion();

if (process.argv.includes('--print')) {
  console.log(version);
  process.exit(0);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

fs.writeFileSync(path.join(ROOT, 'skills', 'agent-forge', 'VERSION'), version + '\n');

console.log(version);
