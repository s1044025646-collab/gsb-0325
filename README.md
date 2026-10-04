# Batcher 比较交换网络与零一反例核验后端

仅后端（HTTP API + CLI），使用 TypeScript、Node.js 与内置 SQLite（`node:sqlite`）实现，
在 Windows 本地直接运行。不依赖 Docker、WSL、付费服务或任何在线 API。

## 功能范围

- **Batcher 双调排序网络生成**：支持线路数 `1 / 2 / 4 / 8 / 16`。
  比较交换阶段由双调构造（粒度 `p`）与双调合并（跨度 `k` 递降）自行展开，
  每个阶段保留跨度与方向解释；排序过程绝不调用数组排序来伪造比较器轨迹。
- **阶段语义**：阶段内比较器并行读取该阶段开始时的旧值并写入结果，
  打乱同一阶段比较器的存储顺序不改变结果；阶段之间依次推进。
  最终方向统一为升序，内部阶段允许 `desc` 降序比较器；相等值不交换（不保证稳定性）。
- **自定义网络导入与独立核验**：核验器只执行定义本身，不信任生成器。
- **结构检查**：线路越界、同线比较、非法方向、同一阶段内重复占用线路、
  阶段数/比较器数/解释长度超限，均带错误码与定位（阶段序号、比较器序号）。
- **一次执行**：输出每阶段前/后值、发生交换的比较器、最终相邻逆序位置。
  输入必须长度正确且全部为有限数字（支持负数、小数、重复值；拒绝 `NaN`/`Infinity`）。
- **零一原理穷举核验**：按固定公开次序（输入索引的二进制位，低位映射线路 0）
  穷举全部 `2^线路数` 个二进制输入。失败时返回首个反例输入、逐阶段输出、
  错误输出与最终相邻逆序位置。
  - 只有穷举全部完成且无反例，状态才是 `verified`。
  - 案例预算或比较次数预算耗尽时状态为 `incomplete`，记录已检查数量、
    已用比较次数与下一未检查输入索引（`nextStartIndex`）。
  - 出现反例时状态为 `counterexample`。随机测试不构成证明，本系统不提供“随机通过即证明”。
  - 核验进度持久化在 SQLite 中，重启后从下一未检查输入继续，不漏案例、不重复计数。
- **版本管理**：修改比较器会创建新版本；旧版本的证明不会自动沿用到新版本，
  每个版本有独立的核验进度与反例。线路数在同一网络内不可变。
- **运行记录**：每次执行输入都会保存，可按运行 id 读取。

## 零一原理结论的前提（重要）

零一原理只对**比较网络**成立：每个比较器只做两条线路上的比较与条件交换。
在此前提下，网络能把全部 `2^n` 个零一输入排成升序，当且仅当它能把**任意**
可比较输入排成升序。若自定义网络包含非比较操作，零一结论不再适用。

## 非稳定性

比较器对相等值不交换，但网络本身不保证稳定排序；重复值之间不保留可追踪的身份。

## 预算状态

| 状态 | 含义 |
| --- | --- |
| `in_progress` | 已开始核验（含刚初始化） |
| `incomplete` | 预算耗尽，可用 `nextStartIndex` 续算 |
| `counterexample` | 发现排序反例，反例随进度保存 |
| `verified` | 全部 `2^n` 个输入穷举完成且无反例 |

## 环境要求

- Node.js >= 22.5（开发与实测环境为 Node.js 25.5，使用内置 `node:sqlite`，无需安装数据库）。
  运行时需要加 `--experimental-sqlite` 标志（npm 脚本已内置）。

