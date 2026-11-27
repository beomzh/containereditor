// 정적 파일과 이미지 확인 API 를 제공하는 로컬 서버. 127.0.0.1 에서만 연다.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './registry.js';

const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const checkImage = createChecker();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value));

const server = createServer(async (req, res) => {
  try {
    // DNS rebinding 방지: 로컬 호스트 이름으로 온 요청만 받는다.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { message: 'forbidden host' });
    if (req.method !== 'GET') return json(res, 405, { message: 'method not allowed' });

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/check-image') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { message: 'cross-site' });
      const ref = url.searchParams.get('ref') ?? '';
      const platform = url.searchParams.get('platform') ?? 'linux/amd64';
      if (!ref || ref.length > 300 || !/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(platform)) {
        return json(res, 400, { status: 'invalid', message: 'ref 또는 platform 값이 잘못되었습니다.' });
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
    console.error(`${new Date().toISOString()} [SERVER] ${req.method} ${req.url} 처리 실패: ${e.stack}`);
    return json(res, 500, { message: 'internal error' });
  }
});

server.on('error', (e) => {
  console.error(`[SERVER] 시작 실패: ${e.code === 'EADDRINUSE' ? `포트 ${PORT} 사용 중 (PORT=다른번호 npm start)` : e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.info(`[SERVER] http://localhost:${PORT}`));
