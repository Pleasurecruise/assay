"""PandaData 实证探针 v2 —— 回答 DATA_NOTES §4 中可实证的问题。

v2 修正: symbol 强制带后缀格式; IncompleteRead 自动重试; 指数权重小窗口逐年测;
新增 get_index_daily / get_fina_statement / get_audit_opinion 探针。

用法（在仓库根目录）:
    cd services/panda-adapter && uv run python ../../scripts/probe_pandadata.py

前提: 仓库根 .env 内含 PANDA_DATA_USERNAME / PANDA_DATA_PASSWORD。
输出: scripts/probe_results.md 与 scripts/probe_results.json。凭证不写入任何输出。
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
RESULTS: dict = {"probes": {}, "meta": {"version": 2}}

SYM = "600519.SH"          # 强制带后缀（P0 探针实证的格式要求）
IDX = "000300.SH"


def load_env() -> None:
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def record(name: str, ok: bool, summary: str, detail=None) -> None:
    RESULTS["probes"][name] = {"ok": ok, "summary": summary, "detail": detail}
    print(f"[{'OK' if ok else 'XX'}] {name}: {summary}")


def df_brief(df) -> dict:
    try:
        return {
            "columns": list(map(str, df.columns)),
            "shape": list(df.shape),
            "head": json.loads(df.head(2).to_json(orient="records", date_format="iso")),
        }
    except Exception:
        return {"repr": repr(df)[:400]}


def call(fn, retries: int = 2, **kwargs):
    """调用并对 IncompleteRead/网络类错误重试。返回 (ok, 结果或错误串)。"""
    last = None
    for attempt in range(retries + 1):
        try:
            out = fn(**kwargs)
            return True, out
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            transient = any(s in str(e) for s in ("IncompleteRead", "timeout", "Timeout",
                                                  "Connection", "chunked"))
            if not transient or attempt == retries:
                break
            time.sleep(2.0 * (attempt + 1))
    return False, last


def probe_df(name: str, fn, note: str = "", **kwargs) -> None:
    ok, out = call(fn, **kwargs)
    if ok and out is None:
        record(name, False, f"{note} 返回 None（可能无数据或参数不符）")
    elif ok:
        record(name, True, note or "ok", df_brief(out) if hasattr(out, "columns")
               else {"sample": str(out)[:300]})
    else:
        record(name, False, f"{note} {out}"[:400])
    time.sleep(0.5)


def main() -> int:
    load_env()
    user = os.environ.get("PANDA_DATA_USERNAME")
    pwd = os.environ.get("PANDA_DATA_PASSWORD")
    if not user or not pwd:
        print("缺少 PANDA_DATA_USERNAME / PANDA_DATA_PASSWORD")
        return 1

    import panda_data  # noqa: PLC0415

    methods = sorted(m for m in dir(panda_data) if not m.startswith("_"))
    record("P0a_sdk_methods", True, f"{len(methods)} 个公开名", methods)

    ok, err = call(lambda **k: panda_data.init_token(**k), username=user, password=pwd)
    record("P0b_auth", ok, "init_token 成功" if ok else str(err))
    if not ok:
        finish()
        return 1

    # P0c/P0d 冒烟（带后缀 + 重试）
    probe_df("P0c_market_smoke", panda_data.get_market_data, "日线行情",
             symbol=SYM, start_date="20260601", end_date="20260710")
    probe_df("P0d_adj_factor", panda_data.get_adj_factor, "复权因子",
             symbol=SYM, start_date="20260601", end_date="20260710")

    # P1 因子库
    probe_df("P1a_factor_close", panda_data.get_factor, "get_factor factors=['close']",
             factors=["close"], start_date="20260706", end_date="20260710", symbol=SYM)
    hits = {}
    for fname in ["momentum", "mom", "reversal", "volatility", "turnover_rate",
                  "ratio_pe_ttm", "market_cap", "pb", "roe"]:
        ok, out = call(panda_data.get_factor, retries=0,
                       factors=[fname], start_date="20260706", end_date="20260708", symbol=SYM)
        if ok and out is not None and getattr(out, "shape", (0,))[0] > 0:
            hits[fname] = f"有 (shape={list(out.shape)}, cols={list(map(str, out.columns))[:6]})"
        elif ok:
            hits[fname] = "调用成功但空/None"
        else:
            hits[fname] = f"错: {str(out)[:100]}"
        time.sleep(0.4)
    record("P1b_factor_names", True, "策略型/常见因子名可用性", hits)
    # P1c 时点语义: close 因子 vs 行情收盘 同日对照
    ok1, f = call(panda_data.get_factor, factors=["close"],
                  start_date="20260706", end_date="20260710", symbol=SYM)
    ok2, m = call(panda_data.get_market_data, symbol=SYM,
                  start_date="20260706", end_date="20260710")
    if ok1 and ok2 and f is not None and m is not None:
        record("P1c_factor_timing_raw", True, "两表同日 close 值人工比对",
               {"factor": df_brief(f), "market": df_brief(m)})
    else:
        record("P1c_factor_timing_raw", False, f"factor: {ok1} market: {ok2}")

    # P2 季度财务: 全列名 + is_latest=False 版本
    probe_df("P2a_fina_columns", panda_data.get_fina_reports, "季报（默认 is_latest）",
             symbol=SYM, start_quarter="2025q1", end_quarter="2025q4")
    probe_df("P2b_fina_versions", panda_data.get_fina_reports, "季报多版本",
             symbol=SYM, start_quarter="2025q1", end_quarter="2025q2", is_latest=False)
    if hasattr(panda_data, "get_fina_statement"):
        probe_df("P2c_fina_statement", panda_data.get_fina_statement, "get_fina_statement 列名",
                 symbol=SYM, start_quarter="2025q1", end_quarter="2025q2")
    if hasattr(panda_data, "get_audit_opinion"):
        probe_df("P2d_audit_opinion", panda_data.get_audit_opinion, "审计意见列名", symbol=SYM)

    # P3 预告/快报 info_date
    probe_df("P3a_forecast", panda_data.get_fina_forecast, "业绩预告", symbol=SYM)
    probe_df("P3b_performance", panda_data.get_fina_performance, "业绩快报", symbol=SYM)

    # P4 指数权重最早覆盖（小窗口 3 个交易日，独立记录每年）
    coverage = {}
    for start, end in [("20100104", "20100106"), ("20140106", "20140108"),
                       ("20160104", "20160106"), ("20180102", "20180104"),
                       ("20200102", "20200106"), ("20230103", "20230105"),
                       ("20260105", "20260107")]:
        ok, out = call(panda_data.get_index_weights,
                       index_symbol=IDX, start_date=start, end_date=end)
        if ok and out is not None:
            coverage[start[:4]] = f"{int(out.shape[0])} 行"
        else:
            coverage[start[:4]] = f"错/空: {str(out)[:80]}"
        time.sleep(0.5)
    record("P4_index_weights_coverage", True, "各年份 3 日窗口行数（找最早覆盖）", coverage)

    # P4b 指数日线（regime 检查的直取路径）
    if hasattr(panda_data, "get_index_daily"):
        probe_df("P4b_index_daily", panda_data.get_index_daily, "指数日线",
                 symbol=IDX, start_date="20260601", end_date="20260710")

    # P5 行业成分（level 传字符串）
    probe_df("P5_industry_fields", panda_data.get_industry_constituents, "行业成分",
             stock_symbol=SYM)
    ok, out = call(panda_data.get_industry_constituents, level="1")
    record("P5b_industry_level1", ok and out is not None,
           "level='1' 全行业" if ok else str(out)[:200],
           df_brief(out) if ok and out is not None and hasattr(out, "columns") else None)

    # P6 五年上限行为（正确格式重测）
    ok, out = call(panda_data.get_market_data, symbol=SYM,
                   start_date="20200102", end_date="20260101")
    if ok and out is not None:
        record("P6_five_year_limit", True,
               f"6 年查询成功 shape={list(out.shape)}（约 1456 交易日为全量；明显少于此即静默截断）",
               {"rows": int(out.shape[0])})
    else:
        record("P6_five_year_limit", True, f"6 年查询明确报错: {str(out)[:200]}")

    # P7 名单与状态
    probe_df("P7b_trade_list", panda_data.get_trade_list, "可交易名单（大响应,靠重试）",
             date="20260706")
    probe_df("P7c_status_change", panda_data.get_stock_status_change, "ST 状态变化", symbol=SYM)

    finish()
    return 0


def finish() -> None:
    RESULTS["meta"]["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    (SCRIPT_DIR / "probe_results.json").write_text(
        json.dumps(RESULTS, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    lines = ["# PandaData 探针结果 v2", "", f"生成时间: {RESULTS['meta']['generated_at']}", ""]
    for name, r in RESULTS["probes"].items():
        lines.append(f"## {name} — {'✅' if r['ok'] else '❌'} {r['summary']}")
        if r.get("detail") is not None:
            lines.append("```json")
            lines.append(json.dumps(r["detail"], ensure_ascii=False, indent=2, default=str)[:3000])
            lines.append("```")
        lines.append("")
    (SCRIPT_DIR / "probe_results.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果已写入 {SCRIPT_DIR / 'probe_results.md'} 与 probe_results.json")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        finish()
        sys.exit(1)
