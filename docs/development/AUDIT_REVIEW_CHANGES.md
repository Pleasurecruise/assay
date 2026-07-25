# 审计设计评审落地变更（2026-07-25）

> 出处：五检查 + Moiré 对标高星开源的外部评审（Qlib/TradingAgents/promptfoo/DeepEval/Inspect AI/López de Prado 方法族）。
> 原则：不改 A2A 契约、数据包链路和 Artifact 顶层判决协议；确定性统计由宿主计算，
> 模型只填写并提交宿主允许的结果，提交后再由宿主机械核验。

## 已落地的四项变更

### 1. 网格支持域常量单一来源（contracts）

`packages/contracts/src/verdict-policy.ts` 新增
`SPRINT_PARAMETER_GRID_WINDOWS` / `SPRINT_PARAMETER_GRID_TOP_N`。
`packages/agents/src/run-experiment-tool.ts` 的 `SPRINT_PARAMETER_GRID` 与
`definitions.ts` 的 param-robustness prompt 均改为引用该常量——Intake 守门、
冻结网格、prompt 三处永不漂移。行为与数值完全不变。

### 2. Intake 守门：参数面不匹配 → 早退 UNVERIFIABLE

`packages/intake/src/strategy-intake.ts`：冻结后按 canonical spec 检查
template 信号的 `params.window` 与所有信号的 `selection.topN` 是否落在支持域内；
不在 → `unsupported_input` 早退（复用 §4.1 reasonCode 路径，issue code
`parameter_outside_audited_grid`）。理由：预声明邻域不包含被审基线时，
参数稳健性检查无意义——以前会静默跑完并以工具报错收场，现在是声明的能力边界。
library 信号无 window 参数，只守 topN。支持域直接读取 contracts 冻结常量，
不提供运行时覆盖口；这样 Intake 接受的基线必然存在于执行工具实际运行的网格中。
`packages/intake/tests/strategy-intake.test.ts` 覆盖 window 越界、topN 越界，
以及旧式覆盖参数无法绕过守门。

### 3. Prompt 去 case 化（definitions.ts）

- 网格数值改为常量插值（见第 1 条）；
- data-availability 撤掉"本期动量信号不含财务字段"，改为通用条件句
  （仅当信号含财务字段且工具响应含核对结果时方可引用）；
- cost-stress 撤掉"本冲刺"措辞，改为对工具响应契约的通用描述。
  语义与判断行为不变，只是冲刺期事实不再焊进 agent 准则。

### 4. PBO/DSR 确定性模块

`packages/agents/src/pbo.ts` + `packages/agents/tests/pbo.test.ts`（20 用例，
纯函数零依赖，容器内已全绿）。内容：

- `computeCscvPbo`：CSCV（默认 S=16，C(16,8)=12870 组合，超预算确定性抽稀，
  无随机数）→ PBO、median logit、IS→OOS 退化回归斜率；
- `probabilisticSharpeRatio` / `expectedMaxSharpe` / `deflatedSharpeRatio`
  （PSR/SR0/DSR，Bailey–López de Prado 公式，正态分布近似自带实现）；
- `minTrackRecordLength`（MinTRL）；`effectiveTrials`（相关性折算有效 N，
  文档化启发式）。

模块已按第 6 节接入既有 grid 调用，不增加引擎调用次数。新指标继续走 evidence 行
（metric 为自由字符串，冻结 schema 原样放行），不增加 Artifact 顶层字段。
PSR/DSR/MinTRL 的 Sharpe 输入是**日频未年化**口径，偏度和峰度由基线日收益计算。

## 验证

```
git diff                     # 审查全部改动
bun test packages/intake
bun test packages/agents packages/agent-runtime
bun test
bun run sdk:test
bun run check
```

## 明确未动的面

A2A schema / Agent Card / Artifact 顶层判决枚举与恢复规则 / 数据包与在线取数层 /
Moiré 谓词与阈值。Python grid stdio 只新增与 variants 对齐的日收益矩阵。

## 仍需后续推进的两项

1. **Evidence 机械核验推广**：param-robustness 已通过通用
   `submissionValidator` 完成宿主核验。后续应把同一机制推广到其余四检查；
   regime-dependency 虽已有模型可见的 `requiredEvidence`，仍应接入提交后逐项比对。
2. **Moiré 字符串协议结构化**：audit-orchestrator 现用正则解析
   `refinedByMoire` 前缀与 `corrected=` 字段（行为正确、fail-closed），但
   moire.ts 格式与正则是跨包隐式耦合，M2 tag 漂移会静默走 legacy 分支。
   建议把 `{resolved, changed, effectiveConclusion}` 作为结构化字段随
   check 结果传递，判决层显式消费（重构不改变任何输出）。

---

# 第二批（2026-07-25 深夜）：时限阶梯 + PBO 路线 C 接线

## 5. 时限阶梯整体上调（用户拍板 480s）

- `packages/contracts/src/audit-checks.ts`：`AUDIT_CHECK_HARD_DEADLINE_MS` 360_000 → 480_000
  （检查硬时限；SKELETON_CHECK_PLAN 预算自动跟随）。
