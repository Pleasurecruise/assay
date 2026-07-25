# Local Data Package Pipeline｜三案例本地数据方案

> Status: implemented for the G01/G02/G03 golden fixtures. The three strategy
> identities share one canonical data owner and materialize as three runtime
> packages. `G01`/`G02`/`G03` are test labels, not runtime identifiers.
>
> Decision date: 2026-07-25.
>
> 本文是“自然语言解析完成后、既有审计开始前”这段链路的实现依据。
> 本文取代原 `DATA_RUNTIME_BRIEF.md` 的运行时 PandaData 取数方案。

## 1. 决策

竞赛运行时不再实时调用 PandaData。

仓库只提交一份完整、经过校验的共享数据源，再用 claims-free registry 登记三个
策略身份。部署时安装器把三个登记项物化成不可变 runtime package。运行时：

```text
A2A 自然语言
  → 模型填写 StrategySpec
  → 确定性校验并冻结
  → strategy / claims 投影
  → strategy 生成 LocalDataPlan
  → LocalDataPlan 匹配本地数据包
  → 生成唯一 dataRef
  → 既有 Claim Reproduction、五项检查、Moiré 和 Artifact
```

Intake 模型只负责把自然语言填入固定 schema，不参与数据路由或最终确定性
verdict。既有审计 Agent 继续按原流程工作。

## 2. 当前实现

当前链路已经把请求级数据选择接到既有审计之前：

- A2A 接收自然语言策略；
- Ark 只填写固定 `StrategySpec` schema；
- 普通代码完成校验、默认值、冻结以及 strategy / claims 投影；
- 确定性 planner 生成轻量 `LocalDataPlan`；
- resolver 按 plan 从 `.cache/assay/local-packages/` 唯一匹配并验证只读包；
- host 生成请求级 `dataRef`，交给 Claim Reproduction、五项检查、Moiré、
  判决和 Artifact 共用。

后段审计内容没有因为本地数据模式而重写。全局环境变量只配置 registry
根目录，不能指定某次请求应命中的 package。

相关代码：

- [natural-language-parser.ts](../../packages/intake/src/natural-language-parser.ts)
- [strategy-intake.ts](../../packages/intake/src/strategy-intake.ts)
- [production.ts](../../apps/a2a-server/src/production.ts)
- [v9-real-data.ts](../../tests/e2e/src/v9-real-data.ts)

## 3. 核心边界

### 3.1 StrategySpec 仍是唯一输入契约

完整 `StrategySpec` 继续包含 claims，并整体 freeze，用于审计对象、claim
comparison、证据绑定和 Artifact。

进入数据规划前只做一个运行时投影：

```ts
type CanonicalStrategyDefinition = Omit<CanonicalStrategySpec, "claims">;

function strategyForData(spec: CanonicalStrategySpec): CanonicalStrategyDefinition;
```

这不是第二套 StrategySpec。

### 3.2 Claims 不参与数据选择

必须满足：

```text
同一策略 + 不同 claims
  → 相同 strategyKey
  → 相同 LocalDataPlan
  → 相同 packageId
  → 相同 manifest identity
```

例如，将“宣称年化 18% 夏普 1.9”改成“宣称年化 30% 夏普 3.0”，只能改变
后续 claim comparison，不能改变数据。不同 A2A Task 的 `dataRef` 仍因绑定各自
`auditId` 而不同，但二者指向相同 packageId 和 manifest 摘要。

### 3.3 所有路由都是确定性代码

以下步骤都不能交给模型：

- strategy / claims 投影；
- 默认值与字段校验；
- `strategyKey` 计算；
- `LocalDataPlan` 生成；
- 数据包匹配；
- manifest 与文件校验；
- `dataRef` 生成。

不能按原始自然语言字符串匹配案例。等价表达应先解析成同一规范 strategy，
再得到同一数据包。

## 4. 轻量 LocalDataPlan

`LocalDataPlan` 只表达“需要什么数据”，不描述“如何在线抓取”。

