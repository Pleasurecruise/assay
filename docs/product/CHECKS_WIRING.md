# 审计能力接线蓝图（claim-reproduction + 三检查 + QUARANTINE）

> 状态：设计冻结（2026-07-24），按 §6 顺序施工。原则同 BACKTESTER.md：数字来自确定性工具，结论由 agent 依预声明准则判断；阈值全部集中于 contracts 常量，首版值可调但改动要记录。

## 0. Claim-reproduction（主机环节，非第六检查）

- 位置：Intake 冻结之后、五路 fan-out 之前，主机调引擎按**对方口径**跑一次基线（`universeMode: asOf` + `costs: none`；execution 默认 next_close）。
- 产物：Artifact 顶层新增 `claimComparison: { claimed: {annualReturn?, sharpe?}, reproduced: {…}, gaps: {…}, knownConventionDiffs: [文本] }`。claims 缺省则整节置 null。
- 判决规则（主机 VerdictPolicy 新增一条，确定性）：宣称夏普 > 复算值 × 1.5（或年化差 ≥ 8pp）且无已披露口径差异可解释 → **判决封顶 WATCH（不得 KEEP）**，生成恢复条件"提交原回测口径（ClaimProfile）后复审"。
- 不碰 agent 结论权；不新建 agent。首用例：宣称 1.9 vs 实测 ≈1.045。

## 1. data-availability 接线（PIT，演示高潮）

**工具**：`run_availability_audit(spec)`，一次调用，确定性完成：

1. 逐调仓日取 PIT 成分（`get_index_weights`，小窗口分片入缓存）；
2. 与被审口径的 asOf 固定名单比对 → `futureConstituentCount`、受影响调仓日清单、示例股票；
3. 执行日可交易性核对（面板 `trade_status`）→ 不可交易目标计数；
4. **PIT 成分池重跑基线** → `correctedAnnualReturn / correctedSharpe / delta`（"18%→13.8%"型证据）；
5. 财务时点核对（`get_fina_reports` 的 `date` 真实公告日）仅当信号含财务字段时激活；本期动量演示不触发，接口留位。

**返回**：`{ futureConstituentCount, affectedRebalances, sampleSymbols, untradableTargets, corrected: {annualReturn, sharpe, delta}, sourceRef }`。

**评判准则（进 agent prompt）**：future=0 → pass；future>0 且 |delta| < 2pp 年化 → pass_with_reservations；|delta| ≥ 2pp 或污染选股比例 ≥ 10% → fail。

## 2. regime-dependency 接线

- 指数序列：`get_index_daily` 小窗分片重试入缓存；持续失败 → PIT 成分等权代理并写入假设声明。
- 环境标签（无前视，常量集中）：趋势 = 指数 t−1 收盘 vs 200 日均线（up/down）；波动 = 60 日已实现波动滚动分位（top 1/3 = high）。
- 工具：`run_experiment kind=regime_split` —— 引擎把基线日收益按标签切开，返回每环境 `{days, annualReturn, sharpe, pnlShare}`；**同批实现"grid 每变体日收益落盘为工件"**（Moiré M1 前置）。
- 准则：最大环境 pnlShare ≥ 80% → pass_with_reservations；≥ 95% 或其余环境全为负 → fail；任一环境 < 60 交易日 → 该切片记证据不足。

## 3. homogeneity-decay 接线

- 对照组（因子库无策略型因子，已实证）：自建 momentum(20)/reversal(5)/volatility(20)（同一面板、BACKTESTER D9 公式）+ 库内 `ratio_pe_ttm`、`market_cap`。
- 工具：`run_homogeneity(spec)` → 逐调仓日截面 Spearman 相关（对每个对照因子取均值）+ 逐年 IC/RankIC（信号 vs 次月收益）。
- 准则：与任一对照相关 ≥ 0.9 → 同质化子项 fail；衰减子项——窗口 < 4 年时**最高只能给 pass_with_reservations 或证据不足**（3 个年度点不支撑强结论，明文写进准则）。

## 4. QUARANTINE 恢复条件映射（静态表，主机 deriveVerdict 使用）

| 检查 fail                 | 恢复条件                   | 定档       |
| ------------------------- | -------------------------- | ---------- |
| data-availability         | 改用 PIT 成分池重跑        | QUARANTINE |
| cost-stress               | 降低调仓频率/换手后复审    | QUARANTINE |
| param-robustness          | 收窄参数敏感面或加环境过滤 | QUARANTINE |
| regime-dependency         | 增加环境过滤规则           | QUARANTINE |
| homogeneity（相关性子项） | 无（同质化为信号本质属性） | RETIRE     |

规则：全部 fail 均有映射恢复条件 → QUARANTINE + 恢复条件列表；含任一"无恢复条件"的 fail → RETIRE。claim 封顶规则见 §0。

## 5. 硬约束

- **QUARANTINE 映射必须与 data-availability 接线同批上线**：否则演示高潮输出 RETIRE，讲错"体检单不是死刑判决"的产品故事。
- 检查间零通信、结论必须带 sourceRefs、阈值常量化——全部沿用。

## 6. 实施顺序

claim-repro（小）→ **PIT + data-availability + QUARANTINE 映射（同批）** → regime + 日收益落盘 → homogeneity → Moiré（见 MOIRE_SPEC.md）。每步完成，演示例一的真实判决升一档：UNVERIFIABLE → QUARANTINE（带修正数字）→ 带环境细分 → 带同质化 → 带 Moiré 合成。
