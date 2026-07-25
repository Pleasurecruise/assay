# 审计报告 v3 改版任务书 | Audit Report Rendering Brief

> Status: proposed 2026-07-25。基于 v9 真实运行(artifacts/v9/assay-real-data-run.json,RETIRE 案例)暴露的缺陷制定。
> 本文只管"报告怎么讲";数据与判定逻辑不在本文范围。

## 0. 目标与红线(不可协商)

1. 报告 = Artifact JSON 的**确定性投影**。渲染层零 LLM、零新事实计算(仅显示格式化);md 中每个数值必须能指回 DataPart 字段。
2. 不输出操作建议;只输出恢复条件与复审触发(既有裁决)。
3. **短窗口年化守卫(新红线)**:样本窗口 < 60 个交易日(拍板值,可调)的收益指标,一律渲染为区间累计收益并标注天数,禁止以年化形式出现。
   依据:v9 真实输出中 `down-high.annualReturn = 105.74`(11 个交易日年化)——这类数字进报告即自曝,且正是我们批评 PandaAI 沪银报告的同款错误。
4. 显示舍入允许,但须带固定脚注:"表内数值为显示舍入,精确值以 JSON DataPart 为准。"

## Block A — 渲染层(纯模板改动,优先级最高,赛前必做)

### A1 结构重排

```
一、审计结论(判定块 + 定档依据 + 一句话结论)
二、申报与复算(表格 + 口径差异)
三、五项检查(每项:结论句 + 证据)
四、恢复条件与复审触发
附录:冻结 StrategySpec(折叠)/ 溯源 / Moiré 记录 / 风险披露
```

参考形态见对话中 v2 样例(sample-audit-report-v2.md)。

### A2 定档依据句(确定性推导)

渲染器扫描 checks 生成:"五项检查中「X」「Y」不通过;按预声明 fail 优先规则定档 Z;「W」证据不足仅降低置信度。"
优选实现:verdict-policy 定档时输出 `rationale` 结构,渲染器只转录——避免判定逻辑在两处实现而漂移。

### A3 检查结论句模板表

- 键 = (checkId × conclusion),值 = 固定话术模板,槽位从 evidence metric 填入。
- 需要 metric → 中文话术映射表(如 `futureConstituentCount` → "未来成分股数量")。首版只须覆盖三个 golden 案例实际出现的 metric;未映射的回退到现有"证据: metric = value"列表,不许硬编。
- 5×5=25 个组合,实际只需实现 golden 案例触发的十余个。

### A4 数字格式化(unit-aware)

- `fraction` → 百分数(29.3%);偏差 → 百分点(+8 pp);`ratio` → 两位小数;`count`/`trading_days` → 整数。
- 全局显示舍入 + 红线 4 的脚注;短窗口年化守卫(红线 3)在此层实施。

### A5 证据不足项的方向性声明

单向指标(如同质化)模板补一句:"该缺口补齐后,定档只会持平或更差,不会更好。"——让判定在信息不完整下依然稳固。方向性由模板表按 checkId 写死,不做运行时推理。

### A6 审计范围与独立性声明(固定文本小节)

判据预声明版本、复算实现独立于申报方、同源数据=控制变量、报告有效期=数据包快照(dataAsOf + 包 id)。文案从答辩口径"独立性三轴"翻译。

## Block B — 上游内容(小改,赛前做 B1)

### B1 summary 案例化(废掉通用句)

现状:"At least one material check failed without a verified recovery path." 是模板废话。
改法(二选一,需拍板):

- **B1a(确定性拼句,推荐)**:orchestrator 按规则拼:主 fail 检查 + 其最高权重证据值 + 定档。如 RETIRE 案例应得到:"数据可得性不通过(76 只未来成分股影响 35/36 次调仓),同质化衰减不通过(与 20 日动量因子 Spearman=1.0);按 fail 优先定档 RETIRE。"
- B1b(agent 署名行文):检查 agent 审计时写 finding 文本入 artifact,渲染转录。符合结论权裁决但引入行文波动,golden 快照测试需放宽,**赛前不推荐**。

### B2(可选)evidence 增加 displayName 字段,替代渲染侧 metric 映射表。schema 1.1→1.2,动契约,赛前谨慎。

## Block C — 引擎补数字(赛内视余量;C3/C4 赛后)

- **C1** 业绩表补全:volatility、annualTurnover(先修分母 backlog)、在场时间、调仓次数。
- **C2** 夏普置信区间(Lo 2002 标准误差,纯公式)+ "样本期 36 个月"声明。
- C3 偏差归因桥:至少拆"费用效应 vs 残余无法解释"两段(需一次零费率复算)。
- C4 盈亏平衡费率、成本敏感度曲线(1x/1.5x/2x/3x)、Beta/超额分解(受 G01 `index_daily=degraded` 限制,先声明缺口)。

## Block D — 前后端一致性(语义下沉,呈现各自)

背景事实:web 工作台不渲染 md TextPart,而是从 JSON DataPart 直接做组件投影,且已有独立文案层
(`apps/web/src/features/audit/report-utils.ts`:VERDICT_COPY、CHECK_QUESTION/IMPACT_KEYS、HIGHLIGHT_METRICS)。
报告 v3 若只改 md,将形成 UI 文案 / md 模板两层话术各自漂移。原则:**内容决定只做一次,呈现各做各的**。

### D1 语义共享层(下沉到 `@assay/contracts` 或新建 `packages/report-core`)

两端(a2a-server md 渲染器、web UI)共同引用,禁止各自维护副本:

- metric → 显示名映射表(中英);
- unit-aware 格式化器(fraction→%、pp、ratio 两位小数)+ **短窗口年化守卫(红线 3 必须两端同时生效——UI 把 `down-high.annualReturn` 格式化成百分数同样自曝)**;
- 每检查重点指标选择表(现 HIGHLIGHT_METRICS 从 web 挪入共享层;md 结论句模板的槽位指标从同一张表取);
- 判定/检查/结论枚举的双语术语表(RETIRE=退役 等,与 UI i18n 对齐,一处修改两端生效)。

### D2 rationale 单源

A2 的定档依据由 verdict-policy 写入 artifact(结构化 rationale 字段),md 与 UI 均只转录、不各自推导。

### D3 前端小改(不做 UI 改版,现有结构已正确)

- 消费 rationale 字段替代自行推断;
- HIGHLIGHT_METRICS 与格式化换用 D1 共享实现;
- 加"导出报告"按钮:直接取 Artifact 的 text/markdown TextPart 下载(答辩现场可当场递报告)。

## 验收(全部确定性)

1. 三个 golden 案例的 md 全文快照测试;同输入两次渲染逐字节一致。
2. md 中不得出现:年化形式的短窗口指标(红线 3)、未映射且未回退的裸 metric 名进入结论句、任何"建议"字样。
3. 抽查断言:结论句中每个数字与 DataPart 对应字段一致(允许声明的舍入规则)。
4. RETIRE 真实案例的报告须能讲出因果链:前视成分 → 复算虚高 → 同质化=裸动量 → RETIRE。
5. **两端同故事**:同一案例,UI 高亮指标集合与 md 结论句引用指标集合一致;判定/检查/结论用词逐字一致;年化守卫在两端均生效(以 105.74 案例做守卫测试)。

## 优先级

赛前必做:A1–A6 + B1a + D1/D2(共享层先行,A3/A4 直接建在 D1 上,避免先写 md 侧再搬家)。
赛内视余量:C1、C2、D3 导出按钮。赛后:B1b、B2、C3、C4。
