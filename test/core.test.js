import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, splitStages } from '../public/core/parser.js';
import { simulate, effectiveCommand } from '../public/core/simulator.js';
import { validate } from '../public/core/validator.js';
import { parseImageRef } from '../public/core/imageref.js';
import * as ops from '../public/core/editor-ops.js';
import { TEMPLATES } from '../public/core/templates.js';
import { createChecker, allowedRegistry } from '../server/registry.js';

const codes = (text, severity) => validate(text).filter((d) => !severity || d.severity === severity).map((d) => d.code);

test('parses continuations, comments and heredocs', () => {
  const p = parse('# syntax=docker/dockerfile:1\nFROM a\nRUN x \\\n  # c\n  && y\nRUN <<EOF\nFROM not-a-stage\nEOF\nUSER app\n');
  assert.deepEqual(p.instructions.map((i) => i.keyword), ['FROM', 'RUN', 'RUN', 'USER']);
  assert.equal(p.instructions[1].args, 'x   && y');
  assert.equal(p.instructions[2].heredocs[0].lines[0], 'FROM not-a-stage');
  assert.equal(splitStages(p).stages.length, 1);
});

test('parses image references', () => {
  assert.deepEqual([parseImageRef('node:22').registry, parseImageRef('node:22').repository], ['docker.io', 'library/node']);
  assert.equal(parseImageRef('localhost:5000/a/b').tag, 'latest');
  assert.equal(parseImageRef('Node:22').ok, false);
  assert.equal(parseImageRef('node:bad tag').ok, false);
  assert.equal(parseImageRef('https://x/y').ok, false);
});

test('templates have no errors or warnings', () => {
  for (const [name, text] of Object.entries(TEMPLATES)) {
    assert.deepEqual(validate(text).filter((d) => d.severity !== 'info'), [], name);
  }
});

