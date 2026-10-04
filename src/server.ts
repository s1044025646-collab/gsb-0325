// HTTP API（node:http，无外部依赖）。默认端口 0 = 自动选择空闲端口。
import * as http from 'node:http';
import { ApiError } from './core';
import { Service } from './service';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new ApiError('LIMIT_EXCEEDED', '请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError('BAD_REQUEST', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readBody(req) : {};
      const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN);
      const qv = url.searchParams.get('version');
      const version = qv !== null ? num(qv) : undefined;
      if (qv !== null && Number.isNaN(version)) throw new ApiError('BAD_REQUEST', 'version 参数非法');

      // POST /networks/batcher {lines}
      if (method === 'POST' && parts[0] === 'networks' && parts[1] === 'batcher') {
        return send(res, 201, service.generate(num(String((body as any).lines))));
      }
      // POST /networks/import 或 POST /networks/:id/import（导入即新版本）
      if (method === 'POST' && parts[0] === 'networks' && parts[parts.length - 1] === 'import') {
        const id = parts.length === 3 ? num(parts[1]) : undefined;
        if (parts.length === 3 && Number.isNaN(id)) throw new ApiError('BAD_REQUEST', '网络 id 非法');
        return send(res, 201, service.importNetwork(body, id));
      }
      if (parts[0] === 'networks' && parts.length >= 2) {
        const id = num(parts[1]);
        if (Number.isNaN(id)) throw new ApiError('BAD_REQUEST', '网络 id 非法');
        const action = parts[2];
        if (method === 'GET' && action === 'export') return send(res, 200, service.exportNetwork(id, version));
        if (method === 'GET' && action === 'check') return send(res, 200, service.check(id, version));
        if (method === 'POST' && action === 'execute') {
          return send(res, 200, service.execute(id, (body as any).input, version));
        }
        if (method === 'POST' && action === 'verify') {
          return send(res, 200, service.verify(id, {
            version,
            maxCases: (body as any).maxCases,
            maxCompares: (body as any).maxCompares,
          }));
        }
        if (method === 'GET' && action === 'verify') return send(res, 200, service.verifyStatus(id, version));
        if (method === 'GET' && action === 'counterexample') return send(res, 200, service.counterexample(id, version));
        if (method === 'GET' && action === 'versions') return send(res, 200, { versions: service.versions(id) });
      }
      throw new ApiError('NOT_FOUND', `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ApiError) {
        const status =
          e.code === 'NOT_FOUND' ? 404 : e.code === 'LIMIT_EXCEEDED' ? 413 : 400;
        return send(res, status, { error: { code: e.code, message: e.message } });
      }
      send(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
    }
  });
}

export function startServer(service: Service, port: number): Promise<http.Server> {
  const server = createServer(service);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual}`);
      resolve(server);
    });
  });
}
