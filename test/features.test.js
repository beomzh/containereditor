import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MESSAGES, LANGUAGES, translate } from '../public/core/i18n.js';
import { simulate, effectiveCommand } from '../public/core/simulator.js';
import { validate } from '../public/core/validator.js';
import { compatibility, PLATFORMS } from '../public/core/platforms.js';
import { TEMPLATES } from '../public/core/templates.js';
import { planBuild, runBuild, commandLines } from '../server/builder.js';
import { createApp } from '../server/server.js';
import { main } from '../bin/cli.js';

const daemon = { engine: 'docker', version: '1', os: 'linux', arch: 'amd64', rootDir: '/var/lib/docker', vm: false };
const temp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'de-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('every message has all four languages with the same placeholders', () => {
  const count = Object.keys(LANGUAGES).length;
  for (const [key, entry] of Object.entries(MESSAGES)) {
    assert.equal(entry.length, count, key);
    const names = entry.map((text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join());
    assert.equal(new Set(names).size, 1, `${key}: ${names.join(' | ')}`);
    assert.ok(entry.every(Boolean), key);
  }
  assert.equal(translate('xx', 'ui.save'), 'Save'); // English is the default
  assert.equal(translate('ko', 'diag.undefinedVar', { name: 'V' }), '정의되지 않은 변수입니다: ${V}');
});

test('diagnostics follow the requested language', () => {
  assert.match(validate('FROM alpine:3\nUSER a b')[0].message, /USER cannot contain spaces/);
  assert.match(validate('FROM alpine:3\nUSER a b', { lang: 'zh' })[0].message, /USER 不能包含空格/);
  assert.match(validate('FROM alpine:3\nUSER a b', { lang: 'ja' })[0].message, /空白は使えません/);
});

test('Windows Dockerfiles: paths, default shell and Windows-only rules', () => {
  const sim = simulate(TEMPLATES.windows.replace('CMD ["cmd", "/c", "run.bat"]', 'WORKDIR sub\nCOPY a.txt ./\nCMD run.bat'));
  const stage = sim.stages[0];
  assert.equal(stage.os, 'windows');
  assert.equal(stage.state.workdir, 'C:\\app\\sub');
  assert.equal(stage.state.files.at(-1).dest, 'C:\\app\\sub\\');
  assert.deepEqual(effectiveCommand(stage.state, 'windows'), ['cmd', '/S', '/C', 'run.bat']);
  assert.deepEqual(validate(TEMPLATES.windows).filter((d) => d.severity !== 'info'), []);

  const bad = validate('FROM mcr.microsoft.com/windows/nanoserver:ltsc2022\nWORKDIR C:\\app\nCOPY --chmod=755 a b\nRUN --mount=type=cache,target=c dir\nUSER ContainerAdministrator');
  assert.equal(bad.filter((d) => d.code === 'windows').length, 3); // escape directive, --chmod, --mount
  assert.ok(bad.some((d) => d.code === 'root'));
});

test('platform compatibility matrix', () => {
  const results = {
    'a:1': { status: 'exists', platforms: ['linux/amd64', 'linux/arm64/v8', 'windows/amd64'] },
    'b:1': { status: 'exists', platforms: ['linux/amd64', 'linux/arm64'] },
  };
  const run = (text) => compatibility(simulate(text), (ref) => results[ref]).summary;
  assert.deepEqual(PLATFORMS, ['linux/amd64', 'linux/arm64', 'windows/amd64', 'windows/arm64']);
  assert.deepEqual(run('FROM a:1 AS x\nFROM b:1\nCOPY --from=x /a /a'), [true, true, false, false]);
  assert.deepEqual(run('FROM --platform=$BUILDPLATFORM a:1 AS x\nFROM a:1\nCOPY --from=x /a /a'), [true, true, true, false]);
  assert.deepEqual(run('FROM --platform=linux/amd64 b:1'), [true, false, false, false]);
  assert.deepEqual(run('FROM unknown:1'), [null, null, null, null]);
});