test('finds syntax errors', () => {
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

test('warns about root, global ARG, latest, secrets and missing users', () => {
  assert.ok(codes('FROM alpine:3\nUSER root').includes('root'));
  assert.ok(codes('ARG V=1\nFROM alpine:3\nENV X=$V').includes('global-arg'));
  assert.ok(codes('FROM alpine').includes('latest'));
  assert.ok(codes('FROM alpine:3\nENV API_TOKEN=abc').includes('secret'));
  assert.ok(codes('FROM alpine:3\nUSER svc').includes('user-missing'));
  assert.ok(!codes('FROM alpine:3\nRUN adduser -D svc\nUSER svc').includes('user-missing'));
});

test('simulation: ARG/ENV expansion, inheritance, build args, command', () => {
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
  assert.deepEqual(effectiveCommand(last), ['run']); // the inherited CMD is reset
});

test('simulation: base image config and unused stages', () => {
  const sim = simulate('FROM a:1 AS unused\nFROM b:1', { baseConfigs: { 'b:1': { Env: ['X=1'], User: 'u', Cmd: ['sh'] } } });
  assert.equal(sim.stages[1].state.user, 'u');
  assert.equal(sim.stages[1].state.env.get('X'), '1');
  assert.deepEqual([...sim.used], [1]);
});

test('adding, changing and removing settings keeps other lines', () => {
  const base = '# c\nFROM alpine:3\nENV A=1 B="two words"\nCMD ["x"]\n';
  assert.equal(ops.setPair(base, 3, 0, null), '# c\nFROM alpine:3\nENV B="two words"\nCMD ["x"]\n');
  assert.match(ops.setPair(base, 3, 1, { key: 'B', value: 'say "hi"' }), /B="say \\"hi\\""/);
  assert.match(ops.addInstruction(base, 0, 'USER app'), /USER app\nCMD/);
  assert.match(ops.addInstruction(base, 0, 'ARG Z'), /FROM alpine:3\nARG Z\n/);
  assert.match(ops.addInstruction(base, -1, 'ARG G=1'), /ARG G=1\n# c\nFROM/);
  assert.throws(() => ops.buildLine('RUN', 'a\nFROM evil'));
  assert.equal(simulate(ops.setPair(base, 3, 1, { key: 'B', value: 'say "hi"' })).stages[0].state.env.get('B'), 'say "hi"');
});

test('renaming a stage updates references', () => {
  const out = ops.setStageFrom('FROM a:1 AS build\nFROM build AS test\nFROM b:1\nCOPY --from=build /x /x\nRUN --mount=type=bind,from=build,target=/m ls\n', 0, { name: 'compile' });
  assert.match(out, /FROM compile AS test/);
  assert.match(out, /--from=compile \/x/);
  assert.match(out, /from=compile,target/);
});

test('splits stages: inherited and new base', () => {
  const text = 'FROM node:22\nWORKDIR /app\nRUN build\n# run\nCMD ["x"]\n';
  const chained = ops.splitStage(text, 5, { name: 'runtime' });
  assert.equal(chained, 'FROM node:22 AS build\nWORKDIR /app\nRUN build\n\nFROM build AS runtime\n# run\nCMD ["x"]\n');
  const fresh = ops.splitStage(text, 5, { name: 'runtime', base: 'alpine:3', copyPath: '/app' });
  assert.match(fresh, /FROM alpine:3 AS runtime\nCOPY --from=build \/app \/app\n# run\nCMD/);
  assert.deepEqual(codes(fresh, 'error'), []);
  const referenced = ops.splitStage('FROM a:1 AS x\nRUN 1\nRUN 2\nFROM b:1\nCOPY --from=x /o /o\n', 3, { name: 'y' });
  assert.match(referenced, /COPY --from=y/);
});

test('delete and extract are safe with numeric references', () => {
  const text = 'FROM a:1\nRUN unused\n\nFROM b:1\nRUN build\n\nFROM c:1\nCOPY --from=1 /o /o\n';
  const removed = ops.removeStage(text, 0);
  assert.match(removed, /FROM b:1 AS stage1/);
  assert.match(removed, /--from=stage1/);
  assert.deepEqual(codes(removed, 'error'), []);
  const extracted = ops.extractStage(text, 2);
  assert.doesNotMatch(extracted, /unused/);
  assert.deepEqual(codes(extracted, 'error'), []);
  assert.throws(() => ops.removeStage(text, 1), /Cannot delete/);
});

test('editing keeps heredoc blank lines and multi-line ENV', () => {
  const text = 'FROM a:1\nRUN <<EOF\necho 1\n\n\necho 2\nEOF\nENV A=1 \\\n    B=2\n';
  const out = ops.setPair(text, 8, 1, { key: 'B', value: '3' });
  assert.equal(out, 'FROM a:1\nRUN <<EOF\necho 1\n\n\necho 2\nEOF\nENV A=1 \\\n    B=3\n');
  const renamed = ops.setStageFrom('FROM a:1 AS x\nFROM b:1\nRUN --mount=from=x,target=/m ls\n', 0, { name: 'y' });
  assert.match(renamed, /--mount=from=y,target/);
});

test('registry check: token auth, config, 404, invalid name', async () => {
  const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
  const fake = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith('https://auth.docker.io/token')) return reply(200, { token: 't' });
    if (!options.headers?.Authorization && u.includes('/v2/library/')) {
      return reply(401, {}, { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="s",scope="x"' });
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

test('only known or explicitly added registries are contacted', async () => {
  let calls = 0;
  const check = createChecker(async () => { calls++; return new Response(null, { status: 404 }); });
  for (const ref of ['169.254.169.254/a/b:1', 'localhost:5000/a:1', 'ghcr.io.evil.example/a:1']) {
    assert.equal((await check(ref)).status, 'blocked', ref);
  }
  assert.equal(calls, 0);
  assert.equal(allowedRegistry('harbor.corp.local', 'harbor.corp.local'), true);
  assert.equal(allowedRegistry('x.azurecr.io', ''), true);

  // A registry cannot send the token request to another host.
  const seen = [];
  const redirecting = createChecker(async (url) => {
    seen.push(new URL(url).host);
    return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://internal.example/token"' } });
  });
  await redirecting('ghcr.io/a/b:1');
  assert.ok(!seen.includes('internal.example'));
});