```ts
interface LocalDataPlan {
  schemaVersion: "assay-local-data-plan-v1";
  strategyKey: string;
  indexSymbol: string;
  window: {
    start: string;
    end: string;
  };
  requiredCoverage: {
    start: string;
    end: string;
  };
  requirements: readonly LocalDataRequirement[];
}

type LocalDataRequirement =
  | "trade_calendar"
  | "pit_membership"
  | "adjusted_close"
  | "trade_status"
  | "index_daily"
  | "comparator_factors"
  | "strategy_signal_factors";
```

规则：

- `strategyKey` 由 data-relevant strategy 的规范 JSON 计算：排除 claims，也排除只影响
  回测执行、不改变市场输入的 costs。Claim Reproduction 将同一策略切换为无成本口径时，
  必须继续读取同一个数据包；
- requirements 根据 strategy 和既有审计需求由普通代码生成；
- requirements 顺序稳定、去重；
- `window` 是策略的冻结评估窗口；
- G01、G02、G03 的 `requiredCoverage` 都固定为已登记请求区间
  `2023-07-23..2026-07-23`。这是 V9 数据包的 provider anchor 到
  `asOf` 区间；首个实际交易日是 2023-07-24。既有审计对窗口初段的 regime
  历史不足继续使用 V9 中已经声明并验证的 degradation，不把不存在的盘前数据伪装成完整
  coverage；
- 后续案例若确实需要请求区间外的预热数据，应在冻结该案例时扩展
  `requiredCoverage`，而不是在运行时临时取数；
- input 未提供窗口时，竞赛运行配置与 E2E 共用固定 `evaluationAsOf`，并在
  freeze 前完成窗口默认化，不能回退到墙上时间；
- `LocalDataPlan` 不包含 PandaData 方法、分页、分片、重试、限流或凭证。

## 5. 本地数据包与匹配

Git 只提交一份完整数据 owner；`registry.json` 把三个 claims-free `DataPlan`
绑定到三个语义 runtime `packageId`，并都引用这一份 owner。`data:prepare`
验证一次 source bytes，再物化和验证三个运行时只读包。

Registry 条目精确定义为：

```ts
interface CaseDataPackageBinding {
  packageId: string;
  sourceDataPackageId: string;
  dataPlan: LocalDataPlan;
}

interface CaseDataPackageRegistry {
  schemaVersion: "assay-case-data-registry-v1";
  bindings: readonly CaseDataPackageBinding[];
}
```

Registry 使用 exact-key 校验，不允许 case label、claims、costs、原始自然语言
alias 或 fallback package。共享 source manifest 继续描述已取得的数据和明确
未取得的数据：

```ts
interface CaseIntegrity {
  kind: "file" | "tree";
  sha256: `sha256-${string}`;
  files: number;
  bytes: number;
}

interface CaseDataset {
  status: "ready" | "degraded";
  path: string | null;
  mode: string;
  reasonCode: string | null;
  assumptions: readonly string[];
  statistics: {
    rowCount: number;
    symbols: number;
    tradingDates: number;
  };
  integrity: CaseIntegrity | null;
}

interface CaseProvenance {
  path: string;
  integrity: CaseIntegrity;
}

interface CaseDataPackageManifest {
  schemaVersion: "assay-case-data-package-v1";
  packageId: string;
  generatedAt: string;
  strategyKey: string;
  universe: {
    indexSymbol: "000300.SH";
    membershipMode: "point_in_time";
  };
  window: {
    start: string;
    end: string;
  };
  coverage: {
    start: string;
    end: string;
    asOf: string;
  };
  state: "ready" | "degraded";
  assumptions: readonly string[];
  datasets: {
    equityDaily: CaseDataset;
    indexMembership: CaseDataset;
    historicalMemberDaily: CaseDataset;
    indexDaily: CaseDataset;
    comparatorFactors: CaseDataset;
  };
  provenance: {
    sourceSummary: CaseProvenance;
    fallbackRecords: CaseProvenance;
    preparationReport: CaseProvenance;
    incompleteAttempts: CaseProvenance | null;
  };
}
```

