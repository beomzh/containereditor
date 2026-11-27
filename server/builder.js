// Runs real builds with docker or podman. Commands are always spawned without a shell.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, stat, readdir, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { LocalizedError } from '../public/core/i18n.js';
import { parseImageRef } from '../public/core/imageref.js';
import { logger } from './log.js';

const run = promisify(execFile);
const ENGINES = ['docker', 'podman'];
export const OUTPUTS = ['image', 'archive', 'folder'];
const log = logger('BUILD');

const ARCH = { x86_64: 'amd64', aarch64: 'arm64', armv7l: 'arm' };

/** Finds a usable engine and what kind of containers its daemon runs. */
export async function detectEngine(preferred, exec = run) {
  if (preferred && !ENGINES.includes(preferred)) throw new LocalizedError('build.badEngine');
  const reasons = [];
  for (const engine of preferred ? [preferred] : ENGINES) {
    try {
      const format = engine === 'docker'
        ? '{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}|{{.OperatingSystem}}'
        : '{{.Version.Version}}|{{.Host.OS}}|{{.Host.Arch}}|{{.Store.GraphRoot}}|';
      // A cold daemon (Windows especially) can take a while to answer.
      const { stdout } = await exec(engine, ['info', '--format', format], { timeout: 60_000 });
      const [version, os, arch, rootDir, operatingSystem] = stdout.trim().split('|');
      if (!version || !os) continue;
      const vm = /docker desktop/i.test(operatingSystem ?? '') || (process.platform !== 'linux' && os === 'linux');
      return { engine, version, os, arch: ARCH[arch] ?? arch, rootDir, vm };
    } catch (e) {
      reasons.push(`${engine}: ${String(e.stderr || e.message).trim().slice(0, 300)}`);
    }
  }
  log('warn', `no usable engine. ${reasons.join(' | ')}`);
  throw new LocalizedError('build.noEngine');
}

// Real path of the nearest existing ancestor plus the rest, so symlinks cannot escape the workspace.
async function realTarget(path) {
  let current = path;
  const rest = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' || dirname(current) === current) throw e;
      rest.unshift(current.slice(dirname(current).length).replace(/^[\\/]+/, ''));
      current = dirname(current);
    }
  }
}

