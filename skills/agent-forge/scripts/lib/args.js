// Minimal argv parser.
//   positional words       -> args._
//   --key value / --key=v  -> args.key = 'v'   (repeatable: last one wins, all kept in args.all.key)
//   --flag                 -> args.flag = true (when followed by another --option or nothing)
//   --                     -> everything after is positional
//
// Keys are camelCased: --base-url -> baseUrl.

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'force', 'refreshAssets', 'noLink', 'default', 'global', 'help']);

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const args = { _: [], all: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      key = camel(key);
      if (value === undefined) {
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      args[key] = value;
      (args.all[key] ||= []).push(value);
    } else {
      args._.push(a);
    }
  }
  return args;
}