Source manifest 只负责数据字节和 provenance 完整性；runtime binding 只负责
`DataPlan → strategyKey → packageId`。二者不能重新混在一个宽泛
`supportedStrategyKeys` 列表里。自然语言同义表达、claims 变化和审计内部的
costs 口径变化先归一化为同一个 strategyKey；真正改变策略身份的定义必须有
独立 binding，但可以显式引用同一份 source bytes。

当前完整案例包中的真实行情没有压缩或抽样：

- `datasets/equity-daily.csv` 为 216,688 行，覆盖 300 只股票、727 个交易日，
  文件约 7.2 MiB；
- `datasets/index-membership/000300.SH/` 包含 37 个 PIT 快照；
- `provenance/fallback-records/` 与 source summary 共同保留 112 份 fallback
  provenance；
- `provenance/preparation-report.json` 记录准备和验收结果。

`historicalMemberDaily`、`indexDaily` 和 `comparatorFactors` 当前没有取得
正式可验证数据，因此 manifest 必须保持 `status: degraded`、`path: null`。
不能为了让目录看起来完整而在 `datasets/` 生成代理或占位文件。未晋级的抓取
payload 若确有保留价值，只能进入 `provenance/incomplete-attempts/`：

- historical-member 保留 366 个 payload 文件，只覆盖 79 只缺失股票中的 25 只；
- comparator 保留 4 个 payload 文件，共 33 行、仅 1 个日期；
- index-daily 没有取得 payload，因此不创建对应文件。

这些内容只是未晋级 provenance，不是 `datasets/` 或 runtime 输入，不能被
resolver 或 audit loader 当作可用数据发现。

当前 Python 审计引擎实现沪深 300 price-momentum，并从冻结 StrategySpec
读取任意受支持的正整数 momentum window 与 Top N。因此 14/20/26 日和
Top 30/50/70 复用相同行情与 PIT 是真实计算，不是 alias。不能通过 registry
伪造新的 universe、factor 数据，或把上述三个未取得数据集宣称为 ready。

仓库提交完整的安装/生成脚本，以及
`data/packages/<semantic-package-id>/` 下的完整案例数据包。真实行情、PIT
成分和已经晋级的 provenance 都属于案例包，不会因为 Git 提交而压缩、抽样
或删减。

Git 中的包结构为：

```text
data/packages/
├── registry.json
└── csi300-momentum-20d-monthly-top50-equal/
    ├── manifest.json
    ├── datasets/
    │   ├── equity-daily.csv
    │   └── index-membership/
    │       └── 000300.SH/
    └── provenance/
        ├── source-summary.json
        ├── fallback-records/
        ├── incomplete-attempts/
        └── preparation-report.json
```

全新 checkout 在直接启动 A2A 服务或部署前先执行：

```bash
# 从完整案例包生成 runtime registry，再运行 Python 语义校验
bun run data:prepare
```

`data:install` 先校验 canonical manifest 及其声明的所有 dataset/provenance
完整性，再确定性生成现有 runtime layout 和 runtime manifest。它不是原样复制。
`data:validate` 对生成后的 `.cache` 包执行离线 Python 语义校验；
`data:prepare` 是普通使用入口，精确定义为
`data:install && data:validate`：

```text
data/packages/registry.json + one shared source package
  → data:install（source 校验 + 三个 binding 的确定性转换）
  → .cache/assay/local-packages/<runtime-package-id> × 3
  → data:validate（离线 Python 语义校验）
  → ready
```

安装后的 runtime registry 为：

```text
.cache/assay/local-packages/
├── csi300-momentum-14d-monthly-top30-equal/
├── csi300-momentum-20d-monthly-top50-equal/
└── csi300-momentum-26d-monthly-top70-equal/
```

每个 runtime 目录都包含 `manifest.json`、`market-data.csv`、
`audit-support/` 和 `pit-membership/`。三个 manifest 的 packageId、
strategyKey 和 digest 不同；marketData、auditSupport、pitMembership 的
三类 checksum 必须分别完全相同。

转换规则是固定代码：

- `datasets/equity-daily.csv` → `market-data.csv`；
- `datasets/index-membership/000300.SH/` →
  `pit-membership/index-weights/000300_SH/`；
