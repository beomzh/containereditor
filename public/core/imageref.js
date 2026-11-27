// 이미지 참조 문자열([registry/]repository[:tag][@digest]) 해석. 서버와 브라우저가 함께 쓴다.

const COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

export function parseImageRef(ref) {
  const fail = (error) => ({ ok: false, error });
  if (!ref) return fail('이미지 이름이 비어 있습니다.');
  if (ref.includes('://')) return fail('이미지 이름에는 http:// 같은 스킴을 붙이지 않습니다.');

  let rest = ref;
  let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return fail('digest 는 sha256: 뒤에 64자리 16진수여야 합니다.');
  }

  let tag = null;
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return fail(`태그 형식이 잘못되었습니다: "${tag}"`);
  }

  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
    if (!HOST.test(registry)) return fail(`레지스트리 주소가 잘못되었습니다: "${registry}"`);
  }
  if (parts.length === 0 || !parts.every((p) => COMPONENT.test(p))) {
    return fail(/[A-Z]/.test(parts.join('/'))
      ? '저장소 이름은 소문자만 쓸 수 있습니다.'
      : `저장소 이름 형식이 잘못되었습니다: "${parts.join('/')}"`);
  }
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');

  return { ok: true, registry, repository: parts.join('/'), tag: tag ?? (digest ? null : 'latest'), explicitTag: tag !== null, digest };
}
