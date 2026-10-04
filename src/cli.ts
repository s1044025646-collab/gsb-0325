// CLI 入口：generate / import / check / run / verify / counterexample / versions / export / serve / demo
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './db';
import { Service } from './service';
import { startServer } from './server';
import { generateBatcher, runNetwork } from './core';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.BATCHER_DB ?? path.join(DATA_DIR, 'batcher.db');

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(rest[i]);
    }
  }
  return { cmd, positional, flags };
}

function out(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  const service = new Service(new Store(DB_PATH));
  const id = positional[0] !== undefined ? Number(positional[0]) : NaN;
  const version = flags.version !== undefined ? Number(flags.version) : undefined;

  switch (cmd) {
    case 'generate': {
      const lines = Number(flags.lines ?? positional[0]);
      out(service.generate(lines));
      break;
    }
    case 'import': {
      const file = flags.file ?? positional[0];
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      const target = flags.network !== undefined ? Number(flags.network) : undefined;
      out(service.importNetwork(body, target));
      break;
    }
    case 'check':
      out(service.check(id, version));
      break;
    case 'run': {
      const input = flags.input
        ? (JSON.parse(flags.input) as number[])
        : (JSON.parse(fs.readFileSync(flags.file!, 'utf8')) as number[]);
      out(service.execute(id, input, version));
      break;
    }
    case 'verify':
      out(service.verify(id, {
        version,
        maxCases: flags['max-cases'] !== undefined ? Number(flags['max-cases']) : undefined,
        maxCompares: flags['max-compares'] !== undefined ? Number(flags['max-compares']) : undefined,
      }));
      break;
    case 'verify-status':
      out(service.verifyStatus(id, version));
      break;
    case 'counterexample':
      out(service.counterexample(id, version));
      break;
    case 'versions':
      out(service.versions(id));
      break;
    case 'export':
      out(service.exportNetwork(id, version));
      break;
    case 'serve': {
      const port = flags.port !== undefined ? Number(flags.port) : Number(process.env.PORT ?? 0);
      await startServer(service, port);
      return; // 保持进程存活
    }
    case 'demo':
      demo();
      break;
    default:
      console.log(`用法: node dist/cli.js <命令> [参数]
  generate --lines 4|8|16|2|1        生成 Batcher 双调排序网络
  import --file net.json [--network ID]   导入网络（指定 network 则创建新版本）
  check <id> [--version N]           结构检查
  run <id> --input "[3,1,2,0]"       执行输入，输出每阶段值与交换
  verify <id> [--max-cases N] [--max-compares M]   推进零一核验
  verify-status <id>                 查看核验进度
  counterexample <id>                读取反例
  versions <id>                      版本对照
  export <id> [--version N]          导出网络
  serve [--port N]                   启动 API（默认自动选空闲端口）
  demo                               四线反例演示 + 八线完整验证`);
  }
  service.store.close();
}

function demo(): void {
  console.log('== 1. 生成四线路 Batcher 网络并完整验证 ==');
  const good = generateBatcher(4);
  const svc = new Service(new Store(':memory:'));
  const g = svc.importNetwork(good);
  console.log(`阶段数=${good.stages.length} 比较器数=${good.stages.reduce((n, s) => n + s.comparators.length, 0)}`);
  console.log(JSON.stringify(svc.verify(g.networkId, {})));

  console.log('\n== 2. 删除一个关键比较器，得到反例 ==');
  const broken = generateBatcher(4);
  const last = broken.stages[broken.stages.length - 1];
  const removed = last.comparators.pop();
  console.log(`删除末阶段比较器: ${JSON.stringify(removed)}`);
  const b = svc.importNetwork(broken);
  console.log(JSON.stringify(svc.verify(b.networkId, {})));
  console.log('反例:', JSON.stringify(svc.counterexample(b.networkId), null, 2));

  console.log('\n== 3. 生成八线路网络并完整验证 ==');
  const eight = generateBatcher(8);
  const e = svc.importNetwork(eight);
  console.log(JSON.stringify(svc.verify(e.networkId, {})));

  console.log('\n== 4. 样例执行 [5,-1,2,2]（四线正确网络）==');
  console.log(JSON.stringify(runNetwork(good, [5, -1, 2, 2]), null, 2));
  svc.store.close();
}

main().catch((e) => {
  if (e && e.code) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
