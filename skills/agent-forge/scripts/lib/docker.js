// Thin helpers around the docker / docker compose CLIs.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { ForgeError } from './output.js';

export function dockerStatus() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['docker'], { encoding: 'utf8' });
  if (which.status !== 0) return { installed: false, running: false, compose: false };
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000 });
  const compose = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', timeout: 15000 });
  return {
    installed: true,
    running: info.status === 0,
    serverVersion: info.status === 0 ? info.stdout.trim() : null,
    compose: compose.status === 0,
    composeVersion: compose.status === 0 ? compose.stdout.trim() : null,
  };
}

export function requireDocker() {
  const s = dockerStatus();
  if (!s.installed) throw new ForgeError('unconfigured', 'Docker is not installed. Install Docker Desktop or Docker Engine first.');
  if (!s.running) throw new ForgeError('unconfigured', 'Docker is installed but the daemon is not running. Start Docker and retry.');
  if (!s.compose) throw new ForgeError('unconfigured', 'The "docker compose" plugin is not available.');
  return s;
}

// Run `docker compose <args>` in `cwd`. Returns { status, stdout, stderr }.
export function compose(cwd, args, { input, timeout = 60000 } = {}) {
  const r = spawnSync('docker', ['compose', ...args], { cwd, encoding: 'utf8', input, timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Long-running compose command; output is appended to logFile so it does not
// flood the agent's context. Resolves with the exit code.
export function composeLogged(cwd, args, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n$ docker compose ${args.join(' ')}\n`);
    const child = spawn('docker', ['compose', ...args], { cwd, stdio: ['ignore', out, out] });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve(code);
    });
  });
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

export async function findFreePort(start = 8080, tries = 50) {
  for (let p = start; p < start + tries; p++) {
    if (await portFree(p)) return p;
  }
  throw new ForgeError('error', `No free TCP port found in ${start}-${start + tries - 1}.`);
}
