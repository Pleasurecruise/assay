# 系统架构

> English version: [ARCHITECTURE_EN.md](ARCHITECTURE_EN.md)

> 状态：🚧 框架草稿，随开发迭代。本文档画"盒子"——系统由哪些模块构成、各自职责与依赖；模块之间怎么"流动"见 [PIPELINE.md](PIPELINE.md)。

## 1. 模块总览

```
┌─────────────────────────────────────────────────────┐
│                    A2A Server                        │
│        (Agent Card 托管 · 任务接收 · Artifact 返回)   │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │     Intake      │  任务解析 · 检查计划 · 预算分配
              └────────┬────────┘
                       │
    ┌──────┬──────┬────┴───┬──────────┬─────────┐
┌───▼──┐┌──▼───┐┌──▼───┐┌──▼──────┐┌──▼──────┐  │
│参数  ││数据  ││交易  ││市场环境 ││同质化与 │  │  五项检查（并行）
│稳健性││可得性││成本  ││依赖     ││衰减     │  │
└───┬──┘└──┬───┘└──┬───┘└──┬──────┘└──┬──────┘  │
    └──────┴──────┴────┬───┴──────────┘         │
              ┌────────▼────────┐               │
              │  Moiré 交叉验证  │  矛盾检测 · 追加实验编排
              └────────┬────────┘               │
              ┌────────▼────────┐               │
              │     Report      │  五档结论 · 证据包 · JSON Artifact
              └─────────────────┘               │
                                                │
   ┌────────────────┐   ┌────────────────┐     │
   │   Backtester   │   │   Data Layer   │ ←───┘（被各检查调用）
   │ 自建向量化回测器 │   │ panda-data 封装 │
   └────────────────┘   │ 缓存 · 限流退避  │
                        └────────────────┘
```

## 2. 各模块职责

### A2A Server

- 托管 `/.well-known/agent-card.json`，暴露三个 Skill：`audit_strategy` / `audit_factor` / `compare_robustness`
- 接收自然语言任务，返回结构化 Artifact（DataPart）+ 报告
- 无状态：单次调用闭环，不依赖 A2A 任务持久化

### Intake（任务解析）

- 从自然语言/因子表达式/代码中识别策略类型、参数、依赖数据
- 生成检查计划：派哪些检查、每项分配多少回测次数（18 分钟执行预算在此分死；运行时硬上限 19 分钟）

### Checks（五项检查）

每项检查是一个独立模块，统一输入输出契约：

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `param_robustness` | 参数邻域扰动 + 时间窗平移的变体矩阵 | Backtester |
| `data_availability` | 股票池/可交易性/财务时点的逐日核对 | Data Layer |
| `cost_stress` | 成本分档重跑 + 换手侵蚀 + 归零临界点 | Backtester |
| `regime_dependency` | 市场环境划分 + 分环境收益统计 | Backtester + Data Layer |
| `homogeneity_decay` | 与因子库相关性 + IC 逐年衰减 | Data Layer |

统一输出：`{ 检查项, 结论: 通过/有保留通过/不通过/证据不足, 关键数字, 置信度 }`

### Moiré（交叉验证）

- 汇总五项结构化结果，检测结论矛盾
- 为矛盾设计能区分两种解释的追加实验（≤2 组封顶），调度对应检查模块重跑
- 合成结论；无法收敛时标记"证据不足"

### Backtester（自建向量化回测器）

- 日线 + 复权因子，pandas 向量化，单变体毫秒级
- 支持：参数化调仓规则、成本分档、市场环境切片、指定历史股票池
- 存在理由：官方回测 Skill 输出契约未公开（详见 proposal §3）

### Data Layer

- panda-data 接口封装（鉴权：`PANDA_DATA_USERNAME/PASSWORD` 环境变量）
- 相同查询缓存、有界并发、429/超时退避重试

### Report

- 人读报告（Markdown：总结论表 + 各检查证据 + 恢复条件 + 局限说明）
- 机器可读 JSON（同内容，经 A2A DataPart 返回）

## 3. 依赖关系原则

- 检查模块之间**零依赖**（并行独立运行，Moiré 是唯一汇聚点）
- 检查模块只依赖 Backtester 和 Data Layer 两个基础设施
- LLM（DeepSeek V4 Pro）只出现在 Intake（解析）、Moiré（实验设计）、Report（行文）三处；所有数字结论来自计算，不来自模型

## 4. 产品模块 → 仓库落位

仓库已按 Bun monorepo + Python services 的结构启动（见根 README），产品模块映射如下：

| 产品模块（§1 盒子图） | 仓库位置 | 语言 | 状态 |
| --- | --- | --- | --- |
| A2A Server | `packages/`（A2A gateway，待建） | TS | 待建 |
| Intake | `packages/agents`（intake agent） | TS | 待建 |
| 五项检查 | `packages/agents`（一项检查一个 agent，见 §5） | TS | 待建 |
| Moiré 交叉验证 | `packages/agents`（orchestrator） | TS | 待建 |
| Report | `packages/agents` + `packages/contracts`（输出契约） | TS | 待建 |
| Backtester | `services/` 侧（Python，pandas 向量化；与 panda-adapter 同边界原则：DataFrame 不跨进程，经 Arrow/JSON 契约输出） | Python | 待建 |
| Data Layer | `services/panda-adapter`（已启动）+ `packages/finance-tools`（TS 工具封装，待建；工具清单见 `docs/architecture/DATA_ACCESS.md` 的 Tool Roadmap） | Python + TS | 部分完成 |

运行时基座（每任务隔离 Agent 实例、工具 read/write/exec 分级、审计事件、19 分钟上限）见 `docs/architecture/RUNTIME.md`——其无状态与限时设计和本方案 §7 的工程决策一致。

## 5. 检查项 ↔ Agent 映射

Agent ID 按 `docs/development/NAMING.md` 的 kebab-case 规则：

| 检查项 | Agent ID | 说明 |
| --- | --- | --- |
| 任务解析 | `intake` | 生成检查计划与预算分配 |
| 参数稳健性检查 | `param-robustness` | 变体矩阵回测 |
| 数据可得性检查 | `data-availability` | 股票池/可交易性/财务时点核对 |
| 交易成本压力测试 | `cost-stress` | 成本分档 + 换手侵蚀 |
| 市场环境依赖分析 | `regime-dependency` | 分环境收益统计 |
| 同质化与衰减分析 | `homogeneity-decay` | 因子库相关性 + IC 衰减 |
| 交叉验证 | `moire-orchestrator` | 矛盾检测与追加实验编排 |

> 注：bootstrap 提交里的 `coordinator / market-researcher / risk-reviewer` 是通用占位编制，需按上表重构；`ASSAY_AGENT_ID` 的取值随之更新。对外 A2A Skill 命名不变：`audit_strategy` / `audit_factor` / `compare_robustness`（snake_case，符合 NAMING.md 的 Tool ID 规则）。
