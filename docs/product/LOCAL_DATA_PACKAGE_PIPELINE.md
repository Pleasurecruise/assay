# Local Data Package Pipeline｜三案例本地数据方案

> Status: implemented for G01; G02/G03 package registration pending.
>
> Decision date: 2026-07-25.
>
> 本文是“自然语言解析完成后、既有审计开始前”这段链路的实现依据。
> 本文取代原 `DATA_RUNTIME_BRIEF.md` 的运行时 PandaData 取数方案。

## 1. 决策

竞赛运行时不再实时调用 PandaData。

赛前为三个确定案例准备三个不可变本地数据包。运行时：

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

## 2. 当前 main 与缺口

核对基线为 2026-07-25 的 GitHub 远端 `main`，提交 `25dfce3`。

当前 `main` 已经有：

- A2A 自然语言入口；
- Ark 自然语言解析；
- `StrategySpec` 校验、默认值和冻结；
- claims 识别；
- Claim Reproduction、五项检查、Moiré、判决和 Artifact；
- 一个 V9 golden case 的本地数据环境。

但当前数据包由 E2E 在请求前通过全局环境变量绑定，而不是由这次请求的策略
选择。因此真正缺少的是：

1. 显式的 strategy / claims 投影；
2. 轻量 `LocalDataPlan`；
3. 请求级本地数据包匹配；
4. 将匹配结果作为同一个 `dataRef` 接入既有审计。

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
  → 相同 descriptor identity
