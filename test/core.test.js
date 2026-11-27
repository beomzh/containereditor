import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, splitStages } from '../public/core/parser.js';
import { simulate, effectiveCommand } from '../public/core/simulator.js';
import { validate } from '../public/core/validator.js';
import { parseImageRef } from '../public/core/imageref.js';
import * as ops from '../public/core/editor-ops.js';
import { TEMPLATES } from '../public/core/templates.js';
import { createChecker } from '../server/registry.js';

const codes = (text, severity) => validate(text).filter((d) => !severity || d.severity === severity).map((d) => d.code);

test('줄 이음, 주석, heredoc 파싱', () => {
  const p = parse('# syntax=docker/dockerfile:1\nFROM a\nRUN x \\\n  # c\n  && y\nRUN <<EOF\nFROM not-a-stage\nEOF\nUSER app\n');
  assert.deepEqual(p.instructions.map((i) => i.keyword), ['FROM', 'RUN', 'RUN', 'USER']);
  assert.equal(p.instructions[1].args, 'x   && y');
  assert.equal(p.instructions[2].heredocs[0].lines[0], 'FROM not-a-stage');
  assert.equal(splitStages(p).stages.length, 1);
});

test('이미지 참조 해석', () => {
  assert.deepEqual([parseImageRef('node:22').registry, parseImageRef('node:22').repository], ['docker.io', 'library/node']);
  assert.equal(parseImageRef('localhost:5000/a/b').tag, 'latest');
  assert.equal(parseImageRef('Node:22').ok, false);
  assert.equal(parseImageRef('node:bad tag').ok, false);
  assert.equal(parseImageRef('https://x/y').ok, false);
});

test('템플릿에는 오류와 경고가 없다', () => {
  for (const [name, text] of Object.entries(TEMPLATES)) {
    assert.deepEqual(validate(text).filter((d) => d.severity !== 'info'), [], name);
  }
});

test('문법 오류를 찾는다', () => {
  const bad = [
    ['FORM alpine', 'unknown'],
    ['FROM alpine:3 AS', 'from-syntax'],
    ['RUN ls\nFROM alpine:3', 'before-from'],
    ['FROM alpine:${V}', 'from-var'],
    ['FROM alpine:3\nUSER my user', 'user'],
    ['FROM alpine:3\nUSER a:b:c', 'user'],
    ['FROM alpine:3\nENV ONLYKEY', 'pair'],
    ['FROM alpine:3\nENV A="x', 'quote'],
    ['FROM alpine:3\nARG 1X=2', 'var-name'],
    ['FROM alpine:3\nEXPOSE 70000', 'port'],
    ['FROM alpine:3\nCOPY a', 'copy-args'],
    ['FROM alpine:3\nCOPY a b c', 'copy-dest'],
    ['FROM alpine:3\nCOPY --from=1 a b', 'copy-from'],
    ['FROM alpine:3 AS a\nCOPY --from=b /x /y\nFROM alpine:3 AS b', 'stage-order'],
    ['FROM alpine:3 AS a\nFROM alpine:3 AS a', 'stage-dup'],
    ['FROM alpine:3\nHEALTHCHECK curl x', 'healthcheck'],
    ['FROM alpine:3\nSHELL /bin/bash', 'json'],
    ['FROM alpine:3\nONBUILD FROM x', 'onbuild'],
  ];
  for (const [text, code] of bad) assert.ok(codes(text, 'error').includes(code), `${JSON.stringify(text)} → ${code}: ${codes(text)}`);
  for (const ok of ['FROM alpine:3\nUSER 1000:1000', 'FROM alpine:3\nUSER ${U:-app}', 'FROM alpine:3\nRUN [ -f x ] && echo']) {
    assert.deepEqual(codes(ok, 'error'), [], ok);
  }
});

test('경고: root, 전역 ARG, latest, 비밀값, 없는 사용자', () => {
  assert.ok(codes('FROM alpine:3\nUSER root').includes('root'));
  assert.ok(codes('ARG V=1\nFROM alpine:3\nENV X=$V').includes('global-arg'));
  assert.ok(codes('FROM alpine').includes('latest'));
  assert.ok(codes('FROM alpine:3\nENV API_TOKEN=abc').includes('secret'));
  assert.ok(codes('FROM alpine:3\nUSER svc').includes('user-missing'));
  assert.ok(!codes('FROM alpine:3\nRUN adduser -D svc\nUSER svc').includes('user-missing'));
});

test('시뮬레이션: ARG/ENV 치환, 상속, build-arg, 명령', () => {
  const text = [
    'ARG V=1', 'FROM alpine:${V} AS base', 'ARG V', 'ENV A=$V B=${MISSING:-d}', 'WORKDIR /app', 'WORKDIR sub',
    'CMD ["x"]', 'FROM base', 'ENTRYPOINT ["run"]', 'EXPOSE 80',
  ].join('\n');
  const sim = simulate(text, { buildArgs: { V: '9' } });
  const last = sim.stages[1].state;
  assert.equal(sim.stages[0].baseRef, 'alpine:9');
  assert.equal(last.env.get('A'), '9');
  assert.equal(last.env.get('B'), 'd');
  assert.equal(last.workdir, '/app/sub');
  assert.deepEqual([...last.expose], ['80/tcp']);
  assert.deepEqual(effectiveCommand(last), ['run']); // 상속받은 CMD 는 초기화
});

test('시뮬레이션: 베이스 config 반영과 미사용 스테이지', () => {
  const sim = simulate('FROM a:1 AS unused\nFROM b:1', { baseConfigs: { 'b:1': { Env: ['X=1'], User: 'u', Cmd: ['sh'] } } });
  assert.equal(sim.stages[1].state.user, 'u');
  assert.equal(sim.stages[1].state.env.get('X'), '1');
  assert.deepEqual([...sim.used], [1]);
});

