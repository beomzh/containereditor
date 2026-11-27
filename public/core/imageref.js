// Parses [registry/]repository[:tag][@digest]. Shared by server, browser and CLI.

const COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

export function parseImageRef(ref) {
  const fail = (key, params = {}) => ({ ok: false, key, params });
  if (!ref) return fail('ref.empty');
  if (ref.includes('://')) return fail('ref.scheme');

  let rest = ref;
  let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return fail('ref.digest');
  }

  let tag = null;
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return fail('ref.tag', { value: tag });
  }

  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
    if (!HOST.test(registry)) return fail('ref.registry', { value: registry });
  }
  if (parts.length === 0 || !parts.every((p) => COMPONENT.test(p))) {
    return /[A-Z]/.test(parts.join('/')) ? fail('ref.lowercase') : fail('ref.repo', { value: parts.join('/') });
  }
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');

  return { ok: true, registry, repository: parts.join('/'), tag: tag ?? (digest ? null : 'latest'), explicitTag: tag !== null, digest };
}
