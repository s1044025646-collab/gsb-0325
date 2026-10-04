import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.js';
import { AppService } from './service.js';
import { Store } from './db.js';

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (service: AppService, params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown | Promise<unknown>;
}

const routes: Route[] = [
  { method: 'POST', pattern: /^\/api\/networks\/generate$/, paramNames: [], handler: (s, _, body) => {
      const b = body as { name?: string; wireCount?: number };
      return s.generate(String(b?.name ?? ''), Number(b?.wireCount));
    } },
  { method: 'POST', pattern: /^\/api\/networks$/, paramNames: [], handler: (s, _, body) => {
      const b = body as { name?: string; wireCount?: number; stages?: unknown };
      return s.importNetwork(String(b?.name ?? ''), { wireCount: Number(b?.wireCount), stages: b?.stages as never });
    } },
  { method: 'GET', pattern: /^\/api\/networks$/, paramNames: [], handler: (s) => s.listNetworks() },
  { method: 'GET', pattern: /^\/api\/networks\/(\d+)$/, paramNames: ['id'], handler: (s, p, _b, q) => s.exportNetwork(Number(p.id), parseVersion(q)) },
  { method: 'GET', pattern: /^\/api\/networks\/(\d+)\/versions$/, paramNames: ['id'], handler: (s, p) => s.listVersions(Number(p.id)) },
  { method: 'POST', pattern: /^\/api\/networks\/(\d+)\/versions$/, paramNames: ['id'], handler: (s, p, body) => {
      const b = body as { wireCount?: number; stages?: unknown };
      return s.addVersion(Number(p.id), { wireCount: Number(b?.wireCount), stages: b?.stages as never });
    } },
  { method: 'POST', pattern: /^\/api\/networks\/(\d+)\/check$/, paramNames: ['id'], handler: (s, p, _b, q) => s.check(Number(p.id), parseVersion(q)) },
  { method: 'POST', pattern: /^\/api\/check$/, paramNames: [], handler: (s, _, body) => s.checkCandidate(body as never) },
  { method: 'POST', pattern: /^\/api\/networks\/(\d+)\/execute$/, paramNames: ['id'], handler: (s, p, body, q) => {
      const b = body as { input?: unknown };
      return s.execute(Number(p.id), b?.input as number[], parseVersion(q));
    } },
  { method: 'GET', pattern: /^\/api\/runs\/(\d+)$/, paramNames: ['runId'], handler: (s, p) => s.getRun(Number(p.runId)) },
  { method: 'POST', pattern: /^\/api\/networks\/(\d+)\/verify\/advance$/, paramNames: ['id'], handler: (s, p, body, q) => {
      const b = (body ?? {}) as { caseBudget?: number | null; comparisonBudget?: number | null; restart?: boolean };
      return s.advanceVerify(Number(p.id), {
        caseBudget: b.caseBudget ?? null,
        comparisonBudget: b.comparisonBudget ?? null,
        restart: b.restart === true
      }, parseVersion(q));
    } },
  { method: 'GET', pattern: /^\/api\/networks\/(\d+)\/verify$/, paramNames: ['id'], handler: (s, p, _b, q) => s.getProgress(Number(p.id), parseVersion(q)) },
  { method: 'GET', pattern: /^\/api\/networks\/(\d+)\/counterexample$/, paramNames: ['id'], handler: (s, p, _b, q) => s.getCounterexample(Number(p.id), parseVersion(q)) }
];

function parseVersion(q: URLSearchParams): number | undefined {
  const v = q.get('version');
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError('INVALID_PARAM' as never, 'version 必须为正整数');
  }
  return n;
}

export function createApp(service: AppService): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = await readJson(req);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
        const data = await route.handler(service, params, body, url.searchParams);
        sendJson(res, 200, { ok: true, data });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未找到路由 ${req.method ?? ''} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, err.code === 'SORT_COUNTEREXAMPLE' ? 422 : 400, {
          ok: false,
          error: { code: err.code, message: err.message, details: err.details ?? null }
        });
      } else {
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err as Error).message } });
      }
    }
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveJson, rejectJson) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolveJson({});
      try {
        resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectJson(new AppError('INVALID_PARAM' as never, '请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectJson);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

export async function pickFreePort(preferred?: number): Promise<number> {
  if (preferred && preferred > 0) return preferred;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const portArg = process.argv.find((_, i, arr) => arr[i - 1] === '--port');
  const requestedPort = portArg ? Number(portArg) : Number(process.env.PORT ?? 0);
  const dbPath = process.env.BATCHER_DB ?? 'data/batcher.sqlite';

  const store = new Store(dbPath);
  const service = new AppService(store);
  const server = createApp(service);
  const port = await pickFreePort(Number.isFinite(requestedPort) ? requestedPort : 0);

  server.listen(port, '127.0.0.1', () => {
    console.log(`Batcher 后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据文件: ${dbPath}`);
    if (args.has('--print-port')) console.log(port);
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
