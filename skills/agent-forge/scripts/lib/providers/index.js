// Provider registry.
//
// A provider is a module whose default export looks like:
//
//   {
//     id: 'phorge',
//     displayName: 'Phorge / Phabricator',
//     capabilities: { provision: true, wiki: true },
//     // Required. Returns an object implementing the operations below.
//     // Unimplemented operations should be left out; the CLI reports them
//     // as "unsupported" with exit code 3.
//     createClient({ baseUrl, token, defaultProject }) => ({
//       whoami(),
//       issue: { get(ref, opts), create(fields), comment(ref, text),
//                setStatus(ref, status), search(query, opts) },
//       wiki:  { get(slug) },
//       user:  { get(username) },
//     }),
//     // Optional. Present only when the provider can run locally in Docker.
//     provision: { run(opts), info(ctx), status(ctx), start(ctx), stop(ctx), logs(ctx, opts), destroy(ctx) },
//   }
//
// See references/providers.md for the full contract and the normalized
// data shapes.

import phorge from './phorge/index.js';
import { ForgeError } from '../output.js';

const PROVIDERS = [phorge];

export function listProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    capabilities: { api: true, provision: Boolean(p.provision), ...p.capabilities },
  }));
}

export function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) {
    throw new ForgeError('usage', `Unknown provider: "${id}"`, {
      knownProviders: PROVIDERS.map((x) => x.id),
    });
  }
  return p;
}