test('build plan says where the result goes and refuses unsafe destinations', async (t) => {
  const dir = await temp(t);
  const outside = await temp(t);
  await mkdir(join(dir, 'full'));
  await writeFile(join(dir, 'full', 'x'), 'x');

  const image = await planBuild({ cwd: dir, tag: 'app:1', platform: 'linux/arm64' }, daemon);
  assert.equal(image.location.key, 'build.locImage');
  assert.equal(image.warnings[0].key, 'build.emulation');
  assert.match(commandLines(image)[0], /^docker build --platform linux\/arm64 .* -t app:1 --load -f Dockerfile /);

  const archive = await planBuild({ cwd: dir, output: 'archive', dest: 'out/i.tar', tag: 'app:1' }, daemon);
  assert.equal(commandLines(archive).length, 2);
  assert.ok(archive.location.path.endsWith(join('out', 'i.tar')));

  const folder = await planBuild({ cwd: dir, output: 'folder', dest: 'rootfs' }, daemon);
  assert.ok(folder.steps[0].some((a) => a.startsWith('type=local,dest=')));

  const rejects = (req, key) => assert.rejects(planBuild({ cwd: dir, ...req }, daemon), (e) => e.key === key, JSON.stringify(req));
  await rejects({ output: 'folder', dest: 'full' }, 'build.destNotEmpty');
  await rejects({ output: 'archive', dest: 'full/x' }, 'build.destExists');
  await rejects({ output: 'folder' }, 'build.needDest');
  await rejects({ platform: 'windows/amd64' }, 'build.osMismatch');
  await rejects({ tag: '--privileged' }, 'build.badTag');
  await rejects({ context: 'nope' }, 'build.noContext');
  await rejects({ buildArgs: { 'a b': '1' } }, 'build.badValue');
  await rejects({ workspace: dir, context: outside }, 'build.outside');
  await rejects({ workspace: dir, output: 'folder', dest: '../escape' }, 'build.outside');
  if (process.platform !== 'win32') {
    await symlink(outside, join(dir, 'link'));
    await rejects({ workspace: dir, output: 'folder', dest: 'link/new' }, 'build.outside');
  }
});

test('Windows daemon: no BuildKit options and no folder output', async (t) => {
  const dir = await temp(t);
  const windows = { ...daemon, os: 'windows' };
  const plan = await planBuild({ cwd: dir, tag: 'app:1', platform: 'windows/amd64' }, windows);
  assert.deepEqual(plan.steps[0], ['build', '-t', 'app:1']);
  await assert.rejects(planBuild({ cwd: dir, output: 'folder', dest: 'x' }, windows), (e) => e.key === 'build.noFolderWindows');

  // The Dockerfile is piped in, because it may be on another drive than the context.
  const { EventEmitter } = await import('node:events');
  let args;
  let piped;
  const spawnImpl = (command, argv) => {
    args = argv;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() });
    child.stdin.end = (text) => { piped = text; queueMicrotask(() => child.emit('close', 0)); };
    return child;
  };
  await runBuild(plan, 'FROM a\n', { onData() {}, spawnImpl, exec: async () => ({ stdout: 'sha256:a|1|windows/amd64\n' }) });
  assert.equal(args[args.indexOf('-f') + 1], '-');
  assert.equal(piped, 'FROM a\n');
});