- `tests/e2e/src/v9-real-data.ts`：`V9_REAL_POLL_TIMEOUT_MS` 600_000 → 900_000
  （五检查并行后任务总时长 ≈ 最慢检查 + Intake/取数/claim + Moiré 追加实验，
  480s 检查下 600s poll 余量不足，阶梯同批上调）。
- `packages/agents/tests/parallel-check-runner.test.ts`：超时文案断言 360000ms → 480000ms。
- 背景：G03 曾因 regime 检查超 360s 转 insufficient_evidence 而验收不通过；
  同日 14:09 同 case 曾在 360s 内全绿，属尾延迟。另一个独立的降尾延迟选项
  （regime thinkingLevel high → medium）未在本批实施，留待评估。

## 6. PBO/DSR 接线（路线 C：引擎吐数据，宿主算）

**Python（引擎侧，零逻辑只吐数据）**

- `services/panda-adapter/src/panda_adapter/engine/experiments.py`：`run_grid` 响应新增
  顶层 `variantDailyReturns`（与 `variants` 顺序对齐的逐变体日收益矩阵，引擎内存中
  已有，仅序列化；附等长断言）。
- `tests/test_engine_s1a.py` / `tests/test_experiment_stdio.py`：grid 响应键集合断言
  更新并新增矩阵对齐断言。

**TS（宿主侧，逻辑全在已测试的 pbo.ts）**

- `packages/agents/src/run-experiment-tool.ts`：grid 响应解析新增必需键
  `variantDailyReturns`（对齐/等长/有限性校验，misaligned/缺失均拒绝）；
  `parameterGridAgentView` 调 `computeOverfitStatistics` 把
  `overfitStatistics` 加入 `parameterSummary`，同时生成宿主私有的
  `submissionContract`。矩阵不可用时，九项统计被确定性转换为
  `missingEvidence`，不能由模型自行补写。
- `packages/agents/src/pbo.ts`：新增 `computeOverfitStatistics`（CSCV/PBO +
  退化斜率 + 日频基线 Sharpe/偏度/峰度 + 有效试验数 + SR0/DSR + MinTRL；
  含常数序列浮点残差守卫 `MINIMUM_MEANINGFUL_STD`）。
- `packages/agent-runtime/src/runtime.ts` / `registry.ts`：每次检查在宿主内存中保留
  成功 evidence tool 的私有 `details`；`submit_check_result` 通过 schema 后，
  还必须通过该 agent 的 `submissionValidator`，失败按无效提交要求重试。
- `packages/agents/src/definitions.ts`：param prompt 要求模型复制
  `submissionContract`；该要求只帮助模型正确填空，不承担可信边界。
- `validateParameterRobustnessSubmission`：逐项核对九个指标的 metric、value、
  unit、sourceRefs，拒绝遗漏、改写、重复和伪造的 degraded evidence；结论必须等于
  宿主按冻结保留率阈值生成的 `requiredConclusion`。PBO 指标本身仍不改变阈值规则。
- 测试：`tests/fixtures/mock-experiment-runner.mjs` grid 响应含确定性矩阵（64 天），
  新增两个 malformed shape（缺失/错位）；`run-experiment-tool.test.ts` 新增
  拒绝用例与 agent view overfitStatistics 断言；`pbo.test.ts` 新增
  computeOverfitStatistics 两用例（共 20 条，独立运行全绿）。

**口径与边界**

- PSR/DSR/MinTRL 的 Sharpe 输入为**日频未年化**；偏度/峰度取自基线变体真实日收益
  （非正态假设占位）。
- v2（赛后）才考虑把 PBO 纳入预声明判据档位；届时需重过 golden。
- Artifact 层零 schema 改动：新统计经 agent 以 evidence 行披露。
- 现行结论仍由 contracts 中冻结的保留率阈值决定；模型不能因 PBO 指标自行改判。
- **三个 golden case 的判决必须逐个不变**；快照只新增 evidence 行。

## 本批验证状态

- 定向验证：PBO、实验工具及 Runtime 相关测试 44/44；Intake 15/15。
- 全仓 Bun：287 项，286 pass、0 fail、1 个在线 E2E skip。
- Python SDK：126/126；格式、lint 与类型检查：191 个格式文件、138 个代码文件，
  0 warning、0 error。
- 接入宿主校验前的在线 Ark A2A E2E 已验证 G01/G02/G03 全部成功，且 Artifact
  已出现 PBO evidence。宿主校验只约束同一提交结果，不改变数据、模型请求或判决规则；
  按发布范围不重复消耗在线 E2E，只补跑本地确定性门禁。

## 补丁（第二批后）：evidence 单位词表

在线首跑暴露 prompt 契约缺口：无量纲指标（pbo/DSR 等）未指定 unit，模型填 ""
被 schema 拒收、烧掉一次重提机会。已在 definitions.ts 修复：共享 guardrails 加
默认单位词表（无量纲→"ratio"、计数→"count"、天数→"days"、交易日→"trading_days"、
倍数→"multiple"，严禁空 unit），param prompt 对 overfitStatistics 各字段给出固定
单位映射。离线两层测试不经过 LLM 现场编 evidence，故此类缺口只在线暴露。
param-robustness 已在本批升级为 `submissionContract` + Runtime 机械核验；其余检查
仍应按同一宿主边界逐步迁移，避免 prompt 成为可信边界。
