# Batcher 比较交换网络与零一反例核验后端

纯后端项目（TypeScript + Node.js + SQLite），实现静态比较交换网络的构建、执行与基于**零一原理**的核验。只做 API 与 CLI，无网页、无波形、无外部排序。Windows 本地运行，不依赖 Docker / WSL / 外部服务；SQLite 使用 Node 内置 `node:sqlite`，无需原生编译。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口，--port N 指定）
npm run demo       # 演示：四线验证 -> 删比较器出反例 -> 八线完整验证
```

数据目录为项目内 `data/`（可用环境变量 `BATCHER_DB` 覆盖数据库路径），端口用 `--port` 或 `PORT` 配置，默认 `0`（操作系统分配空闲端口，启动后打印实际端口）。

## CLI

```
node dist/src/cli.js generate --lines 8        # 生成 Batcher 网络（1/2/4/8/16）
node dist/src/cli.js import --file net.json [--network ID]
node dist/src/cli.js check <id> [--version N]  # 结构检查
node dist/src/cli.js run <id> --input "[3,1,2,0]"
node dist/src/cli.js verify <id> [--max-cases N] [--max-compares M]
node dist/src/cli.js verify-status <id>
node dist/src/cli.js counterexample <id>
node dist/src/cli.js versions <id>             # 版本对照
node dist/src/cli.js export <id> [--version N]
node dist/src/cli.js serve [--port N]
```

## HTTP API

- `POST /networks/batcher` `{lines}`：生成 Batcher 双调排序网络
- `POST /networks/import`、`POST /networks/:id/import`：导入自定义网络（后者创建新版本）
- `GET /networks/:id/check?version=`：结构检查
- `POST /networks/:id/execute` `{input}`：执行输入，返回每阶段值、交换的比较器、相邻逆序位置
- `POST /networks/:id/verify` `{maxCases?,maxCompares?}`：推进零一核验（受预算约束）
- `GET /networks/:id/verify?version=`：核验进度
- `GET /networks/:id/counterexample?version=`：读取反例
- `GET /networks/:id/versions`：版本对照（含各版本核验状态）
- `GET /networks/:id/export?version=`：导出网络

错误统一为 `{"error":{"code","message"}}`，参数错误（4xx：`INVALID_LINES` / `LINE_OUT_OF_RANGE` / `SELF_COMPARE` / `INVALID_DIRECTION` / `STAGE_CONFLICT` / `INPUT_LENGTH` / `INPUT_NOT_FINITE` / `LIMIT_EXCEEDED` / `NOT_FOUND` / `BAD_REQUEST`）与排序反例（核验状态 `failed` + 反例数据）分开报告。

## 网络模型与阶段语义

- 网络 = 固定数量有序线路 + 若干阶段；比较器 `{a, b, dir}`，`dir` 为 `asc`（小值写低线）或 `desc`。
- **阶段内并行**：同一阶段所有比较器读取该阶段开始时的旧值，写入阶段末的新值；同阶段线路不得重复占用（`STAGE_CONFLICT`）。阶段之间依次推进。打乱同阶段比较器的存储顺序不改变结果（有测试保证）。
- 结构不随输入改变；只处理数值数组。输入必须长度正确且全为有限数字，支持负数与重复值；**不要求稳定排序**，相等值不产生交换。
- Batcher 生成器采用双调构造（左半升、右半降）+ 双调合并，每个比较器保留 `span`（跨度）与 `phase`（build/merge）解释，最终方向统一升序，中间阶段含降序比较器。生成器与核验器完全独立，核验不信任生成器。

## 零一原理核验（前提与限制）

- **前提**：零一原理——一个比较器网络能排序任意数值输入，当且仅当它能排序全部 2^n 个 0/1 输入。本核验结论仅在该原理与"网络为静态比较器网络、阶段语义如上"的假设下成立。
- 穷举次序公开固定：`caseIndex` 从 0 到 2^n − 1，线路 `i` 的取值为 `(caseIndex >> i) & 1`。
- 状态机：`verifying`（未完成，含预算暂停）→ `verified`（**全部**案例通过，`checked == 2^lines`）或 `failed`（发现反例）。只有穷举完成才标 `verified`；达到案例/比较次数预算时保持 `verifying` 并记录 `checked` 与 `nextIndex`，随机或部分测试通过不构成证明。
- 进度存于 SQLite，事务更新；重启后从 `nextIndex` 继续，不漏案例、不重复计数。失败时记录首个反例输入、逐阶段值与最终相邻逆序位置。
- 修改比较器（再次 import 到同一网络）创建新版本，核验进度按版本隔离，旧版本证明保留但不自动沿用。
- 线路数 1：零阶段网络，2 个案例，平凡通过。空阶段合法。不追求最少比较器或最小深度。
- 资源上限：阶段数 ≤ 128、比较器 ≤ 1024、网络描述 ≤ 256KB。

## 测试覆盖

`npm test`（14 项）：1/2/4/8/16 全线路零一穷举、案例总数恰为 2^n、与独立 `Array.sort` 对照（负数/重复值/降序）、手写四线网络核对阶段语义、同阶段乱序不变性、结构错误分类、线路数一行为、删比较器反例、预算暂停与续算、重启续算（临时文件库）、版本隔离、参数错误与反例分离。

## 已知限制

- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 相等元素（含 `0` 与 `-0`）的相对位置不保证，因为不制造相等值交换。
- 仅升序最终输出；降序需求可通过反转输入/输出在调用方实现。