- `provenance/fallback-records/` → `audit-support/fallback-provenance/`；
- `provenance/preparation-report.json` 经路径转换后生成
  `audit-support/manifest.json`；
- 未来 optional dataset 只有 canonical 状态为 `ready` 时才复制到
  `audit-support/datasets/`；当前三项均为 degraded，因此不生成对应文件；
- `provenance/source-summary.json` 与
  `provenance/incomplete-attempts/` 在 canonical 阶段完成校验，但不复制进
  runtime package。

A2A resolver 与 Python loader 运行时都只读
`.cache/assay/local-packages/`，绝不把 `data/packages/` 当作 registry。
`.cache/assay/audit-output` 仍是独立可写的任务产物目录。

`e2e:checks` 会在在线流程前自动执行 `data:prepare`，无需手工预跑。

维护者需要更新基础数据或增加新的策略 binding 时，使用 `bun run data:rebuild`，其
精确定义是
`data:base && data:audit-support && data:package && data:prepare`，即全量
provider 重建共享 source 与 registry 后再安装并验证。如果完整 provider 缓存已经
存在，`bun run data:package` 从缓存重建共享 source 和确定性 registry；需要
runtime 副本时再执行 `data:prepare`。

Git 只排除运行无关的本地工作状态：`.cache` 下的 parts、断点、请求拆分、
tooling cache、uv cache、run logs、临时输出和 derived host-corrected 数据。
其中 comparator 的 11 个 `.split.json` 请求拆分和所有 `.parts` 都排除。
不能以“减小仓库”为由排除真实行情、正式 PIT 快照、已晋级 provenance，或
上述确为数据 payload 的 incomplete attempts。

canonical registry 中：

- `registry.json` 的 packageId 和 strategyKey 各自唯一；
- 三个 binding 的 `sourceDataPackageId` 指向同一个已校验 source 目录；
- Git 只能存在一份 `datasets/equity-daily.csv` 和一套 PIT/provenance 树；
- runtime registry 的每个一级目录对应一个 runtime package，目录名必须等于
  `packageId`；
- TypeScript resolver 与 Python loader 都只读取
  `<packageId>/manifest.json`；
- `paths` 都是相对该 package 目录的路径，禁止绝对路径、`..` 和符号链接逃逸；
- `equity-daily` 绑定完整行情 CSV 原始字节；
- `index-membership` 绑定整个 37 快照目录；
- `provenance` 绑定 source summary、112 份 fallback provenance 和 preparation
  report；
- 三个未取得数据集必须同时满足 `status: degraded` 与 `path: null`；
- `provenance/incomplete-attempts/` 是未晋级证据，不能被数据路径引用或作为
  runtime 输入；目录摘要按 POSIX 相对路径 UTF-8 字节排序，每项依次哈希路径、
  NUL 字节和文件原始字节。

resolver 只接受同时满足以下条件的包：

1. `strategyKey` 精确一致；
2. universe 精确一致；
3. `window` 精确一致；
4. coverage 覆盖 plan 的完整 `requiredCoverage`；
5. capabilities 为每项 requirement 声明 `ready` 或经 V9 验证的 `degraded`；
6. manifest、路径、完整行情文件、membership 树和 provenance 树摘要校验通过。

结果必须唯一：

| 匹配结果   | 行为                                          |
| ---------- | --------------------------------------------- |
| 一个有效包 | 返回绑定 package 和 manifest 摘要的 `dataRef` |
| 没有包     | 明确返回 unsupported / data unavailable       |
| 多个包     | 部署配置错误，拒绝运行                        |
| 包损坏     | fail closed，不改用其他包                     |

禁止：

- 让模型输出或选择 `packageId`；
- claims 参与匹配；
- 零匹配时选择默认包；
- 本地包失败后回退到实时 PandaData；
- 用全局环境变量直接指定本次请求的案例。

环境变量只可以配置已安装的数据包 registry 根目录（默认
`.cache/assay/local-packages`），具体包仍由每个请求的 `LocalDataPlan`
决定。它不能指向 Git 中的完整案例包目录来绕过安装边界。

竞赛生产配置必须彻底切断在线 PandaData 工具链：

