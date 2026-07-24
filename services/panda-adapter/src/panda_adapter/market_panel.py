"""Minimal local-cache-first panel loader for the sprint experiment process.

The live fallback deliberately uses one constituent snapshot at the requested
end date. This is not point-in-time membership and introduces survivorship
bias; replacing it is sprint-backlog work.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
import os
import subprocess
import sys
from typing import Any

import pandas as pd

DEFAULT_CACHE_PATH = Path(".cache/assay/csi300-3y.csv")
INDEX_SYMBOL = "000300.SH"
TRADABLE_TRADE_STATUS = 0
ADAPTER_ROOT = Path(__file__).resolve().parents[2]
RESUMABLE_CACHE_BUILDER = ADAPTER_ROOT / "scripts" / "prepare_csi300_cache.py"


@dataclass(frozen=True, slots=True)
class MarketPanel:
    adjusted_close: pd.DataFrame
    tradable: pd.DataFrame


def _require_csi300_universe(spec: Mapping[str, Any]) -> None:
    universe = spec.get("universe")
    if (
        not isinstance(universe, Mapping)
        or universe.get("index") != INDEX_SYMBOL
    ):
        raise ValueError(f"spec.universe.index must equal {INDEX_SYMBOL}")


def load_market_panel(spec: Mapping[str, Any]) -> MarketPanel:
    """Load long-form CSV cache, downloading a fixed universe when absent."""

    _require_csi300_universe(spec)
    cache_path = Path(
        os.environ.get("ASSAY_MARKET_DATA_CACHE", str(DEFAULT_CACHE_PATH))
    )
    if not cache_path.exists():
        _download_fixed_universe_cache(spec, cache_path)
    return _read_cache(cache_path, spec)


def _read_cache(path: Path, spec: Mapping[str, Any]) -> MarketPanel:
    if path.suffix.lower() == ".parquet":
        values = pd.read_parquet(path)
    else:
        values = pd.read_csv(path)
    required = {"date", "symbol", "adjClose", "tradeStatus"}
    missing = sorted(required - set(values.columns))
    if missing:
        raise ValueError(f"market cache missing columns: {', '.join(missing)}")

    values = values[["date", "symbol", "adjClose", "tradeStatus"]].copy()
    values["date"] = pd.to_datetime(values["date"])
    values["symbol"] = values["symbol"].astype(str)
    values["adjClose"] = pd.to_numeric(values["adjClose"], errors="coerce")
    values["tradeStatus"] = pd.to_numeric(
        values["tradeStatus"],
        errors="coerce",
    )
    if values["date"].isna().any():
        raise ValueError("market cache contains an invalid date")
    if values["symbol"].str.strip().eq("").any():
        raise ValueError("market cache contains an empty symbol")
    if values.duplicated(["date", "symbol"]).any():
        raise ValueError("market cache contains duplicate date/symbol keys")
    if (
        not values["adjClose"].map(isfinite).all()
        or (values["adjClose"] <= 0).any()
    ):
        raise ValueError("market cache adjusted close must be finite and positive")
    if (
        values["tradeStatus"].isna().any()
        or (values["tradeStatus"] % 1 != 0).any()
    ):
        raise ValueError("market cache tradeStatus must contain integers")
    values["tradeStatus"] = values["tradeStatus"].astype(int)
    window = spec.get("window")
    if isinstance(window, Mapping):
        if isinstance(window.get("start"), str):
            values = values[values["date"] >= pd.to_datetime(window["start"])]
        if isinstance(window.get("end"), str):
            values = values[values["date"] <= pd.to_datetime(window["end"])]
    adjusted_close = (
        values.pivot(index="date", columns="symbol", values="adjClose")
        .sort_index()
        .sort_index(axis=1)
    )
    if adjusted_close.empty:
        raise ValueError("market cache has no rows for the requested window")
    trade_status = values.pivot(
        index="date",
        columns="symbol",
        values="tradeStatus",
    ).reindex(
        index=adjusted_close.index,
        columns=adjusted_close.columns,
    )
    tradable = trade_status.eq(TRADABLE_TRADE_STATUS).fillna(False).astype(bool)
    return MarketPanel(adjusted_close=adjusted_close, tradable=tradable)


def _api_date(value: str) -> str:
    return pd.Timestamp(value).strftime("%Y%m%d")


def _download_fixed_universe_cache(
    spec: Mapping[str, Any],
    cache_path: Path,
) -> None:
    _require_csi300_universe(spec)
    window = spec.get("window")
    if not isinstance(window, Mapping):
        raise ValueError("spec.window is required to download market data")
    start = window.get("start")
    end = window.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        raise ValueError("spec.window start and end are required")

    if not RESUMABLE_CACHE_BUILDER.is_file():
        raise RuntimeError("resumable market cache builder is unavailable")
    absolute_cache_path = cache_path.resolve()
    command = [
        sys.executable,
        str(RESUMABLE_CACHE_BUILDER),
        "cache",
        "--start",
        _api_date(start),
        "--end",
        _api_date(end),
        "--output",
        str(absolute_cache_path),
    ]
    completed = subprocess.run(
        command,
        cwd=ADAPTER_ROOT.parents[1],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not absolute_cache_path.is_file():
        # The builder owns retry/split/resume details. Do not leak provider
        # errors, local paths, or credential-adjacent stderr across S0.
        raise RuntimeError("resumable market cache builder failed")
