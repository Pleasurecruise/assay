# Backtester｜自建向量化回测引擎设计（ADR）

> 状态：设计已拍板（2026-07-24），随实现修订；决策可被推翻，推翻时保留原条目并记录变更理由。
> 输入契约见 [STRATEGY_SPEC.md](STRATEGY_SPEC.md)；检查方需求见 [CHECKS.md](CHECKS.md)；证据工件命名对齐 [VERDICT_SPEC.md](VERDICT_SPEC.md)；数据边界见 [../architecture/DATA_ACCESS.md](../architecture/DATA_ACCESS.md)。

## 0. 定位

- **内部基础设施**：五个检查 agent 经工具调用引擎；A2A 调用方与评审只见其产出的证据工件，不见引擎本身。
- **存在的三重理由**：
  1. 工程：官方回测 Skill 无已验证的结构化输出契约（DATA_NOTES §3）；
  2. 方法论：实现独立——比赛生态中被审策略多出自官方生产线，共享引擎会使引擎自身行为成为审计盲区；自建使"对方引擎的行为"也进入被检验范围；
  3. 预算：单变体毫秒级的向量化吞吐，是 20 分钟内完成 30+ 反事实实验的前提。
- **两条纪律**：引擎只使用行业标准算法，不发明数学（创新在架构，不在算法）；LLM 不产出任何审计数字——引擎输入输出全部确定性。五个检查 agent 依据 D10 的预声明准则独立作出 `conclusion` / `confidence`，主机不设置结论层 evaluator，也不改写检查结论。

## 1. 设计决策

格式：问题 / 选项 / 选择 / 理由 / 影响面（/ 行业锚点）。

### D1 执行时点语义

