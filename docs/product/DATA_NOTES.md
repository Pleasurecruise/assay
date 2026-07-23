# 数据事实与现场确认清单

> 关于 PandaAI 平台数据能力的全部已知事实：哪些接口核验可用、哪些缺失、现场要问什么。检查项如何消费这些接口见 [CHECKS.md](CHECKS.md)；适配器工程要求见 `../architecture/DATA_ACCESS.md` 的 Tool Roadmap。现场确认一条更新一条。

## 1. 数据能力核验结论

核验日期：2026-07-23。核验方法：官方文档页（`?id=xx`）为 JS 渲染无法直读，改用三类独立证据源交叉验证——官方 GitHub `panda-data` 仓库（比赛数据 Skills 的实现本体，38 个方法的函数签名即事实契约）、官方社区文章 1163《支持 Skills（数据接口）一览》、文章 117《工作流-策略帮助文档》与 A2A 官方规范。

**已证实可用（本方案的地基）**：

- `get_market_data` 日线行情（5 年上限）、`get_market_min_data` 分钟线、`get_adj_factor` 复权因子；
- `get_index_weights`：起止日期必填，可查任意历史时点的指数成分与权重；
- `get_trade_list`：按日期返回可交易名单；`get_stock_status_change`：ST 状态变化；
- 交易日历族：`get_trade_cal` / `get_prev_trade_date` / `get_last_trade_date`；
- `get_factor`：平台因子库（`start_date, end_date, factors, symbol, index_component, type`）；
- `get_fina_forecast` / `get_fina_performance`：业绩预告与快报，均暴露信息发布日期 `info_date`；
- `get_fina_reports`：季度财务，`is_latest=False` 返回同一 symbol+季度的全部披露版本；
- 鉴权：环境变量 `PANDA_DATA_USERNAME` / `PANDA_DATA_PASSWORD`。

**已证实缺失或不可依赖（设计时绕开）**：

- `get_fina_reports` 季度报告接口**无公告/披露日期**参数（日期按报告期语义换算为季度区间）；业绩预告与快报接口则有 `info_date` → 季报可得性检查暂用法定披露期限启发式，预告与快报按真实信息发布日期核对；
- 行业成分**有纳入时间、无剔除时间**，且无按日期查询参数；
- 回测 Skill **输出契约未公开**（开源结果节点仅返回 `task_id`）→ 自建向量化回测器（见 ARCHITECTURE）；
- 基金绩效/风格接口在 Skill 层不存在；组合管理不接受自定义持仓；
- A2A 任务持久化为 implementation-defined → 全流程单次调用闭环，不依赖跨任务状态；
- 限流确认存在但无公开数值 → 有界并行 + 缓存 + 退避重试（见 PIPELINE §3-4）。

## 2. 现场必须确认的问题

- [ ] 1. **（决定季报可得性检查是否满血）** `get_fina_reports` 在 Skill 层没有公告/披露日期；数据 API 层是否提供对应字段？比赛是否允许直连数据 API？（`get_fina_forecast` / `get_fina_performance` 已有 `info_date`，不属于此缺口。）
- [ ] 2. `is_latest=False` 返回的多版本记录，版本的时间标记方式是什么（日期还是时间戳、是否为披露时点）？
- [ ] 3. 历史指数权重的最早覆盖日期；行业成分能否拿到剔除时间？
- [ ] 4. 因子分析 Skill 能否指定股票池、子区间、持有期和中性化（决定同质化检查是否可直接调用官方能力）？
- [ ] 5. 每 Token / 每 IP / 每分钟 / 单日的请求上限与最大并发（决定变体矩阵规模）？
- [ ] 6. A2A 评审：是否接受结构化 Data Part 的 Artifact？评审是单轮任务还是跨任务追问？超时与重试如何处理？
- [ ] 7. 火山低延时 Seed 模型可否与 DeepSeek V4 Pro 混用（Seed 仅作辅助分类）？混用边界在哪？

> 确认后请直接在对应条目下追加结论和日期，并同步更新 §1 与 CHECKS.md 受影响的行。

## 3. 安全提醒

- 模型和 Token 使用说明见本地文件：[AdventureX PandaAI 模型技术支持](<../../reference/model-api-guide.md>)。
- 该支持文件包含明文活动 Token，**不得提交到公开仓库、截图、日志或公开聊天**；本目录文档不复制任何 Token。
- 不要在前端或公开代码中暴露 Token 与数据服务凭证（`PANDA_DATA_USERNAME/PASSWORD`）；`.env` 已在 `.gitignore`。

## 4. 参考链接

比赛资料（`reference/` 含活动 Token，已被 `.gitignore` 排除，仅存本地，以下链接在 GitHub 上不可用）：

- [PandaAI 7.22 ADVX 赛道](<../../reference/track-brief/track-brief.md>)
- [AdventureX PandaAI 模型技术支持](<../../reference/model-api-guide.md>)

数据能力证据源：

- [PandaAI-Tech/panda-data](https://github.com/PandaAI-Tech/panda-data)（数据 Skills 实现仓库）
- [panda-data-skill/api_reference.md](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda-data-skill/api_reference.md)
- [panda_tools/tools/financial.py](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/financial.py)
- [panda_tools/tools/market_ref.py](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/market_ref.py)
- [PandaAI 支持 Skills（数据接口）一览（文章 1163）](https://www.pandaaiquant.com/community/article/1163)
- [PandaAI 工作流策略帮助文档（文章 117）](https://www.pandaaiquant.com/community/article/117)
- [数据 API 常见问题](https://www.pandaaiquant.com/data-service/api-docs?api=data_faq)

协议与模型：

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [火山方舟开发文档](https://docs.volcengine.com/docs/82379/2335857?lang=zh)
