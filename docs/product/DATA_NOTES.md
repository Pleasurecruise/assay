# Data Facts and On-Site Questions

> This document separates verified PandaAI/PandaData capabilities from
> assumptions and open questions. See [CHECKS.md](CHECKS.md) for consumers and
> [DATA_ACCESS.md](../architecture/DATA_ACCESS.md) for adapter requirements.
> These provider facts apply to offline package preparation; production does
> not call PandaData at runtime.

## 1. Verification Scope

Last reviewed: 2026-07-23.

The public PandaAI API page is JavaScript-rendered and currently exposes only
a loading shell to automated readers. Current facts were therefore
cross-checked against the official `PandaAI-Tech/panda-data` implementation,
its API reference, and official community documentation. Reconfirm every
capability against the live competition environment before the demo.

## 2. Verified Capabilities

- `get_market_data`: daily market data with a documented five-year limit.
- `get_market_min_data`: intraday market data.
- `get_adj_factor`: adjustment factors.
- `get_index_weights`: historical index constituents and weights over a
  required date range.
- `get_trade_list`: date-specific tradable symbols.
- `get_stock_status_change`: stock-status changes.
- `get_trade_cal`, `get_prev_trade_date`, and `get_last_trade_date`: trading
  calendar operations.
- `get_factor`: platform factor library with date range, factor, symbol,
  index-component, and type arguments.
- `get_fina_forecast` and `get_fina_performance`: forecast and performance
  bulletins with `info_date`.
- `get_fina_reports`: quarterly financial records; `is_latest=False` can
  return multiple versions for one symbol and reporting period.
- Authentication uses `PANDA_DATA_USERNAME` and `PANDA_DATA_PASSWORD`.

## 3. Verified or Material Gaps

- `get_fina_reports` does not expose a verified announcement or disclosure
  date. Quarterly point-in-time checks must use a statutory-deadline heuristic
  and declare that limitation. Forecast and performance bulletins can use
  their actual `info_date`.
- Industry membership exposes an inclusion time but no verified removal time
  or point-in-time date query.
- The official backtest skill has no verified structured-result contract; an
  open-source result node exposes only a `task_id`. Assay therefore plans a
  vectorized Backtester under its own contract.
- Fund performance and style operations are not present at the skill layer,
  and portfolio management does not accept arbitrary holdings.
- Rate limiting exists, but public numeric limits have not been verified.
  Clients must use bounded concurrency, caching, and finite backoff.

A2A task storage is intentionally not listed as a data gap. The latest A2A
specification defines a task lifecycle, while server retention and purge
policy remain implementation concerns. Assay runs one self-contained audit per
Task and does not require old task history for correctness.

## 4. Questions to Confirm

- [ ] Does the Data API expose a true announcement/disclosure timestamp for
      quarterly reports, and may competition agents call that layer directly?
- [ ] How are records from `is_latest=False` versioned and timestamped?
- [ ] What is the earliest historical date for index weights?
- [ ] Can industry constituent removals be reconstructed?
- [ ] Can factor-analysis skills specify universe, subperiod, holding horizon,
      and neutralization?
- [ ] What are the token, IP, per-minute, daily, and concurrency limits?
- [ ] Which A2A protocol version and transport will the evaluator use?
- [ ] Does the evaluator accept structured Artifact data Parts and streaming
      task updates?
- [ ] May the low-latency Seed model assist classification while DeepSeek V4
      Pro remains the required foundation model?

Record an answer and date under the corresponding item, then update this
document and every affected check.

## 5. Security

- Local organizer material under `reference/` may contain event tokens and is
  intentionally git-ignored.
- Never copy credentials into documentation, screenshots, logs, prompts, or
  public chat.
- Never expose model tokens or PandaData credentials in frontend code.

## 6. Sources

- [PandaAI Data API](https://www.pandaaiquant.com/data-service/api-docs)
- [PandaAI-Tech/panda-data](https://github.com/PandaAI-Tech/panda-data)
- [panda-data API reference](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda-data-skill/api_reference.md)
- [Financial tool implementation](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/financial.py)
- [Market reference implementation](https://raw.githubusercontent.com/PandaAI-Tech/panda-data/main/panda_tools/tools/market_ref.py)
- [Official A2A specification](https://a2a-protocol.org/latest/specification/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- [oh-my-pi runtime](https://github.com/can1357/oh-my-pi)
