# 输出契约（Verdict Spec）

> 状态：🚧 目标规格，尚未在 `packages/contracts` 中实现。当前 contracts 仅包含 Runtime Task/Event/Result；落地前必须据此新增版本化 Artifact 类型与校验器。
>
> 本文定义 Assay 的目标对外输出：单项检查结论、五档总体结论、报告结构、结构化 Artifact 与 A2A Skills。生成过程见 [CHECKS.md](CHECKS.md) 和 [PIPELINE.md](PIPELINE.md)。

## 1. 单项检查结论

每项检查输出统一结构：

```
{ 检查项, 结论, 关键数字, 置信度 }
```

结论取五值：

| 取值 | 含义 |
| --- | --- |
| `pass`（通过） | 该维度未发现问题 |
| `pass_with_reservations`（有保留通过） | 未致命，但有必须写明的保留条件（如"仅趋势市成立"） |
| `fail`（不通过） | 发现可复算的实质缺陷 |
| `insufficient_evidence`（证据不足） | 数据缺失或追加实验后仍无法判断——不硬给结论 |
| `not_applicable`（不适用） | 当前 Skill 档案或输入不要求执行该检查；不参与定档 |

实际执行的检查置信度 ∈ [0,1]；`not_applicable` 的置信度为 `null`。单项检查超时按已完成变体出部分结论并打折置信度（见 PIPELINE §5）。

## 2. 总体结论：五档量表（Verdict Scale）

| 档位 | 含义 | 典型触发 |
| --- | --- | --- |
| `KEEP` 可继续使用 | 所有检查均通过 | 全部为 pass |
| `WATCH` 观察使用 | 有保留项需要跟踪，但无实质缺陷 | 至少一个 pass_with_reservations，且无 fail |
| `QUARANTINE` 暂停使用 | 存在实质缺陷，修复后可重审 | 有 fail 且给得出恢复条件 |
| `RETIRE` 建议弃用 | 核心假设失效且无可行修复路径 | 多项 fail 且无恢复条件 |
| `UNVERIFIABLE` 证据不足 | 关键证据缺失，拒绝强结论 | 输入不可解析或关键数据不可用 |

规则：

- 输入不可解析，或当前 Skill 档案任一必需检查为 `insufficient_evidence` → `UNVERIFIABLE`；
- 未解决的 Moiré 分歧若可能改变最终档位，必须先把受影响的必需检查改为 `insufficient_evidence`，再执行定档；
- 否则收集全部 `fail`：每个 fail 检查都至少有一条对应的 `recoveryConditions[].scope` → `QUARANTINE`；任一 fail 没有可行恢复条件 → `RETIRE`；
- 否则只要存在 `pass_with_reservations` → `WATCH`；其余实际执行检查全部为 `pass` → `KEEP`；`not_applicable` 始终忽略；
- `WATCH`、`QUARANTINE`、`UNVERIFIABLE` 必须附带升档或补证条件；`RETIRE` 必须说明为何没有可行恢复路径；`KEEP` 必须附带复审触发条件；
- `UNVERIFIABLE` 是产品原则的落实：缺关键证据时拒绝强结论，演示中必须至少出现一次，证明系统不是为了制造戏剧性结论而存在；
- 档位由确定性规则从五项检查结论合成，LLM 不参与定档。
- 总体置信度取参与定档的单项检查置信度最小值（忽略 `not_applicable`）；Moiré 追加实验先更新对应单项置信度，再执行聚合。

## 3. 人读报告结构

Markdown，三部分：

1. **判决页**：总体结论 + 置信度 + 一段话理由 + 五项检查结论表（每行带关键数字）；
2. **证据页**：每项检查一张图/表（参数敏感度、违规清单、成本斜坡、分环境收益、相关性/IC 衰减）；
3. **附页**：Moiré 分歧记录（哪里矛盾、追加实验、是否收敛）+ 恢复条件 + 假设与局限声明 + 风险提示。

写作原则：不出现"我们认为风险较高"式的模糊表述，每个结论指向一个可复算的数字；审计自身的局限（如公告日缺失时使用披露期限启发式）如实写入——诚实交代审计边界是产品可信度的一部分。

## 4. 结构化 Artifact（A2A DataPart）

与报告同内容的机器可读 JSON。以下是 `strategy_audit` 的目标字段骨架：

