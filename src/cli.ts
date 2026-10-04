import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError } from './errors.js';
import { AppService } from './service.js';
import { Store } from './db.js';
import type { NetworkDef } from './types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

const HELP = `Batcher 比较交换网络 CLI

用法:
  node --experimental-sqlite dist/cli.js <命令> [参数]

全局:
  --db <路径>            SQLite 文件（默认 data/batcher.sqlite）

命令:
  generate --wires <1|2|4|8|16> [--name <名称>]
      生成 Batcher 双调排序网络并保存为新版本序列的首个版本。
  import --file <network.json> [--name <名称>]
      导入自定义网络 JSON（{ wireCount, stages }）。
  list                                   列出所有网络。
  versions --id <网络id>                 列出版本。
  get --id <网络id> [--version <n>]      导出网络定义（JSON）。
  check --id <网络id> [--version <n>]    结构检查。
  check-file --file <network.json>       不入库检查候选定义。
  execute --id <网络id> --input "[3,1,2]" [--version <n>]
      执行一次，输出每阶段值、交换比较器、最终逆序位置。
  verify --id <网络id> [--version <n>] [--cases <n>] [--comparisons <n>] [--restart]
      推进零一核验；不给预算则一次性穷举全部 2^线路数 个输入。
  progress --id <网络id> [--version <n>]
      读取核验进度与反例。
  help
`;

function loadDefFromFile(file: string): NetworkDef {
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8')) as { wireCount?: unknown; stages?: unknown };
  return { wireCount: Number(parsed.wireCount), stages: parsed.stages as NetworkDef['stages'] };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function flagInt(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagString(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError('INVALID_PARAM' as never, `--${key} 必须是整数`);
  return n;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = flagString(args.flags, 'db') ?? 'data/batcher.sqlite';
  const store = new Store(dbPath);
  const service = new AppService(store);

  try {
    switch (args.command) {
      case 'generate': {
        const wires = flagInt(args.flags, 'wires');
        if (wires === undefined) throw new AppError('INVALID_PARAM' as never, '必须提供 --wires');
        const out = service.generate(flagString(args.flags, 'name') ?? '', wires);
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      case 'import': {
        const file = flagString(args.flags, 'file');
        if (!file) throw new AppError('INVALID_PARAM' as never, '必须提供 --file');
        const name = flagString(args.flags, 'name') ?? `custom-${Date.now()}`;
        console.log(JSON.stringify(service.importNetwork(name, loadDefFromFile(file)), null, 2));
        break;
      }
      case 'list':
        console.log(JSON.stringify(service.listNetworks(), null, 2));
        break;
      case 'versions':
        console.log(JSON.stringify(service.listVersions(requiredId(args)), null, 2));
        break;
      case 'get':
        console.log(JSON.stringify(service.exportNetwork(requiredId(args), flagInt(args.flags, 'version')), null, 2));
        break;
      case 'check':
        console.log(JSON.stringify(service.check(requiredId(args), flagInt(args.flags, 'version')), null, 2));
        break;
      case 'check-file': {
        const file = flagString(args.flags, 'file');
        if (!file) throw new AppError('INVALID_PARAM' as never, '必须提供 --file');
        console.log(JSON.stringify(service.checkCandidate(loadDefFromFile(file)), null, 2));
        break;
      }
      case 'execute': {
        const inputRaw = flagString(args.flags, 'input');
        if (!inputRaw) throw new AppError('INVALID_PARAM' as never, '必须提供 --input JSON 数组');
        const input = JSON.parse(inputRaw) as unknown;
        if (!Array.isArray(input)) throw new AppError('INVALID_PARAM' as never, '--input 必须是数组');
        console.log(JSON.stringify(service.execute(requiredId(args), input as number[], flagInt(args.flags, 'version')), null, 2));
        break;
      }
      case 'verify':
        console.log(JSON.stringify(service.advanceVerify(requiredId(args), {
          caseBudget: flagInt(args.flags, 'cases') ?? null,
          comparisonBudget: flagInt(args.flags, 'comparisons') ?? null,
          restart: args.flags.restart === true
        }, flagInt(args.flags, 'version')), null, 2));
        break;
      case 'progress':
        console.log(JSON.stringify(service.getProgress(requiredId(args), flagInt(args.flags, 'version')), null, 2));
        break;
      case 'help':
      case '':
        console.log(HELP);
        break;
      default:
        console.error(`未知命令: ${args.command}\n`);
        console.log(HELP);
        process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } }, null, 2));
      process.exitCode = 1;
    } else {
      console.error((err as Error).stack ?? (err as Error).message);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function requiredId(args: ParsedArgs): number {
  const id = flagInt(args.flags, 'id');
  if (id === undefined) throw new AppError('INVALID_PARAM' as never, '必须提供 --id');
  return id;
}

main();