## 安装、构建、测试、启动、演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行 node:test 全部测试
npm run demo      # 端到端演示（四线路正确网络/删比较器反例/八线路完整验证/预算暂停/重启续算/版本隔离）
npm start         # 启动 HTTP API；默认自动选择空闲端口，也可 --port 8080
```

数据默认保存在项目内 `data/batcher.sqlite`，可用环境变量 `BATCHER_DB` 覆盖。
端口可用 `--port` 参数或 `PORT` 环境变量指定；不指定则自动选择空闲端口，
启动日志会打印实际监听地址。

## CLI

```powershell
# 全局可选：--db data/batcher.sqlite
node --experimental-sqlite dist/cli.js generate --wires 4 --name my-4
node --experimental-sqlite dist/cli.js import --file examples/custom-4-broken.json --name broken-4
node --experimental-sqlite dist/cli.js list
node --experimental-sqlite dist/cli.js versions --id 1
node --experimental-sqlite dist/cli.js get --id 1 --version 1
node --experimental-sqlite dist/cli.js check --id 1
node --experimental-sqlite dist/cli.js check-file --file examples/custom-4-broken.json
node --experimental-sqlite dist/cli.js execute --id 1 --input "[4,1,3,2]"
# 不给预算即一次性穷举；--cases / --comparisons 用于分段推进
node --experimental-sqlite dist/cli.js verify --id 1 --cases 8
node --experimental-sqlite dist/cli.js verify --id 1
node --experimental-sqlite dist/cli.js progress --id 1
node --experimental-sqlite dist/cli.js help
```

## HTTP API

所有响应为 `{ "ok": true, "data": ... }`；错误为
`{ "ok": false, "error": { "code", "message", "details" } }`。
支持查询参数 `?version=n` 指定版本，缺省为最新版本。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/networks/generate` | 生成 Batcher 网络，body `{ "wireCount": 8, "name"?: string }` |
| POST | `/api/networks` | 导入自定义网络，body `{ "name", "wireCount", "stages" }` |
| GET | `/api/networks` | 列出网络 |
| GET | `/api/networks/:id` | 导出网络定义 |
| GET | `/api/networks/:id/versions` | 版本对照 |
| POST | `/api/networks/:id/versions` | 修改比较器，创建新版本 |
| POST | `/api/networks/:id/check` | 已入库网络结构检查 |
| POST | `/api/check` | 不入库检查候选定义 |
| POST | `/api/networks/:id/execute` | 执行输入，body `{ "input": [4,1,3,2] }` |
| GET | `/api/runs/:runId` | 读取一次执行记录 |
| POST | `/api/networks/:id/verify/advance` | 推进核验，body `{ "caseBudget"?: number, "comparisonBudget"?: number, "restart"?: boolean }` |
| GET | `/api/networks/:id/verify` | 读取核验进度 |
| GET | `/api/networks/:id/counterexample` | 读取反例（无则为 `null`） |

示例：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/networks/generate `
  -ContentType 'application/json' -Body '{"wireCount":8}'
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/networks/1/verify/advance `
  -ContentType 'application/json' -Body '{"caseBudget":64}'
Invoke-RestMethod http://127.0.0.1:<port>/api/networks/1/verify
```

## 错误码

| 代码 | 含义 |
| --- | --- |
| `INVALID_PARAM` | 参数错误（结构问题之外的通用参数问题，如预算不是正整数） |
| `UNSUPPORTED_SIZE` | 线路数不在 1/2/4/8/16 |
| `WIRE_OUT_OF_RANGE` | 比较器线路越界 |
| `SAME_WIRE_COMPARATOR` | 比较器两条线路相同 |
| `ILLEGAL_DIRECTION` | 方向不是 `asc`/`desc` |
| `DUPLICATE_WIRE_IN_STAGE` | 同一阶段内线路被重复占用 |
| `TOO_MANY_STAGES` / `TOO_MANY_COMPARATORS` / `EXPLANATION_TOO_LARGE` | 超过大小限制 |
| `INPUT_LENGTH_MISMATCH` | 输入长度与线路数不符 |
| `INPUT_NOT_FINITE_NUMBER` | 输入含非有限数字 |
| `NETWORK_NOT_FOUND` / `VERSION_NOT_FOUND` / `RUN_NOT_FOUND` | 资源不存在 |
| `SORT_COUNTEREXAMPLE` | 排序反例（核验状态中体现） |

参数错误与排序反例分开报告：前者是 HTTP 4xx + 结构错误码，
后者是核验进度中的 `counterexample` 状态与完整反例数据。

## 大小限制

- 阶段数上限 256；每阶段比较器上限 1024；比较器总数上限 65536；
  单阶段解释文本上限 20000 字符；名称上限 200 字符。

## 项目结构

```
src/
  generate.ts   Batcher 双调网络生成
  execute.ts    阶段并行语义执行
  verify.ts     零一穷举与预算推进
  validate.ts   输入与结构校验
  db.ts         SQLite 存储（网络/版本/运行/核验进度）
  service.ts    业务编排
  server.ts     HTTP API
  cli.ts        命令行
  demo.ts       端到端演示
test/
  core.test.ts  全部核心行为与持久化测试
examples/
  custom-4-broken.json
```

## 已知限制与合理假设

- 仅处理有限 `number` 数组；不做网页、逻辑门波形或大文件外部排序。
- 不追求最少比较器或最小深度网络。
- 零一穷举规模为 `2^n`，内置仅支持到 16 线路（65536 个案例）。
- 一线路网络没有阶段：任何单元素输入都已升序，核验共 2 个案例。