- 不实例化 `PandaDataProcessGateway` 或 `SubprocessPandaDataAcquirer`；
- 不向审计 Agent 注册 `panda_*` 在线工具；
- 不读取 PandaData 凭证；
- 不以 PandaData readiness 作为服务启动条件；
- 只注册由 `dataRef` 驱动的本地数据工具。

本地包 readiness 与进程 liveness 分离。已安装的 runtime registry 缺失或校验
失败时：

- 服务进程仍然启动，`/healthz` 返回 `200`；
- Agent Card 仍可发现，`/readyz` 返回 `503`；
- 审计请求在 `local_data_resolve` 阶段进入 Task `FAILED`；
- 不运行后段检查，不生成审计 Artifact，也不在线回退。

这是基础设施失败，不能包装成 `UNVERIFIABLE`。`UNVERIFIABLE` 只用于输入不完整、
策略不支持或证据不足等正常业务结论。

## 6. dataRef 与后段接线

`dataRef` 是 host-only 的不可变引用：

- 一个任务只有一个 `dataRef`；
- 格式为
  `assay-local-data-v1:<auditId>:<packageId>:sha256-<manifest原始字节摘要>`；
- 同时绑定任务、`packageId` 和 manifest 摘要；
- 不写进模型 prompt；
- 不暴露绝对路径；
- Claim Reproduction、五项检查和 Moiré 共用它；
- 后段只能读取，不能替换或修改数据包。

唯一业务插入点是 `strategy_intake` 成功后、`claim_reproduction` 前：

```text
strategy_intake
  → local_data_plan
  → local_data_resolve
  → claim_reproduction
  → parallel_audit_handoff
  → moire
  → artifact
```

后段审计的公式、prompt、阈值、并行关系、判决和 Artifact 业务字段不变。

## 7. 三个案例登记

三个测试 fixture 已冻结：

| Case | 策略                                   | Claims             | packageId                                 |
| ---- | -------------------------------------- | ------------------ | ----------------------------------------- |
| G01  | 沪深 300；20 日动量；月末 Top 50；等权 | 年化 18%、夏普 1.9 | `csi300-momentum-20d-monthly-top50-equal` |
| G02  | 沪深 300；14 日动量；月末 Top 30；等权 | 年化 60%、夏普 2.3 | `csi300-momentum-14d-monthly-top30-equal` |
| G03  | 沪深 300；26 日动量；月末 Top 70；等权 | 年化 20%、夏普 0.9 | `csi300-momentum-26d-monthly-top70-equal` |

三者的回测窗口都是 `20230723..20260723`，rebalance 为
`monthly / close`，costs 为 `standard`。对应 strategyKey 分别为：

- `sha256-a9d796047db6ccb208f3d82df70287afbb50ddca1fd544f67718155a4dc1bddb`
- `sha256-9242fb1add11336293dd23983415e1493e25bdf924c06d04159b645b7f1c8195`
- `sha256-15a2f8c08d6a7f1e2f8013d1c663c325cf9666b30a06a5d8382aefcfc99f21f9`

`G01`、`G02`、`G03` 只用于测试用例、验收记录和预期结果。运行时不会先识别
`G01` 再跳转数据；它只会把自然语言归一化为 strategy，生成 `strategyKey` 和
`LocalDataPlan`，再匹配语义命名的 packageId。因此 packageId 不包含任何 G 标签。

新增案例前必须补齐：

- 标准自然语言输入和允许的等价表达；
- 规范 strategy 与 claims；
- 固定 `evaluationAsOf`；
- `strategyKey` 和 `LocalDataPlan`；
- 完整 `requiredCoverage`；
- `packageId`、manifest 和文件摘要；
- 预期审计路径与最终 golden Artifact。

claims 的变化不创建新数据包。

## 8. 失败语义

