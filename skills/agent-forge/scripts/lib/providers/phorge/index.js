import { createClient } from './api.js';
import * as provision from './provision.js';

export default {
  id: 'phorge',
  displayName: 'Phorge / Phabricator',
  capabilities: { wiki: true },
  createClient,
  provision,
};
