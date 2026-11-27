// Local web server: static files, image check and (opt-in) builds. Binds to 127.0.0.1 only.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChecker } from './registry.js';
import { detectEngine, planBuild, runBuild, commandLines } from './builder.js';
import { LocalizedError } from '../public/core/i18n.js';
import { logger, setVerbose } from './log.js';

const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_BODY = 600 * 1024;
const log = logger('SERVER');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value));
const fail = (res, status, error) => json(res, status, { key: error.key, params: error.params });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new LocalizedError('build.badValue', { field: 'body', value: 'too large' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LocalizedError('build.badValue', { field: 'body', value: 'JSON' });
  }
}

export function createApp({
  allowBuild = false,
  workspace = process.cwd(),
  token = randomBytes(24).toString('hex'),
  checkImage = createChecker(),
  detect = detectEngine,
  build = runBuild,
} = {}) {
  const root = resolve(workspace);
  let building = false;

  const authorized = (req) => {
    const given = Buffer.from(String(req.headers['x-build-token'] ?? ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function handleBuild(req, res, path) {
    if (!allowBuild) return fail(res, 403, new LocalizedError('build.disabled'));
    // A custom header forces a CORS preflight, which is never answered, so other sites cannot call this.
    if (!authorized(req)) return fail(res, 401, new LocalizedError('build.badToken'));
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { message: 'cross-origin' });

    if (path === '/api/engine') {
      try {
        const daemon = await detect();
        return json(res, 200, { workspace: root, daemon });
      } catch (e) {
        return json(res, 200, { workspace: root, daemon: null, error: { key: e.key, params: e.params } });
      }
    }

    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { message: 'JSON only' });
    let plan;
    let content;
    try {
      const body = await readJson(req);
      content = body.content;
      if (typeof content !== 'string') throw new LocalizedError('build.badValue', { field: 'content', value: typeof content });
      const { context, output, dest, tag, platform, target, buildArgs, engine } = body;
      const daemon = await detect(engine || undefined);
      // workspace and force are decided by the server, never by the request.
      plan = await planBuild({ context, output, dest, tag, platform, target, buildArgs, workspace: root }, daemon);
    } catch (e) {
      if (!e.key) throw e;
      return fail(res, 400, e);
    }
    const summary = { commands: commandLines(plan), location: plan.location, warnings: plan.warnings, storage: plan.storage, context: plan.context };
    if (path === '/api/plan') return json(res, 200, summary);

    if (building) return fail(res, 409, new LocalizedError('build.busy'));
    building = true;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    // One JSON object per line.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const emit = (value) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(value)}\n`); };
    emit({ type: 'plan', ...summary });
    try {
      const outcome = await build(plan, content, { onData: (text) => emit({ type: 'log', text }), signal: abort.signal });
      emit({ type: 'done', ...outcome });
    } catch (e) {
      log('error', `build failed to run: ${e.message}`);
      emit({ type: 'done', ok: false, code: -1, message: e.message });
    } finally {
      building = false;
      res.end();
    }
    return undefined;
  }

  return createServer(async (req, res) => {
    try {
      // Reject other host names to stop DNS rebinding.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { message: 'forbidden host' });
      if (req.headers['sec-fetch-site'] === 'cross-site' && req.url.startsWith('/api/')) return json(res, 403, { message: 'cross-site' });
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && ['/api/engine', '/api/plan', '/api/build'].includes(url.pathname)) {
        return await handleBuild(req, res, url.pathname);
      }
      if (req.method !== 'GET') return json(res, 405, { message: 'method not allowed' });

      if (url.pathname === '/api/info') return json(res, 200, { buildEnabled: allowBuild });
      if (url.pathname === '/api/check-image') {
        const ref = url.searchParams.get('ref') ?? '';
        const platform = url.searchParams.get('platform') ?? 'linux/amd64';
        if (!ref || ref.length > 300 || !/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(platform)) {
          return json(res, 400, { status: 'invalid', key: 'build.badValue', params: { field: 'ref', value: ref.slice(0, 80) } });
        }
        return json(res, 200, await checkImage(ref, platform));
      }

      const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT + sep)) return json(res, 403, { message: 'forbidden' });
      const body = await readFile(file);
      return send(res, 200, body, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return json(res, 404, { message: 'not found' });
      if (e instanceof URIError) return json(res, 400, { message: 'bad request' });
      log('error', `${req.method} ${req.url} failed: ${e.stack}`);
      if (res.headersSent) return res.end();
      return json(res, 500, { message: 'internal error' });
    }
  });
}

/** Starts the server and returns the URL to open. */
export function serve({ port = 4173, ...options } = {}) {
  setVerbose(true);
  const token = randomBytes(24).toString('hex');
  const server = createApp({ ...options, token });
  return new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      const base = `http://localhost:${server.address().port}`;
      // The token travels in the fragment, which browsers never send to servers.
      done({ server, url: options.allowBuild ? `${base}/#token=${token}` : base });
    });
  });
}

// `node server/server.js` (npm start): editor without build support.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({ port: Number(process.env.PORT ?? 4173) })
    .then(({ url }) => console.log(`Web editor: ${url}`))
    .catch((e) => { log('error', `cannot start: ${e.message}`); process.exit(1); });
}
