# StrategySpec｜策略的机器表示

> Intake 的解析目标、回测器的执行输入、五项检查生成变体的基底——三方共用的核心契约。字段约定尽可能锚定 PandaAI API 的既有参数（锚点在各字段注明），不发明平行语法。`packages/contracts` 的类型定义以此为准。
>
> 范围原则：MVP 只支持"排序选股 + 周期调仓"策略族；范围外输入不猜测、不硬审，返回 `UNVERIFIABLE` + 缺失信息清单（这是产品行为，见 VERDICT_SPEC §2）。

## 1. 结构总览

```jsonc
{
  "specVersion": "1",
  "universe": { "index": "000300.SH" },
  "signal": { "kind": "template", "template": "momentum", "params": { "window": 20 } },
  "selection": { "topN": 50, "weighting": "equal" },
  "rebalance": { "frequency": "monthly", "at": "close" },
  "window": { "start": "20210101", "end": "20251231" },
  "costs": { "model": "standard" },
  "claims": { "annualReturn": 0.18, "sharpe": 1.9 }, // 可选
}
```

协议层字段用 camelCase，adapter 边界转 PandaAI SDK 的 snake_case（规则见 `../development/NAMING.md`）。

## 2. 字段定义与 PandaAI 锚点

### universe（股票池）

| 字段    | 类型   | 约束                     | PandaAI 锚点                                                                                                                                                                           |
| ------- | ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index` | string | 指数代码，如 `000300.SH` | `get_index_weights(index_symbol)` / `get_factor(index_component)`；历史时点成分由 `get_index_weights` 起止日期查询取得——**回测各调仓日必须用当日真实成分**（数据可得性检查的核对基准） |

MVP 只支持指数股票池。自定义股票清单（列举代码）作为低成本扩展可后补；"全市场"暂不支持（数据量与限流风险）。

### signal（排序信号）——本契约唯一的分层字段

**第一层（MVP，必须实现）：**

| kind       | 结构                                                              | 求值方式                 | PandaAI 锚点                                                       |
| ---------- | ----------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `library`  | `{ "kind": "library", "name": "<因子名>" }`                       | 调平台因子库取现成因子值 | `get_factor(factors, start_date, end_date, index_component, type)` |
| `template` | `{ "kind": "template", "template": "<模板名>", "params": {...} }` | 本地用日线行情计算       | `get_market_data` + `get_adj_factor`                               |

内置模板（首批）：

| template        | params（默认值）                   | 定义                               |
| --------------- | ---------------------------------- | ---------------------------------- |
| `momentum`      | `window` (20)                      | 过去 window 个交易日收益率，降序   |
| `reversal`      | `window` (5)                       | 过去 window 个交易日收益率，升序   |
| `volatility`    | `window` (20), `direction` ("low") | 过去 window 日收益标准差，low=升序 |
| `turnover_rate` | `window` (20), `direction` ("low") | 过去 window 日换手均值             |

> 模板的 `params` 就是参数稳健性检查的扰动面：检查器对每个数值型 param 做邻域扰动，无需模板作者额外声明。新增模板必须写明：参数、默认值、方向、所需字段。

**第二层（冲刺目标，非 MVP 承诺）：**

| kind      | 结构                                                           | 说明                                                                                                                                                             |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formula` | `{ "kind": "formula", "expr": "RANK(CLOSE/DELAY(CLOSE,20))" }` | panda_factor 公式语法（RANK/DELAY/STDDEV/CORRELATION 等算子），与平台生态同语言。需从 panda_factor 源码集成算子库（不在 PyPI）。未实现前收到此类输入按范围外处理 |

**明确排除：** 用户自带 Python/任意代码的因子。理由：等于执行陌生代码，违反 runtime 的 exec 默认拒绝策略与赛道合规要求。此类输入返回 `UNVERIFIABLE`，说明支持的表达方式。

### selection（选取规则）

| 字段        | 类型 | 约束                                  |
| ----------- | ---- | ------------------------------------- |
| `topN`      | int  | 1–200；参数稳健性检查的扰动维度之一   |
| `weighting` | enum | MVP 仅 `equal`；`cap`（市值加权）后补 |

### rebalance（调仓）

