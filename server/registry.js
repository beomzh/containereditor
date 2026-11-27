// Reads image:tag existence and config from a container registry (Registry HTTP API v2).

import { parseImageRef } from '../public/core/imageref.js';
import { logger } from './log.js';

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const TIMEOUT_MS = 10_000;
const CACHE_MS = 10 * 60_000;
const cache = new Map();

const log = logger('REGISTRY');

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

export function createChecker(fetchImpl = fetch) {
  const request = (url, options = {}) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });

  // On 401, fetch an anonymous bearer token and retry once.
  async function authed(url, options, session) {
    const headers = { ...options.headers, ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) };
    const res = await request(url, { ...options, headers });
    if (res.status !== 401 || session.token) return res;
    const challenge = res.headers.get('www-authenticate') ?? '';
    if (!/^Bearer /i.test(challenge)) return res;
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!params.realm?.startsWith('https://')) return res;
    const tokenUrl = new URL(params.realm);
    for (const key of ['service', 'scope']) if (params[key]) tokenUrl.searchParams.set(key, params[key]);
    const tokenRes = await request(tokenUrl, {});
    if (!tokenRes.ok) return res;
    const body = await tokenRes.json();
    session.token = body.token ?? body.access_token;
    if (!session.token) return res;
    return authed(url, options, session);
  }

  async function suggestTags(repository, tag) {
    try {
      const stem = tag.split(/[-.]/)[0];
      const url = new URL(`https://hub.docker.com/v2/repositories/${repository}/tags`);
      url.searchParams.set('page_size', '100');
      url.searchParams.set('name', stem);
      const res = await request(url, {});
      if (!res.ok) return [];
      const names = ((await res.json()).results ?? []).map((r) => r.name);
      // Tags starting with the same version first, then by closeness to the input
      const score = (name) => (name.startsWith(stem) ? 0 : 1000) + editDistance(name, tag);
      return names.sort((a, b) => score(a) - score(b)).slice(0, 8);
    } catch (e) {
      log('warn', `tag suggestion failed: repo=${repository} reason=${e.message}`);
      return [];
    }
  }

  async function readConfig(base, reference, session, platform) {
    const get = async (path) => authed(`${base}${path}`, { headers: { Accept: ACCEPT } }, session);
    let res = await get(`/manifests/${reference}`);
    if (!res.ok) return { configError: `manifest HTTP ${res.status}` };
    let manifest = await res.json();
    let platforms = [];
    if (Array.isArray(manifest.manifests)) {
      const items = manifest.manifests.filter((m) => m.platform && m.platform.os !== 'unknown');
      const label = (p) => [p.os, p.architecture, p.variant].filter(Boolean).join('/');
      platforms = [...new Set(items.map((m) => label(m.platform)))];
      const [os, arch, variant] = platform.split('/');
      const match = items.find((m) => m.platform.os === os && m.platform.architecture === arch
        && (!variant || m.platform.variant === variant));
      if (!match) return { platforms, platformMissing: true };
      res = await get(`/manifests/${match.digest}`);
      if (!res.ok) return { platforms, configError: `manifest HTTP ${res.status}` };
      manifest = await res.json();
    }
    if (!manifest.config?.digest) return { platforms };
    const blob = await get(`/blobs/${manifest.config.digest}`);
    if (!blob.ok) return { platforms, configError: `config HTTP ${blob.status}` };
    const image = await blob.json();
    const size = (manifest.layers ?? []).reduce((sum, l) => sum + (l.size ?? 0), 0);
    const actual = [image.os, image.architecture].filter(Boolean).join('/');
    return {
      platforms: platforms.length ? platforms : [actual],
      platformMissing: platforms.length === 0 && actual !== platform.split('/').slice(0, 2).join('/'),
      os: image.os,
      config: image.config ?? {},
      compressedSize: size,
      layerCount: manifest.layers?.length ?? 0,
    };
  }

  async function lookup(ref, platform) {
    const parsed = parseImageRef(ref);
    if (!parsed.ok) return { status: 'invalid', key: parsed.key, params: parsed.params };
    const { registry, repository } = parsed;
    const reference = parsed.digest ?? parsed.tag;
    const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
    const base = `https://${host}/v2/${repository}`;
    const session = {};
    const info = { registry, repository, reference };

    const head = await authed(`${base}/manifests/${reference}`, { method: 'HEAD', headers: { Accept: ACCEPT } }, session);
    if (head.status === 200) {
      let detail = {};
      try {
        detail = await readConfig(base, reference, session, platform);
      } catch (e) {
        log('warn', `config read failed: ref=${ref} reason=${e.message}`);
        detail = { configError: e.message };
      }
      return { status: 'exists', ...info, digest: head.headers.get('docker-content-digest'), ...detail };
    }
    if (head.status === 404) {
      const suggestions = registry === 'docker.io' && !parsed.digest ? await suggestTags(repository, parsed.tag) : [];
      return { status: 'not_found', ...info, suggestions, key: 'reg.notFound' };
    }
    if (head.status === 401 || head.status === 403) {
      return { status: 'auth_required', ...info, key: 'reg.auth' };
    }
    if (head.status === 429) return { status: 'rate_limited', ...info, key: 'reg.rate' };
    return { status: 'error', ...info, key: 'reg.http', params: { status: head.status } };
  }

  return async function checkImage(ref, platform = 'linux/amd64') {
    const key = `${ref}|${platform}`;
    const hit = cache.get(key);
    if (fetchImpl === fetch && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value;
    try {
      value = await lookup(ref, platform);
    } catch (e) {
      const reason = e.cause?.code ?? e.name;
      log('error', `check failed: ref=${ref} reason=${reason} ${e.message}`);
      return { status: 'error', key: 'reg.network', params: { reason } };
    }
    log('info', `ref=${ref} platform=${platform} status=${value.status}`);
    if (fetchImpl === fetch && (value.status === 'exists' && !value.configError || value.status === 'not_found')) {
      cache.set(key, { at: Date.now(), value });
    }
    return value;
  };
}
