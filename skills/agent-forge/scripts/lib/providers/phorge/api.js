// Phorge / Phabricator Conduit API client, mapped onto the agent-forge
// operation set (see references/providers.md for the normalized shapes).

import { ForgeError } from '../../output.js';

export function createClient({ baseUrl, token }) {
  if (!baseUrl) throw new ForgeError('unconfigured', 'phorge: baseUrl is missing from the profile.');
  if (!token) throw new ForgeError('unconfigured', 'phorge: token is missing from the profile.');
  const root = baseUrl.replace(/\/+$/, '');

  async function conduit(method, params = {}) {
    const body = new URLSearchParams({ 'api.token': token });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body.append(k, String(v));
    }
    const url = `${root}/api/${method}`;
    let res;
    try {
      res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new ForgeError('unreachable', `phorge [${method}]: cannot reach ${url} (${err.cause?.code || err.message})`);
    }
    if (!res.ok) throw new ForgeError('unreachable', `phorge [${method}]: HTTP ${res.status} ${res.statusText} (${url})`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new ForgeError('unreachable', `phorge [${method}]: response is not JSON — is ${root} a Phorge/Phabricator instance?`);
    }
    if (json.error_code) {
      const code = /token|session|auth/i.test(json.error_code + json.error_info) ? 'auth_failed' : 'error';
      throw new ForgeError(code, `phorge [${method}]: ${json.error_info} (${json.error_code})`);
    }
    return json.result;
  }

  // Flatten [{type, value}] into Conduit's transactions[i][type]/[value] form.
  function txParams(transactions, extra = {}) {
    const p = { ...extra };
    transactions.forEach((tx, i) => {
      p[`transactions[${i}][type]`] = tx.type;
      if (Array.isArray(tx.value)) tx.value.forEach((v, j) => (p[`transactions[${i}][value][${j}]`] = v));
      else p[`transactions[${i}][value]`] = tx.value;
    });
    return p;
  }

  function parseRef(ref) {
    const m = String(ref).match(/(?:^|\/|\b)T?(\d+)\/?$/i);
    if (!m) throw new ForgeError('usage', `phorge: cannot parse task reference "${ref}" (expected T123, 123 or a task URL).`);
    return Number(m[1]);
  }

  let statusCache;
  async function statusInfo() {
    if (!statusCache) {
      try {
        const r = await conduit('maniphest.querystatuses');
        statusCache = { open: new Set(r.openStatuses || ['open']), defaultClosed: r.defaultClosedStatus || 'resolved' };
      } catch {
        statusCache = { open: new Set(['open']), defaultClosed: 'resolved' };
      }
    }
    return statusCache;
  }

  const userCache = new Map();
  async function usernames(phids) {
    const missing = [...new Set(phids.filter((p) => p && !userCache.has(p)))];
    if (missing.length) {
      const params = {};
      missing.forEach((p, i) => (params[`constraints[phids][${i}]`] = p));
      const r = await conduit('user.search', params);
      for (const u of r.data) userCache.set(u.phid, u.fields.username);
    }
    return (phid) => (phid ? userCache.get(phid) || phid : null);
  }

  async function userPhid(username) {
    const r = await conduit('user.search', { 'constraints[usernames][0]': username });
    if (!r.data[0]) throw new ForgeError('error', `phorge: user not found: ${username}`);
    return r.data[0].phid;
  }

  async function projectPhid(tag) {
    const slug = tag.toLowerCase().replace(/^#/, '').replace(/\s+/g, '_');
    const r = await conduit('project.search', { 'constraints[slugs][0]': slug });
    if (!r.data[0]) throw new ForgeError('error', `phorge: project/tag not found: ${tag}`);
    return r.data[0].phid;
  }

  function iso(ts) {
    return ts ? new Date(ts * 1000).toISOString() : null;
  }

  async function normalizeTask(t, name) {
    const st = await statusInfo();
    const native = t.fields.status?.value;
    return {
      ref: `T${t.id}`,
      id: t.id,
      url: `${root}/T${t.id}`,
      title: t.fields.name,
      description: t.fields.description?.raw ?? '',
      status: native && st.open.has(native) ? 'open' : 'closed',
      nativeStatus: native,
      priority: t.fields.priority?.name ?? null,
      author: name(t.fields.authorPHID),
      assignee: name(t.fields.ownerPHID),
      createdAt: iso(t.fields.dateCreated),
      updatedAt: iso(t.fields.dateModified),
    };
  }

  // ── Operations ───────────────────────────────────────────────

  async function whoami() {
    const u = await conduit('user.whoami');
    return { username: u.userName, realName: u.realName, id: u.phid, url: u.uri, roles: u.roles };
  }

  async function getIssue(ref, { comments = 20 } = {}) {
    const id = parseRef(ref);
    const r = await conduit('maniphest.search', { 'constraints[ids][0]': id });
    const t = r.data[0];
    if (!t) throw new ForgeError('error', `phorge: task T${id} not found.`);

    let commentList = [];
    if (comments > 0) {
      const tx = await conduit('transaction.search', { objectIdentifier: t.phid, limit: 100 });
      commentList = tx.data
        .filter((x) => x.type === 'comment' && x.comments?.length)
        .slice(0, comments)
        .reverse();
    }
    const name = await usernames([t.fields.authorPHID, t.fields.ownerPHID, ...commentList.map((c) => c.authorPHID)]);
    const issue = await normalizeTask(t, name);
    issue.comments = commentList.map((c) => ({
      author: name(c.authorPHID),
      createdAt: iso(c.dateCreated),
      body: c.comments[0]?.content?.raw ?? '',
    }));
    return issue;
  }

  async function createIssue({ title, description, priority, assignee, tags = [] }) {
    if (!title) throw new ForgeError('usage', 'issue create: --title is required.');
    const txs = [{ type: 'title', value: title }];
    if (description) txs.push({ type: 'description', value: description });
    if (priority) txs.push({ type: 'priority', value: priority });
    if (assignee) txs.push({ type: 'owner', value: await userPhid(assignee) });
    if (tags.length) txs.push({ type: 'projects.add', value: await Promise.all(tags.map(projectPhid)) });
    const r = await conduit('maniphest.edit', txParams(txs));
    const id = r.object.id;
    return { ref: `T${id}`, id, url: `${root}/T${id}` };
  }

  async function comment(ref, text) {
    if (!text) throw new ForgeError('usage', 'issue comment: comment text is required.');
    const id = parseRef(ref);
    await conduit('maniphest.edit', txParams([{ type: 'comment', value: text }], { objectIdentifier: `T${id}` }));
    return { ref: `T${id}`, url: `${root}/T${id}`, commented: true };
  }

  async function setStatus(ref, status) {
    if (!status) throw new ForgeError('usage', 'issue status: a status is required (open, closed, or a native status).');
    const id = parseRef(ref);
    const st = await statusInfo();
    const native = status === 'closed' ? st.defaultClosed : status;
    await conduit('maniphest.edit', txParams([{ type: 'status', value: native }], { objectIdentifier: `T${id}` }));
    return { ref: `T${id}`, url: `${root}/T${id}`, nativeStatus: native, status: st.open.has(native) ? 'open' : 'closed' };
  }

  async function search(query, { limit = 20, status, assignee } = {}) {
    const params = { limit, order: 'updated' };
    if (query) params['constraints[query]'] = query;
    if (assignee) params['constraints[assigned][0]'] = assignee;
    if (status === 'open' || status === 'closed') {
      const st = await statusInfo();
      if (status === 'open') [...st.open].forEach((s, i) => (params[`constraints[statuses][${i}]`] = s));
    } else if (status) {
      params['constraints[statuses][0]'] = status;
    }
    const r = await conduit('maniphest.search', params);
    const name = await usernames(r.data.flatMap((t) => [t.fields.authorPHID, t.fields.ownerPHID]));
    let items = await Promise.all(r.data.map((t) => normalizeTask(t, name)));
    if (status === 'closed') items = items.filter((i) => i.status === 'closed');
    for (const i of items) delete i.description;
    return { count: items.length, items };
  }

  async function getWiki(slugOrUrl) {
    let slug = String(slugOrUrl);
    const m = slug.match(/\/w\/(.*)$/);
    if (m) slug = m[1];
    slug = '/' + slug.replace(/^\/+|\/+$/g, '') + '/';
    if (slug === '//') slug = '/';
    const r = await conduit('phriction.document.search', { 'constraints[paths][0]': slug, 'attachments[content]': 1 });
    const d = r.data[0];
    if (!d) throw new ForgeError('error', `phorge: wiki page not found: ${slug}`);
    return {
      path: d.fields.path,
      url: `${root}/w/${d.fields.path === '/' ? '' : d.fields.path}`,
      title: d.attachments?.content?.title ?? d.fields.path,
      body: d.attachments?.content?.content?.raw ?? '',
      updatedAt: iso(d.fields.dateModified),
    };
  }

  async function getUser(username) {
    const r = await conduit('user.search', { 'constraints[usernames][0]': username });
    const u = r.data[0];
    if (!u) throw new ForgeError('error', `phorge: user not found: ${username}`);
    return { username: u.fields.username, realName: u.fields.realName, id: u.phid, roles: u.fields.roles, url: `${root}/p/${u.fields.username}/` };
  }

  return {
    baseUrl: root,
    whoami,
    issue: { get: getIssue, create: createIssue, comment, setStatus, search },
    wiki: { get: getWiki },
    user: { get: getUser },
  };
}