| 字段        | 类型 | 约束                                                                                                                                                               | PandaAI 锚点                                                   |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `frequency` | enum | `monthly` / `weekly`（MVP 两档）                                                                                                                                   | 调仓日按 `get_trade_cal` 取真实交易日（月末/周末的最后交易日） |
| `at`        | enum | MVP 仅 `close`：t 日收盘算信号 → t+1 日收盘价成交 → 收益自 t+1 收盘起计（默认无前视约定 `next_close`；`execution` 开关与细则见 [BACKTESTER.md](BACKTESTER.md) D1） | 避免日内数据依赖                                               |

### window（回测区间）

| 字段            | 约束                                                                                                                | 锚点                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `start` / `end` | `YYYYMMDD`，与 PandaAI 各接口一致；跨度 ≤ 5 年（`get_market_data` 硬上限）；不足 2 年时报告须标注"样本过短"保留意见 | 时间平移变体同样受 5 年上限约束，Intake 分配预算时须校验 |

### costs（成本假设）

| model         | 含义                                              |
| ------------- | ------------------------------------------------- |
| `none`        | 不计成本（用于复现宣称业绩）                      |
| `standard`    | 双边佣金 + 印花税（默认参数集中定义于 contracts） |
| `realistic`   | standard + 冲击成本（按成交量占比估）             |
| `pessimistic` | realistic × 1.5                                   |

被审策略给定一个基准 model；交易成本压力测试会在四档上全部重跑，此字段只决定"判决页"对照的基线。

### claims（宣称业绩，可选）

`{ "annualReturn": ?, "sharpe": ?, "maxDrawdown": ? }`——被审对象自己宣称的数字。仅用于报告对照（"宣称 18%，修正后 13.8%"），不参与任何计算。缺省时报告只给绝对结果。

## 3. 校验规则（Intake 出口检查）

1. 必填：`universe` / `signal` / `selection` / `rebalance` / `window`；缺任一 → 先走 A2A `INPUT_REQUIRED` 多轮澄清补齐（轮次上限与超时见 A2A_SERVER.md §10.4）；澄清额度用尽或超时仍缺 → `UNVERIFIABLE` + 缺失清单（早退 Artifact 形状见 VERDICT_SPEC §4.1）；
2. `window` 跨度 ≤5 年、`end` 不晚于数据截止日；
3. `signal.kind` ∈ 已实现集合；`library` 因子名需在因子库存在（Intake 阶段调 `get_factor` 试探一次）；
4. 数值范围越界（如 `topN` > 200）→ 拒绝并说明，不静默截断；
5. 解析自自然语言时，Intake 必须把解析结果的 StrategySpec 回显进报告——审计对象是这个 Spec，解析歧义对用户可见。

## 4. 示例

**演示例一（动量策略，自然语言 → Spec）：**

> "在沪深 300 里每月底买过去 20 天涨幅最大的 50 只，等权持有一个月"

```json
{
  "specVersion": "1",
  "universe": { "index": "000300.SH" },
  "signal": { "kind": "template", "template": "momentum", "params": { "window": 20 } },
  "selection": { "topN": 50, "weighting": "equal" },
  "rebalance": { "frequency": "monthly", "at": "close" },
  "window": { "start": "20210101", "end": "20251231" },
  "costs": { "model": "none" },
  "claims": { "annualReturn": 0.18, "sharpe": 1.9 }
}
```

**演示例二（靶子因子，库因子引用）：**

```json
{
  "specVersion": "1",
  "universe": { "index": "000905.SH" },
  "signal": { "kind": "library", "name": "<赛前构造并入库的过拟合因子>" },
  "selection": { "topN": 30, "weighting": "equal" },
  "rebalance": { "frequency": "weekly", "at": "close" },
  "window": { "start": "20220101", "end": "20251231" },
  "costs": { "model": "standard" }
}
```

## 5. 版本与演进

- `specVersion` 随不兼容变更递增；幂等键包含它（见 PIPELINE §5）；
- 二层公式支持上线时只新增 `kind`，不改既有字段——检查器对 `kind` 的分支处理集中在信号求值一处；
- 本文档冻结后，`packages/contracts` 中的 `StrategySpec` 类型与本文一一对应，字段有出入以 contracts 为准并回改本文。