- **问题**：信号在哪天计算、按哪天什么价格成交、收益自何时起计。三个时点不钉死即可能引入前视或零延迟理想化。
- **选项**：A. t 收盘信号 + t 收盘成交（业界常见，含零延迟理想化）；B. t 收盘信号 + t+1 收盘成交；C. t+1 开盘成交（需依赖 open 字段）。
- **选择**：默认 **B**——调仓日 t（月/周最后交易日，`get_trade_cal`）收盘后，用截至 t 收盘的数据计算信号；t+1 交易日按收盘价成交；新组合收益自 t+1 收盘起计。保留 `execution: "next_close" | "same_close"` 开关（same_close 即选项 A，用于复现采用该约定的宣称）。
- **理由**：审计工具自身必须无前视、无同时性理想化；开关把"执行约定敏感度"变成免费的证据维度。
- **影响面**：STRATEGY_SPEC `rebalance.at` 语义澄清（已同步修订）；全部检查的变体统一继承此约定。
- **锚点**：zipline 默认订单在下单 bar 的**次 bar** 按滑点模型成交（[教程](https://zipline.ml4trading.io/beginner-tutorial)、[slippage 实现](https://zipline.ml4trading.io/_modules/zipline/finance/slippage.html)）——即选项 B；backtrader broker 提供 [`coc`（cheat-on-close）开关](https://www.backtrader.com/docu/broker/)允许当日收盘成交，命名上明示这是"作弊"——即我们 `execution: "same_close"` 开关的直接行业先例，连定性都是现成的。

### D2 复权与数据面板

- **问题**：分红送股造成价格跳变（不复权会把除权日当暴跌）；30+ 变体如何在预算内共享数据。
- **选择**：**后复权收盘价面板**（close × 累计复权因子）计算收益。审计开始时一次性取全：股票池为回测窗口（含信号回看余量与时间平移余量）内全部 PIT 成分的**并集**；所有变体共享同一面板；同族信号（如不同 window 的动量）由同一面板移位计算，不逐变体重取重算。
- **理由**：复权收益与 PIT 股票池是教科书共识（幸存者偏差为经典错误）；取数是全流程最慢环节，面板复用是 20 分钟预算成立的前提。
- **影响面**：Data Layer 缓存键设计；Intake 预算校验需把回看与平移余量计入 `get_market_data` 的 5 年上限。
- **锚点**：PIT 纪律同 zipline Pipeline / qlib 数据层；向量化面板同 vectorbt 路线。

### D3 可交易性

- **问题**：调仓日选中的股票停牌/涨跌停，实际买不进怎么办。
- **选择**：引擎实现**停牌掩码**——调仓日不可交易（`get_trade_list` 缺席或成交额为 0）的股票从候选剔除、按信号排序顺位递补，并输出 `skippedTargetCount` 指标。**涨跌停不建模**，写入报告的假设与局限。
- **理由**：引擎保持薄；现实性缺口以披露解决而非建模解决。**有意背离行业做法并公开**：完整建模可参照 rqalpha 模拟撮合模块（[rqalpha_mod_sys_simulation](https://github.com/ricequant/rqalpha/blob/master/rqalpha/mod/rqalpha_mod_sys_simulation/README.rst)，内置涨跌停/停牌撮合约束）与 vnpy，列为后续增强。
- **影响面**：cost-stress 与 data-availability 检查解读换手与可得性时须知悉掩码行为。

### D4 工具粒度

- **问题**：LLM 检查 agent 与引擎之间的接口切多粗。
- **选择**：单一粗粒度工具 **`run_experiment`**，一次调用执行一个已由主机编译进 `AuditPlan` 的预声明实验（§3）；**严禁逐变体调用，也严禁 agent 自行扩展 grid**。
- **理由**：细粒度 = 每变体一次工具往返（延迟、费用、LLM 出错面各乘 30）；粗粒度使主机在分支启动前确定性冻结实验，LLM 只选择已批准的 `experimentId` 并解读结果——"LLM 是审计判断者，计算是仪器"。
- **影响面**：检查 agent 的工具 schema只暴露 `auditId` 与 `experimentId`；主机在调用 agent 前展开并计数所有变体，工具侧以冻结的 `AuditPlan` 复核身份、归属和配额。

### D5 输出工件

- **问题**：只返回汇总指标，还是保留中间产物。
- **选择**：每次实验落盘三类工件并返回引用——变体级汇总表、**每变体日收益序列**、逐调仓日持仓（含 skipped 记录）。引用命名对齐 VERDICT_SPEC：`artifact:backtest/parameter-grid`、`artifact:backtest/cost-stress`、`artifact:backtest/regime-split` 等。
- **理由**：sourceRefs 必须有可复算实物；环境切片与 Moiré 判别实验（如"分环境重算参数网格"）成为对落盘序列的**确定性后处理，不需重新回测**。
- **影响面**：工件存储（本地文件即可，键含 auditId）；Moiré 本批不运行，只保留后续接入同类工件的接口。
- **锚点**：zipline→pyfolio 生态的分层先例——引擎输出 returns / positions / transactions 三序列，[pyfolio 事后消费](https://pyfolio.ml4trading.io/api-reference.html)做全部分析（backtrader 亦内置输出同名三元组的 [PyFolio analyzer](https://www.backtrader.com/docu/analyzers/pyfolio/)）。我们采纳同一分层，把用途从绩效归因换成证据链与 Moiré 后处理。

### D6 服务边界

- **问题**：回测器起独立服务，还是并入既有 Python 进程。
- **选择**：并入 `services/panda-adapter` 所在进程（概念升级为 quant-engine：数据读取 + 实验执行两组工具，共用一套 transport）。
- **理由**：引擎最重的依赖是数据面板，面板紧邻 SDK；跨进程传 DataFrame 正是 DATA_ACCESS.md 极力避免的。**本决策依据本仓库现状，非普适结论。**
- **影响面**：DATA_ACCESS.md 规划的 transport 里程碑同时服务两组工具。

### D7 已知答案测试

- **问题**：审计的仪器自身如何被证明正确。
- **选择**：合成数据 + 手算可知答案的测试族（§5），与引擎**同优先级交付**；全部不依赖 PandaData 凭证，CI 可跑。
- **理由**：五项检查共享此仪器，仪器误差是全系统的相关误差；known-answer / golden 测试为软件工程共识。
- **影响面**：引擎任何改动以测试族回归验收。

> D8 组合状态机与 D9 全量计算口径留待后续批次冻结；当前竖切先由引擎常量和代码注释承载，不在本 ADR 扩展尚未进入运行路径的设计。

### D10 首批两项检查的预声明评判准则

- **问题**：五个检查 agent 必须保留独立判断权，但不能在看到结果后临时发明标准。
- **选择**：发布 `GUIDELINE_VERSION = "1.0.0"`。下表是**倾向性准则而非确定性裁决器**；agent 必须引用引擎或数据工件中的实际数值作出结论，主机只校验证据非空与 `sourceRefs` 可解析，不计算、不改写 `conclusion` / `confidence`。

共同规则：

1. 命中某行表示该检查**倾向**相应结论；落在多个指标的不同档位时，agent 结合样本量、绝对收益、置信区间与数据质量独立判断，不能把表格机械投票。
2. 若结论偏离指标所落档位，结果必须设置 `deviatedFromGuideline: true`，并在 `evidence` 中给出足以支持偏离的数值化理由（例如样本量、置信区间、绝对收益差或缺失率）及可解析 `sourceRefs`；纯文字理由不合格。未偏离时该可选字段省略或为 `false`。
3. 准则版本写入 `AuditPlan`、agent system prompt 与最终 provenance。修改指标定义或边界必须升级版本，不能只改 prompt。本批只发布 parameter robustness 与 cost stress；其余三项检查的表格后补。

#### Parameter robustness（`param-robustness`）

`neighborhoodSharpeRetention = 非基线预声明变体 Sharpe 中位数 / 基线 Sharpe`（基线 Sharpe 必须为正；否则报告原值并由 agent 数值化说明）。

| 参考区间            | 倾向结论                 |
| ------------------- | ------------------------ |
| `>= 70%`            | `pass`                   |
| `>= 40%` 且 `< 70%` | `pass_with_reservations` |
| `< 40%`             | `fail`                   |

#### Transaction cost stress（`cost-stress`）

`breakEvenCostMultiplier` 是使年化净收益归零的总交易成本相对 `normal` 场景总费率的倍数；`netReturnRetention = normal 年化净收益 / zero 年化收益`。当 zero 年化收益不为正时，比例不具解释力，agent 必须同时报告绝对净收益。

| 参考区间                                                                                    | 倾向结论                 |
| ------------------------------------------------------------------------------------------- | ------------------------ |
| `breakEvenCostMultiplier >= 2.0` 且 `netReturnRetention >= 70%`                             | `pass`                   |
| 未触发 fail，且任一指标落在 `1.0–<2.0` 或 `40%–<70%`                                        | `pass_with_reservations` |
| `breakEvenCostMultiplier < 1.0`，或 `netReturnRetention < 40%`，或 normal 年化净收益 `<= 0` | `fail`                   |

fail 结果还必须声明本检查拥有的 `failureMode`，供 VERDICT_SPEC §2 的 fail 优先规则查静态恢复表；主机不从数字反推模式：

| Check              | Allowed failure modes                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| `param-robustness` | `localized_parameter_fragility` / `pervasive_parameter_fragility`                  |
| `cost-stress`      | `turnover_driven_cost_failure` / `negative_net_return_under_minimum_feasible_cost` |

- **理由**：这套安排保留五方独立判断与互证叙事，同时让每次判断可追溯到检查开始前已公开的量尺。
- **影响面**：本批两个 agent system prompt 必须逐字包含其对应表格、指标定义和偏离规则；主机继续采用 fail 优先的最终判决政策，但不得借此改写 agent 的检查级结论。

## 2. 贯穿能力：复刻对方错误

审计第一步是复现宣称，而复现常需**故意采用对方的错误假设**：

- `universeMode: "pit" | "asOf"`——`pit` 为审计标准（逐调仓日 `get_index_weights(t)`）；`asOf` 以单一日期的成分名单套用全历史，用于复现幸存者偏差型宣称；
- `costs: "none"` 复现不计成本的宣称（四档定义见 STRATEGY_SPEC）；
- `execution: "same_close"` 复现零延迟约定（D1）。

流程：先在对方假设下对齐宣称数字（**基线复算**）→ 逐项换为正确假设 → 每换一项产生一个"修正后数字"（如 18% → 13.8%）。复现失败本身即是发现。

## 3. 工具契约草案：run_experiment

协议层 camelCase；本批只冻结 `grid` 与 `cost_ladder` 两种实验。主机在启动检查 agent **之前**把完整变体列表写入 `AuditPlan`，agent 只能调用已批准的 `experimentId`。

冻结的 `AuditPlan` 条目（主机内部）：

```jsonc
{
  "id": "param-grid-v1",
  "checkId": "param-robustness",
  "kind": "parameter_grid",
  "variantCount": 45,
  "variants": [
    {
      "id": "w14-n30-s-6",
      "signalWindow": 14,
      "topN": 30,
      "windowShiftMonths": -6,
    },
    // 主机已确定性展开其余 44 项
  ],
}
```

`cost_ladder` 同样冻结为一个独立条目，公开变体 ID 固定为 `normal`、`zero`、`double`、`adverse`，不得由 agent 临时增删。它们是审计实验的**倍率/覆盖层**，不是 `StrategyCostModel` 的 `none | standard | realistic | pessimistic` 枚举别名：计划先解析策略的基础成本模型，再用版本化的 ladder override 生成四个场景，避免把策略输入枚举与审计实验枚举混为一类。

agent 可见请求：

```json
{
  "auditId": "audit_01",
  "experimentId": "param-grid-v1"
}
```

成功响应：

```jsonc
{
  "auditId": "audit_01",
  "experimentId": "param-grid-v1",
  "kind": "parameter_grid",
  "variants": [
    {
      "variantId": "w20-n50-s0",
      "params": { "window": 20, "topN": 50, "windowShiftMonths": 0 },
      "annualReturn": 0.18,
      "sharpe": 1.9,
      "maxDrawdown": -0.23,
      "annualTurnover": 12.1,
      "skippedTargetCount": 3,
      "dailyReturnsRef": "artifact:backtest/parameter-grid/v00/daily-returns",
      "holdingsRef": "artifact:backtest/parameter-grid/v00/holdings",
    },
  ],
  "summaryRef": "artifact:backtest/parameter-grid",
  "dataProvenance": { "panelHash": "…", "dataAsOf": "…" },
}
```

`cost_ladder` 响应沿用同一外壳，以公开场景 ID 标识每个结果；底层 `baseCostModel` 单独返回，并在顶层增加准则所需的派生值：

```jsonc
{
  "auditId": "audit_01",
  "experimentId": "cost-ladder-v1",
  "kind": "cost_ladder",
  "baseCostModel": "standard",
  "variants": [
    { "variantId": "normal", "annualReturn": 0.13 },
    { "variantId": "zero", "annualReturn": 0.18 },
    { "variantId": "double", "annualReturn": 0.08 },
    { "variantId": "adverse", "annualReturn": 0.04 },
  ],
  "breakEvenCostMultiplier": 2.3,
  "netReturnRetention": 0.72,
  "summaryRef": "artifact:backtest/cost-stress",
  "dataProvenance": {
    "panelHash": "…",
    "dataAsOf": "…",
    "costOverrideVersion": "…",
  },
}
```

规则：

1. 工具按 `auditId + experimentId` 从冻结的 `AuditPlan` 取回 spec、overrides 和显式变体；请求不存在、归属不符或检查方无权调用时拒绝，绝不接受 agent 自带 grid。
2. `grid` 一次返回全部预声明变体；超过 45 项拒绝并返回预算耗尽语义，不静默截断。`cost_ladder` 一次返回固定四场景及归零临界倍数。
3. 每个 `pass`、`pass_with_reservations` 或 `fail` 结论都必须把响应中的 `summaryRef` 放入 evidence `sourceRefs`；这使 fail 优先判决仍建立在可解析证据上，而不是主机猜测 agent 的理由。
4. 同一请求幂等；缓存键至少包含冻结 spec 哈希、experimentId、显式变体与面板哈希。

## 4. 计算语义细则

- **调仓流水线**：`universe(t)`（按 universeMode）→ 停牌掩码 → 信号截面排序 → topN 等权目标组合 → 与现组合差集计换手 → 成本扣减 → 日收益累计。
- **指标口径**（小决策，建议默认，实现 PR 中确认）：年化按 252 交易日；夏普 = 日收益均值/标准差 × √252，rf = 0；maxDD 按累计净值；年换手 = 单边成交额 / 平均净值，年化。
- **环境划分（无前视）**：趋势 = 指数 t-1 收盘相对其 200 日均线的位置；波动 = 指数过去 60 日已实现波动的滚动分位。阈值参数集中定义，未来 MOIRE_SPEC 复用同一份。

## 5. 已知答案测试清单

1. **恒定增长单股**：策略持有它，区间收益 = 复利精确值；
2. **双股轮动**：构造两股动量交替领先，换仓日期与换手手算可知；
3. **成本等式**：同一策略有/无成本之差 = 换手 × 费率（精确等式）；
4. **PIT 断言**：合成一次成分变更，断言纳入日前不可入选、剔除日后不可保留；
5. **无前视守卫**：在 t+1 注入极端行情，断言 t 日选股与权重不变；
6. **停牌递补**：调仓日令目标股停牌，断言顺位递补且 `skippedTargetCount` 正确；
7. **确定性**：同输入两次运行，输出（含工件）字节级一致；
8. **参考引擎对账**：同一份合成数据与等价策略在 backtrader（独立参考实现）重跑，日收益序列在容差内一致。执行约定须对齐：参考侧默认次 bar 成交对应 `next_close`，开 [`coc`](https://www.backtrader.com/docu/broker/) 对应 `same_close`。这是"我们的引擎与经千万人检验的实现一致"的最强正确性证据。

## 6. 首批变体与性能预算

parameter robustness 的默认 grid 固定为 45 项：

```text
window [14, 17, 20, 23, 26]
× topN [30, 50, 70]
× windowShiftMonths [-6, 0, 6]
= 45 variants
```

宿主的审计变体总硬上限为 64。本批只分配 parameter grid 的 45 项与 cost ladder 的 4 项，共 49 项；剩余 15 项保持**未分配**，任何 agent 都不能借用。45 项 grid 必须由主机确定性展开并整体计数，不再沿用 freezer 的"每检查 8 项"默认值；四个成本场景也由主机一次性批准。

面板约 5 年 × 500 股 × 日频 ≈ 60 万格，内存与向量化计算无压力；瓶颈在取数（限流数值未知），依赖 Data Layer 缓存与有界并发。验收目标：上述 45 变体在合成数据上的纯计算 < 5 秒（不含取数）。

## 7. 仓库落位与实现顺序

```
services/panda-adapter/src/panda_adapter/
├── client.py            # 已有：SDK 初始化 + get_market_data
├── data/                # 新增：其余数据方法透传 + 面板构建 + 缓存
├── engine/              # 新增：向量化回测 signals / portfolio / costs / metrics / regimes
├── experiments.py       # 新增：run_experiment 分发 + 工件落盘
└── tests/               # §5 known-answer 测试族（合成数据）
```

当前竖切顺序：parameter grid / cost ladder 所需的版本化常量与纯函数 → 对应合成测试 → `AuditPlan` 的 45 项 grid 与四场景成本阶梯 → `run_experiment` 工具面 → TS finance-tools 接到 parameter robustness / cost stress 两个 agent。其余接口后补，不得为了当前竖切提前固化。