test('runBuild passes arguments without a shell and removes its temporary Dockerfile', async (t) => {
  const dir = await temp(t);
  const plan = await planBuild({ cwd: dir, tag: 'app:1', buildArgs: { A: '$(rm -rf /); x' } }, daemon);
  let seen;
  const { EventEmitter } = await import('node:events');
  const spawnImpl = (command, args, options) => {
    seen = { command, args, options, dockerfile: args[args.indexOf('-f') + 1] };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    readFile(seen.dockerfile, 'utf8').then((text) => { seen.content = text; child.emit('close', 0); });
    return child;
  };
  const outcome = await runBuild(plan, 'FROM a\n', { onData() {}, spawnImpl, exec: async () => ({ stdout: 'sha256:abcdef0123456789|1048576|linux/amd64\n' }) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.params.id, 'abcdef012345');
  assert.ok(seen.args.includes('A=$(rm -rf /); x'));
  assert.equal(seen.options.shell, undefined);
  assert.equal(seen.content, 'FROM a\n');
  await assert.rejects(readFile(seen.dockerfile));
});

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

test('server: build is opt-in and protected by token, origin and workspace', async (t) => {
  const dir = await temp(t);
  let built = 0;
  const start = async (options) => {
    const app = createApp({ workspace: dir, token: 'a'.repeat(48), detect: async () => daemon, build: async (plan, content, { onData }) => { built++; onData('step\n'); return { ok: true, code: 0 }; }, ...options });
    await new Promise((done) => app.listen(0, '127.0.0.1', done));
    t.after(() => app.close());
    return app.address().port;
  };
  const closed = await start({ allowBuild: false });
  const open = await start({ allowBuild: true });
  const good = { 'content-type': 'application/json', 'x-build-token': 'a'.repeat(48) };
  const post = (port, path, headers, body) => call(port, { method: 'POST', path, headers, body: JSON.stringify(body) });
  const body = { content: 'FROM alpine:3\n', tag: 'a:1' };

  assert.equal((await post(closed, '/api/build', good, body)).status, 403);
  assert.equal((await post(open, '/api/build', { 'content-type': 'application/json' }, body)).status, 401);
  assert.equal((await post(open, '/api/build', { ...good, origin: 'http://evil.example' }, body)).status, 403);
  assert.equal((await post(open, '/api/build', { ...good, 'content-type': 'text/plain' }, body)).status, 415);
  assert.equal((await post(open, '/api/build', good, { ...body, context: '..' })).status, 400);
  // The request cannot widen the workspace or force overwriting.
  assert.equal((await post(open, '/api/build', good, { ...body, workspace: '/', context: '/' })).status, 400);
  assert.equal(built, 0);

  const ok = await post(open, '/api/build', good, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.trim().split('\n').map((l) => JSON.parse(l).type), ['plan', 'log', 'done']);

  assert.equal((await call(open, { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await call(open, { path: '/%2e%2e%2fpackage.json' })).status, 403);
  const page = await call(open, {});
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await call(open, { path: '/api/info' })).data, '{"buildEnabled":true}');
});

test('CLI: create, validate, edit and check files', async (t) => {
  const dir = await temp(t);
  const lines = [];
  const io = {
    cwd: dir, env: {}, out: (s) => lines.push(s), err: (s) => lines.push(s), raw: (s) => lines.push(s),
    checkImage: async (ref) => (ref.startsWith('node:') ? { status: 'exists', platforms: ['linux/amd64', 'linux/arm64'] } : { status: 'not_found', key: 'reg.notFound' }),
  };
  const run = async (...argv) => { lines.length = 0; return main(argv, io); };
  const file = () => readFile(join(dir, 'Dockerfile'), 'utf8');

  assert.equal(await run('new', 'node'), 0);
  assert.equal(await run('new', 'node'), 2); // never overwrites without --force
  assert.equal(await run('validate'), 0);
  assert.match(lines.at(-1), /errors 0/);
  assert.equal(await run('add', 'Dockerfile', 'env', 'GREETING=hello world'), 0);
  assert.equal(await run('set', 'Dockerfile', 'ENV', 'NODE_ENV=test'), 0);
  assert.match(await file(), /ENV NODE_ENV=test\nENV GREETING="hello world"/);
  assert.equal(await run('remove', 'Dockerfile', 'ENV', 'GREETING'), 0);
  assert.doesNotMatch(await file(), /GREETING/);
  assert.equal(await run('remove', 'Dockerfile', 'ENV', 'GREETING'), 2);
  assert.equal(await run('remove', 'Dockerfile', 'EXPOSE'), 0);
  assert.equal(await run('stage', 'rename', 'Dockerfile', '--stage', 'build', '--name', 'compile'), 0);
  assert.match(await file(), /--from=compile/);

  assert.equal(await run('check'), 0);
  assert.equal(await run('check', '--platform', 'linux/arm64'), 0);
  assert.equal(await run('check', '--platform', 'windows/arm64'), 1);
  assert.equal(await run('from', 'Dockerfile', 'nodee:1', '--stage', '1'), 0);
  assert.equal(await run('check', '--lang', 'ko'), 1);
  assert.ok(lines.some((l) => l.includes('태그 또는 저장소를 찾을 수 없습니다')));

  await writeFile(join(dir, 'crlf'), 'FROM node:22\r\nUSER node\r\n');
  assert.equal(await run('add', 'crlf', 'ENV', 'A=1'), 0);
  assert.equal(await readFile(join(dir, 'crlf'), 'utf8'), 'FROM node:22\r\nENV A=1\r\nUSER node\r\n');

  io.detect = async () => daemon;
  assert.equal(await run('build', '--dry-run', '--output', 'folder', '--dest', 'rootfs'), 0);
  assert.ok(lines.some((l) => l.includes(join(dir, 'rootfs'))) || lines.some((l) => l.includes('rootfs')));
  assert.equal(await run('bogus'), 2);
});