async function within(workspace, path) {
  const root = await realpath(workspace);
  const target = await realTarget(path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new LocalizedError('build.outside', { path });
  return target;
}

const exists = (path) => stat(path).then((s) => s, (e) => { if (e.code === 'ENOENT') return null; throw e; });

/**
 * Validates the request and describes the commands and where the result will be.
 * `workspace` restricts context and destination (used by the web server).
 */
export async function planBuild(request, daemon) {
  const {
    context = '.', output = 'image', dest = '', tag = 'myimage:latest', platform = '',
    target = '', buildArgs = {}, workspace = null, force = false, cwd = process.cwd(),
    container = process.env.DOCKEREDITOR_CONTAINER === '1',
  } = request;
  const bad = (field, value) => new LocalizedError('build.badValue', { field, value });
  for (const [field, value] of Object.entries({ context, output, dest, tag, platform, target })) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw bad(field, String(value));
  }
  if (!OUTPUTS.includes(output)) throw new LocalizedError('build.badOutput');
  if (platform && !/^(linux|windows)\/[a-z0-9]+(\/v\d+)?$/.test(platform)) throw bad('platform', platform);
  if (target && !/^[A-Za-z][\w.-]*$/.test(target)) throw bad('target', target);
  for (const [key, value] of Object.entries(buildArgs)) {
    if (!/^[A-Za-z_]\w*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw bad('build-arg', key);
  }

  const warnings = [];
  if (platform) {
    const [os, arch] = platform.split('/');
    if (os !== daemon.os) {
      throw new LocalizedError('build.osMismatch', { engine: daemon.engine, daemon: daemon.os, platform, os: os === 'windows' ? 'Windows' : 'Linux' });
    }
    if (arch !== daemon.arch) warnings.push({ key: 'build.emulation', params: { platform, daemon: `${daemon.os}/${daemon.arch}` } });
  }

  const base = workspace ?? cwd;
  let contextPath = resolve(base, context);
  if (workspace) contextPath = await within(workspace, contextPath);
  if (!(await exists(contextPath))?.isDirectory()) throw new LocalizedError('build.noContext', { path: contextPath });

  let destPath = null;
  if (output !== 'image') {
    if (!dest) throw new LocalizedError('build.needDest');
    destPath = resolve(base, dest);
    if (workspace) destPath = await within(workspace, destPath);
    // The value of --output is parsed as CSV.
    if (output === 'folder' && destPath.includes(',')) throw bad('dest', destPath);
    const found = await exists(destPath);
    if (found && !force) {
      if (output === 'archive') throw new LocalizedError('build.destExists', { path: destPath });
      if (!found.isDirectory() || (await readdir(destPath)).length) throw new LocalizedError('build.destNotEmpty', { path: destPath });
    }
    if (found?.isDirectory() && output === 'archive') throw bad('dest', destPath);
    if (found && !found.isDirectory() && output === 'folder') throw bad('dest', destPath);
  }
  if (output !== 'folder') {
    const ref = parseImageRef(tag);
    if (!ref.ok || ref.digest || tag.startsWith('-')) throw new LocalizedError('build.badTag', { value: tag });
  }

  const { engine } = daemon;
  // A Windows Docker daemon uses the classic builder, which lacks BuildKit options.
  const classic = engine === 'docker' && daemon.os === 'windows';
  if (classic && output === 'folder') throw new LocalizedError('build.noFolderWindows');
  const build = ['build'];
  if (platform && !(classic && platform === `${daemon.os}/${daemon.arch}`)) build.push('--platform', platform);
  if (target) build.push('--target', target);
  for (const [key, value] of Object.entries(buildArgs)) build.push('--build-arg', `${key}=${value}`);
  if (engine === 'docker' && !classic) build.push('--progress', 'plain');
  if (output === 'folder') build.push('--output', `type=local,dest=${destPath}`);
  else {
    build.push('-t', tag);
    if (engine === 'docker' && !classic) build.push('--load');
  }

  const steps = [build];
  if (output === 'archive') steps.push(['save', '-o', destPath, tag]);

  const location = output === 'image'
    ? { type: 'image', key: 'build.locImage', params: { engine, tag } }
    : { type: output, path: destPath, key: output === 'archive' ? 'build.locArchive' : 'build.locFolder', params: { engine, path: destPath } };
  if (output === 'image' && daemon.vm) warnings.push({ key: 'build.vm' });
  if (output !== 'image' && container) warnings.push({ key: 'build.container' });

  // The classic builder cannot use a Dockerfile on another drive than the context, so it is piped in.
  return { engine, steps, stdin: classic, context: contextPath, output, tag, dest: destPath, location, warnings, storage: daemon.rootDir };
}

/** Adds the Dockerfile and context to the build step. */
const argvFor = (plan, step, index, dockerfile) => (index === 0 ? [...step, '-f', dockerfile, plan.context] : step);

export const quoteArg = (a) => (/^[\w./:=@,+\\-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
export const commandLines = (plan, dockerfile = 'Dockerfile') => plan.steps
  .map((step, i) => [plan.engine, ...argvFor(plan, step, i, dockerfile)].map(quoteArg).join(' '));

function runStep(command, args, { onData, signal, spawnImpl, input }) {
  return new Promise((done, fail) => {
    const child = spawnImpl(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, signal });
    if (input !== undefined) {
      // The engine may exit before reading everything; its exit code reports the failure.
      child.stdin.on('error', (e) => log('debug', `stdin: ${e.code}`));
      child.stdin.end(input);
    }
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('error', fail);
    child.on('close', (code) => done(code ?? 1));
  });
}

async function inspect(plan, exec) {
  if (plan.output === 'image') {
    const { stdout } = await exec(plan.engine, ['image', 'inspect', plan.tag, '--format', '{{.Id}}|{{.Size}}|{{.Os}}/{{.Architecture}}']);
    const [id, size, platform] = stdout.trim().split('|');
    return { key: 'build.imageInfo', params: { id: id.replace('sha256:', '').slice(0, 12), size: (size / 1048576).toFixed(1), platform } };
  }
  if (plan.output === 'archive') {
    const info = await stat(plan.dest);
    return { key: 'build.fileInfo', params: { path: plan.dest, size: (info.size / 1048576).toFixed(2) } };
  }
  const entries = await readdir(plan.dest);
  return { key: 'build.folderInfo', params: { path: plan.dest, count: entries.length }, entries: entries.slice(0, 40) };
}

/**
 * Runs a planned build. The Dockerfile content is written to a temporary file,
 * so the user's files are never modified.
 */
export async function runBuild(plan, content, { onData, signal, spawnImpl = spawn, exec = run } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'dockereditor-'));
  try {
    const dockerfile = join(temp, 'Dockerfile');
    await writeFile(dockerfile, content);
    if (plan.dest) await mkdir(dirname(plan.dest), { recursive: true });
    for (const [i, step] of plan.steps.entries()) {
      log('info', `start engine=${plan.engine} step=${step[0]} output=${plan.output}`);
      const piped = plan.stdin && i === 0;
      const code = await runStep(plan.engine, argvFor(plan, step, i, piped ? '-' : dockerfile), { onData, signal, spawnImpl, input: piped ? content : undefined });
      log(code ? 'error' : 'info', `end step=${step[0]} code=${code}`);
      if (code !== 0) return { ok: false, code };
    }
    try {
      return { ok: true, code: 0, result: await inspect(plan, exec) };
    } catch (e) {
      log('warn', `built, but the result could not be inspected: ${e.message}`);
      return { ok: true, code: 0, result: null };
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