test('설정 추가/수정/삭제는 다른 줄을 보존한다', () => {
  const base = '# c\nFROM alpine:3\nENV A=1 B="two words"\nCMD ["x"]\n';
  assert.equal(ops.setPair(base, 3, 0, null), '# c\nFROM alpine:3\nENV B="two words"\nCMD ["x"]\n');
  assert.match(ops.setPair(base, 3, 1, { key: 'B', value: 'say "hi"' }), /B="say \\"hi\\""/);
  assert.match(ops.addInstruction(base, 0, 'USER app'), /USER app\nCMD/);
  assert.match(ops.addInstruction(base, 0, 'ARG Z'), /FROM alpine:3\nARG Z\n/);
  assert.match(ops.addInstruction(base, -1, 'ARG G=1'), /ARG G=1\n# c\nFROM/);
  assert.throws(() => ops.buildLine('RUN', 'a\nFROM evil'));
  assert.equal(simulate(ops.setPair(base, 3, 1, { key: 'B', value: 'say "hi"' })).stages[0].state.env.get('B'), 'say "hi"');
});

test('스테이지 이름 변경은 참조도 바꾼다', () => {
  const out = ops.setStageFrom('FROM a:1 AS build\nFROM build AS test\nFROM b:1\nCOPY --from=build /x /x\nRUN --mount=type=bind,from=build,target=/m ls\n', 0, { name: 'compile' });
  assert.match(out, /FROM compile AS test/);
  assert.match(out, /--from=compile \/x/);
  assert.match(out, /from=compile,target/);
});

test('스테이지 분리: 이어받기와 새 베이스', () => {
  const text = 'FROM node:22\nWORKDIR /app\nRUN build\n# run\nCMD ["x"]\n';
  const chained = ops.splitStage(text, 5, { name: 'runtime' });
  assert.equal(chained, 'FROM node:22 AS build\nWORKDIR /app\nRUN build\n\nFROM build AS runtime\n# run\nCMD ["x"]\n');
  const fresh = ops.splitStage(text, 5, { name: 'runtime', base: 'alpine:3', copyPath: '/app' });
  assert.match(fresh, /FROM alpine:3 AS runtime\nCOPY --from=build \/app \/app\n# run\nCMD/);
  assert.deepEqual(codes(fresh, 'error'), []);
  const referenced = ops.splitStage('FROM a:1 AS x\nRUN 1\nRUN 2\nFROM b:1\nCOPY --from=x /o /o\n', 3, { name: 'y' });
  assert.match(referenced, /COPY --from=y/);
});

test('번호 참조가 있어도 삭제·추출이 안전하다', () => {
  const text = 'FROM a:1\nRUN unused\n\nFROM b:1\nRUN build\n\nFROM c:1\nCOPY --from=1 /o /o\n';
  const removed = ops.removeStage(text, 0);
  assert.match(removed, /FROM b:1 AS stage1/);
  assert.match(removed, /--from=stage1/);
  assert.deepEqual(codes(removed, 'error'), []);
  const extracted = ops.extractStage(text, 2);
  assert.doesNotMatch(extracted, /unused/);
  assert.deepEqual(codes(extracted, 'error'), []);
  assert.throws(() => ops.removeStage(text, 1), /삭제할 수 없습니다/);
});

test('편집해도 heredoc 의 빈 줄과 여러 줄 ENV 모양을 지킨다', () => {
  const text = 'FROM a:1\nRUN <<EOF\necho 1\n\n\necho 2\nEOF\nENV A=1 \\\n    B=2\n';
  const out = ops.setPair(text, 8, 1, { key: 'B', value: '3' });
  assert.equal(out, 'FROM a:1\nRUN <<EOF\necho 1\n\n\necho 2\nEOF\nENV A=1 \\\n    B=3\n');
  const renamed = ops.setStageFrom('FROM a:1 AS x\nFROM b:1\nRUN --mount=from=x,target=/m ls\n', 0, { name: 'y' });
  assert.match(renamed, /--mount=from=y,target/);
});

test('레지스트리 확인: 토큰 인증 후 config 읽기, 404, 잘못된 이름', async () => {
  const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
  const fake = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith('https://auth.example/token')) return reply(200, { token: 't' });
    if (!options.headers?.Authorization && u.includes('/v2/library/')) {
      return reply(401, {}, { 'www-authenticate': 'Bearer realm="https://auth.example/token",service="s",scope="x"' });
    }
    if (u.endsWith('/manifests/nope')) return reply(404, null);
    if (u.includes('hub.docker.com')) return reply(200, { results: [{ name: '3.20' }] });
    if (options.method === 'HEAD') return reply(200, null);
    if (u.endsWith('/manifests/3')) return reply(200, { manifests: [{ digest: 'sha256:m', platform: { os: 'linux', architecture: 'amd64' } }] });
    if (u.endsWith('/manifests/sha256:m')) return reply(200, { config: { digest: 'sha256:c' }, layers: [{ size: 5 }] });
    if (u.endsWith('/blobs/sha256:c')) return reply(200, { os: 'linux', architecture: 'amd64', config: { User: 'u' } });
    return reply(500, {});
  };
  const check = createChecker(fake);
  const found = await check('alpine:3');
  assert.equal(found.status, 'exists');
  assert.equal(found.config.User, 'u');
  assert.equal((await check('alpine:3', 'linux/arm64')).platformMissing, true);
  const missing = await check('alpine:nope');
  assert.deepEqual([missing.status, missing.suggestions], ['not_found', ['3.20']]);
  assert.equal((await check('Bad Name')).status, 'invalid');
});
