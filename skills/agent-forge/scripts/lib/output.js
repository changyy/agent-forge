// All commands print one JSON document on stdout (success) or stderr (error),
// so agents can parse results without guessing at formats. Progress messages
// go to stderr as plain text.

export class ForgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// Exit codes
//   0 ok
//   1 generic error
//   2 usage error
//   3 operation not supported by this provider
//   4 not configured (no profile / no sandbox)
const EXIT = { usage: 2, unsupported: 3, unconfigured: 4 };

export function ok(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function progress(msg) {
  process.stderr.write(`[agent-forge] ${msg}\n`);
}

export function handleError(err) {
  const code = err instanceof ForgeError ? err.code : 'error';
  const body = { error: { code, message: err.message, ...(err.extra || {}) } };
  process.stderr.write(JSON.stringify(body, null, 2) + '\n');
  process.exit(EXIT[code] || 1);
}

export function usage(message) {
  return new ForgeError('usage', message);
}

export function unsupported(provider, operation) {
  return new ForgeError('unsupported', `Provider "${provider}" does not support "${operation}".`, {
    provider,
    operation,
  });
}