| 阶段       | 条件                         | 结果                                                      |
| ---------- | ---------------------------- | --------------------------------------------------------- |
| Intake     | 无法解析或缺少策略字段       | 沿用现有 `insufficient_information` / `unsupported_input` |
| Planning   | 策略不在三个案例支持范围     | `UNVERIFIABLE`，明确支持条件                              |
| Resolution | 无匹配包                     | Task `FAILED`，不运行后段、不生成 Artifact                |
| Resolution | 多匹配                       | Task `FAILED`，配置错误，不任意选包                       |
| Loading    | manifest、文件或摘要损坏     | Task `FAILED`，fail closed，不在线抓取                    |
| Audit      | 有效数据仍不足以支持某项结论 | 沿用既有 `insufficient_evidence`                          |

对外错误不得暴露凭证、绝对路径或原始异常。

## 9. 实施范围

| 层                      | 修改                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Intake                  | 保留现有 parser/validator/freezer；增加 claims-free strategy 投影                          |
| 数据规划                | 实现轻量 `LocalDataPlan`                                                                   |
| 本地数据层              | 实现 manifest registry、确定性 resolver、校验和 `dataRef`                                  |
| A2A production/executor | 移除在线 PandaData 初始化和工具注册；在 intake 和 claim reproduction 之间插入 plan/resolve |
| Python 审计入口         | 通过同一个 `dataRef` 读取本地包                                                            |
| E2E                     | 安装完整案例包后，从公开 A2A 入口运行当前登记案例                                          |

不实现：

- 实时 PandaData acquisition；
- provider 请求编排、重试、分片和限流；
- PandaData 凭证读取、readiness 和 `panda_*` 在线工具；
- 通用数据仓库或任意策略支持；
- 后段审计重写。

## 10. 实施与验收顺序

G01/G02/G03 的投影、plan、claims-free registry、resolver、共享 source、
runtime 安装和参数化验收链路已完成。三个案例不复制 provider bytes，也不扩张
当前数据能力。

每次新增案例的验收顺序：

1. 冻结 strategy、claims、`evaluationAsOf` 和数据需求；
2. 判断能否复用已验证 source；生成语义 runtime binding 并登记对应
   `strategyKey`；
3. 运行局部单元测试与边界测试；
4. 全部代码和包接完后，只运行一次完整在线 A2A E2E。

最终 E2E：

```text
e2e:checks
  → data:prepare（install + validate）
  → .cache/assay/local-packages
  ↓
真实 A2A 请求
  → 真实 Ark 自然语言解析
  → 本地 plan 和 package resolution
  → 既有完整审计
  → A2A Artifact
```

需要：

- `ARK_API_KEY`；
- `ARK_MODEL_DEEPSEEK`；
- `bun run data:prepare` 已从提交的完整案例包安装并语义校验本地 runtime registry。

不需要 PandaData 凭证或运行时行情网络。

验收条件：

- G01、G02、G03 在一个 A2A server lifecycle 中依次完成；
- 三个自然语言输入分别冻结为预期 StrategySpec 和独立 claims；
- 三个 strategyKey 和 runtime packageId 各自唯一，三类底层 checksum 相同；
- 同义输入解析到相同包；
- 只改 claims 时 plan、package 和 manifest identity 不变；不同 Task 的
  `dataRef` 仍使用各自 `auditId`；
- 未登记策略稳定失败，不误用数据；
- package coverage 覆盖完整 `requiredCoverage`；
- 数据包篡改会被拒绝；
- Claim Reproduction、五项检查、Moiré 和 verdict 都实际执行；
- 既有后段测试继续通过。

## 11. 文档关系

- [STRATEGY_SPEC.md](STRATEGY_SPEC.md)：完整输入契约，继续包含 claims；
- [A2A_SERVER.md](A2A_SERVER.md)：A2A Task 生命周期；
- [PIPELINE.md](PIPELINE.md)：完整审计流程；
- [ARCHITECTURE.md](ARCHITECTURE.md)：系统组件边界；
- [DATA_NOTES.md](DATA_NOTES.md)：PandaData 历史证据；
- [E2E_TESTING.md](../development/E2E_TESTING.md)：测试入口。

若其他文档仍把竞赛运行时数据层描述为在线 PandaData，或把
`data/packages/` 描述为 runtime registry，应以本文与
[E2E_TESTING.md](../development/E2E_TESTING.md) 的边界为准并同步修正。