```json
{
  "schemaVersion": "1.0.0",
  "kind": "strategy_audit",
  "auditId": "audit_01",
  "generatedAt": "2026-07-23T12:00:00Z",
  "results": [
    {
      "subjectId": "strategy_01",
      "verdict": "QUARANTINE",
      "confidence": 0.8,
      "summary": "修正与压力测试后合理预期 8-10%，仅趋势行情成立",
      "checks": [
        {
          "id": "param-robustness",
          "conclusion": "fail",
          "confidence": 0.85,
          "evidence": [
            {
              "metric": "neighborhoodSharpeRetention",
              "value": 0.35,
              "unit": "ratio",
              "sourceRefs": ["dataset:panda-data/market-data"]
            }
          ],
          "refinedByMoire": "仅震荡市不稳健",
          "missingEvidence": []
        },
        {
          "id": "data-availability",
          "conclusion": "fail",
          "confidence": 0.9,
          "evidence": [
            {
              "metric": "futureConstituentCount",
              "value": 37,
              "unit": "count",
              "sourceRefs": ["dataset:panda-data/index-weights"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "cost-stress",
          "conclusion": "pass_with_reservations",
          "confidence": 0.8,
          "evidence": [
            {
              "metric": "annualTurnover",
              "value": 12,
              "unit": "multiple",
              "sourceRefs": ["artifact:backtest/cost-stress"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "regime-dependency",
          "conclusion": "pass_with_reservations",
          "confidence": 0.8,
          "evidence": [
            {
              "metric": "trendingRegimeReturnShare",
              "value": 1,
              "unit": "ratio",
              "sourceRefs": ["artifact:backtest/regime-split"]
            }
          ],
          "missingEvidence": []
        },
        {
          "id": "homogeneity-decay",
          "conclusion": "fail",
          "confidence": 0.85,
          "evidence": [
            {
              "metric": "libraryFactorCorrelation",
              "value": 0.93,
              "unit": "ratio",
              "sourceRefs": ["dataset:panda-data/factor-library"]
            }
          ],
          "missingEvidence": []
        }
      ],
      "moire": {
        "disputesOpened": 1,
        "resolved": ["参数脆弱性仅存在于震荡市"],
        "unresolved": []
      },
      "recoveryConditions": [
        {
          "scope": "param-robustness",
          "condition": "增加震荡市减仓规则并重跑参数邻域"
        },
        {
          "scope": "data-availability",
          "condition": "改用历史时点成分股池"
        },
        {
          "scope": "cost-stress",
          "condition": "调仓降为季度"
        },
        {
          "scope": "homogeneity-decay",
          "condition": "去除与经典动量重合的成分并重新验证增量信号"
        }
      ],
      "reviewTriggers": ["出现新的市场环境或数据版本时重审"],
      "assumptionsAndLimits": ["季报可得性暂按法定披露期限估算"]
    }
  ],
  "comparison": null,
  "riskDisclosure": [
    "本结果是策略稳健性的技术性检查，不构成投资建议或收益承诺。"
  ],
  "provenance": {
    "inputHash": "sha256:...",
    "dataAsOf": "2026-07-22",
    "dataSources": [{ "id": "panda-data", "version": "0.0.12" }],
    "codeRevision": "git-sha"
  },
  "nextReview": "修复提交后"
}
```

字段约定：

- 除 `nextReview` 外，上述顶层字段均为必填；`riskDisclosure` 必须是非空数组。
- `results` 至少一项；`strategy_audit` / `factor_audit` 恰好一项，`robustness_comparison` 至少两项。
- 每个 result 的 `subjectId`、`verdict`、`confidence`、`summary`、`checks`、`moire`、`recoveryConditions`、`reviewTriggers`、`assumptionsAndLimits` 均为必填。
- 每个 `results[].checks` 明确列出五个规范检查 ID；未被当前 Skill 档案要求的检查使用 `not_applicable`，不得伪装成 `pass`。
- 每个 check 的 `id`、`conclusion`、`confidence`、`evidence`、`missingEvidence` 均为必填；`refinedByMoire` 仅在 Moiré 改写该检查结论时出现。
- 对结论为 `pass`、`pass_with_reservations` 或 `fail` 的检查，`evidence[]` 至少一项，且 `metric`、`value`、`unit`、`sourceRefs` 均为必填；`sourceRefs` 至少一项并可回溯到数据集、计算产物或附属 Artifact。
- `insufficient_evidence` 允许空 `evidence`，但必须提供非空 `missingEvidence[]`；每项包含 `requirement`、`reason`、`sourceRefs`，其中 source 可指向失败的数据接口或错误事件。`not_applicable` 使用 `confidence: null`、空 `evidence` 与空 `missingEvidence`。
- `recoveryConditions[]` 使用 `{ scope, condition }`；`scope` 必须是检查 ID、`intake` 或 `evidence`。`WATCH`、`QUARANTINE`、`UNVERIFIABLE` 至少一项，`KEEP` 与 `RETIRE` 可为空。
- `comparison` 仅在 `kind=robustness_comparison` 时必填且非空，至少包含 `ranking`（subjectId 数组）与 `rationaleRefs`；其他 kind 必须为 `null`。
- `provenance` 的 `inputHash`、`dataAsOf`、`dataSources`、`codeRevision` 均为必填，同时构成缓存键的一部分。
- `schemaVersion` 使用 SemVer；删除字段、改变含义或收紧枚举必须升级主版本。
- 协议字段统一使用 camelCase；`checks[].id` 使用 Agent ID（kebab-case，见 ARCHITECTURE §5）；枚举值使用 snake_case，Verdict 使用大写码，遵循 `docs/development/NAMING.md`。

## 5. 对外 A2A Skills

Agent Card 只暴露三个 Skill；检查档案以 [CHECKS.md](CHECKS.md) 为准：

- `audit_strategy`：执行完整五检查档案，输出 `kind=strategy_audit`。
- `audit_factor`：执行因子档案；交易成本仅在输入提供可交易组合构造时执行，输出 `kind=factor_audit`。
- `compare_robustness`：对每个同类型输入执行对应档案，输出 `kind=robustness_comparison`、逐对象 Verdict、排序与证据引用；混合策略/因子输入返回 `UNVERIFIABLE`。