```

例如，将“宣称年化 18% 夏普 1.9”改成“宣称年化 30% 夏普 3.0”，只能改变
后续 claim comparison，不能改变数据。不同 A2A Task 的 `dataRef` 仍因绑定各自
`auditId` 而不同，但二者指向相同 packageId 和 descriptor 摘要。

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
- G01 的 `requiredCoverage` 先固定为已登记请求区间
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

每个包是赛前生成、运行时只读的目录，并带一个 manifest：

```ts
interface LocalDataPackageManifest {
  schemaVersion: "assay-local-data-package-v1";
  packageId: string;
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
  capabilities: Readonly<
    Record<Exclude<LocalDataRequirement, "strategy_signal_factors">, "ready" | "degraded">
  >;
  paths: {
    marketDataCache: string;
    v9CacheRoot: string;
    pitCacheRoot: string;
  };
  checksums: {
    marketData: string;
    v9Manifest: string;
    pitTree: string;
  };
}
```

这里有意采用“一份 descriptor 对应一个 case strategyKey”，不在一个包里维护
`supportedStrategyKeys` 列表。自然语言同义表达、claims 变化和审计内部的 costs 口径变化，
会先归一化为同一个 strategyKey；真正改变取数需求的策略必须拥有独立 descriptor，避免
宽泛别名意外命中同一数据。

当前包继续复用已经验证过的 V9 数据布局，因此不再重复引入一个可能漂移的
`dataVersion` 字符串：descriptor 原始字节摘要、V9 manifest 摘要、行情文件摘要和 PIT
快照树摘要共同绑定数据版本。

`capabilities` 使用状态对象而不是字符串数组，是因为当前 G01 对 `index_daily` 和
`comparator_factors` 存在已授权 degradation。`degraded` 表示包仍能按 V9 中记录的固定代理或
降级路径完成该检查，不等于声称原始数据完整。未出现的 capability 不能匹配。

当前 Python 审计引擎只实现沪深 300 price-momentum，因此 descriptor 也明确只接受
`000300.SH` 和上述六项能力；不能通过伪造 registry descriptor 提前宣称支持尚未实现的
G02/G03 universe 或 factor 数据。后续案例确定后，先同时扩展 TS/Python 契约和审计引擎，
再登记新包。

registry 根目录中：

- descriptor 只从 `local-packages/*.json` 读取，且文件名必须精确为
  `<packageId>.json`，保证 TypeScript resolver 与 Python dataRef loader 使用同一定位规则；
- `paths` 都是相对 registry 根目录的路径，禁止绝对路径、`..` 和符号链接逃逸；
- `marketData` 绑定行情 CSV 原始字节；
- `v9Manifest` 绑定 `<v9CacheRoot>/manifest.json` 原始字节；
- `pitTree` 只绑定
  `<pitCacheRoot>/index-weights/<indexSymbol>` 下的正式 PIT 快照，不包含
  `host-corrected-context-v1` 等审计运行后产生的派生文件。文件按 POSIX 相对路径 UTF-8
  字节排序，每项依次哈希路径、NUL 字节和文件原始字节。

resolver 只接受同时满足以下条件的包：

1. `strategyKey` 精确一致；
2. universe 精确一致；
3. `window` 精确一致；
4. coverage 覆盖 plan 的完整 `requiredCoverage`；
5. capabilities 为每项 requirement 声明 `ready` 或经 V9 验证的 `degraded`；
6. descriptor、路径、行情文件、V9 manifest 和 PIT 快照树摘要校验通过。

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

环境变量只可以配置数据包 registry 根目录，具体包仍由每个请求的
`LocalDataPlan` 决定。

竞赛生产配置必须彻底切断在线 PandaData 工具链：

- 不实例化 `PandaDataProcessGateway` 或 `SubprocessPandaDataAcquirer`；
- 不向审计 Agent 注册 `panda_*` 在线工具；
- 不读取 PandaData 凭证；
- 不以 PandaData readiness 作为服务启动条件；
- 只注册由 `dataRef` 驱动的本地数据工具。

## 6. dataRef 与后段接线

`dataRef` 是 host-only 的不可变引用：

- 一个任务只有一个 `dataRef`；
- 格式为
  `assay-local-data-v1:<auditId>:<packageId>:sha256-<descriptor原始字节摘要>`；
- 同时绑定任务、`packageId` 和 descriptor 摘要；
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

当前仓库只明确给出了一个完整案例，其余两个在确定前不做假设。

| Case | 输入与策略                                                                                                                    | Claims             | packageId          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------ |
| G01  | 沪深 300；20 日动量；月频；Top 50；等权；输入为“沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9” | 年化 18%、夏普 1.9 | 待数据包冻结时登记 |
| G02  | 待确认                                                                                                                        | 待确认             | 待登记             |
| G03  | 待确认                                                                                                                        | 待确认             | 待登记             |

每个案例实现前补齐：

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
| Resolution | 无匹配包                     | data package unavailable，不运行后段                      |
| Resolution | 多匹配                       | 配置错误，不任意选包                                      |
| Loading    | manifest、文件或摘要损坏     | fail closed，不在线抓取                                   |
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
| E2E                     | 从公开 A2A 入口运行三个登记案例                                                            |

不实现：

- 实时 PandaData acquisition；
- provider 请求编排、重试、分片和限流；
- PandaData 凭证读取、readiness 和 `panda_*` 在线工具；
- 通用数据仓库或任意策略支持；
- 后段审计重写。

## 10. 实施与验收顺序

1. 确认 G02、G03，并冻结三个数据包；
2. 实现投影、plan、manifest 和 resolver；
3. 接入 executor 和既有审计；
4. 运行局部单元测试与边界测试；
5. 全部代码接完后，只运行一次完整在线 A2A E2E。

最终 E2E：

```text
真实 A2A 请求
  → 真实 Ark 自然语言解析
  → 本地 plan 和 package resolution
  → 既有完整审计
  → A2A Artifact
```

需要：

- `ARK_API_KEY`；
- `ARK_MODEL_DEEPSEEK`；
- 三个本地数据包。

不需要 PandaData 凭证或运行时行情网络。

验收条件：

- 三个案例均从公开 A2A 入口完成；
- 同义输入解析到相同包；
- 只改 claims 时 plan、package 和 `dataRef` 不变；
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

实现完成后，再同步修改这些文档中仍将竞赛运行时数据层描述为在线 PandaData
的部分。在此之前，数据准备链路发生冲突时以本文为准。
