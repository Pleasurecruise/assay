"""Prepare deterministic, offline inputs for the cross-language Moiré fixture.

This helper only prepares host-owned caches.  The fixture test subsequently
executes the production ``panda_adapter.moire_stdio`` boundary for M1 and M2.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
import pandas as pd

from panda_adapter.audit_cache import (
    V9_CACHE_MANIFEST_SCHEMA_VERSION,
    V9_CACHE_VERSION,
)
from panda_adapter.availability_audit import PIT_DATASET_VERSION
from panda_adapter.engine.artifacts import persist_grid_daily_returns
from panda_adapter.engine.strategy import parse_momentum_strategy
from panda_adapter.market_panel import INDEX_SYMBOL, MarketPanel
from panda_adapter.moire_audit import (
    MOIRE_GRID_TOP_NS,
    MOIRE_GRID_WINDOWS,
    persist_corrected_backtest_context,
)
from panda_adapter.regime_audit import label_regimes


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    return parser.parse_args()


def _daily_rows(
    dates: pd.DatetimeIndex,
    returns: list[float],
) -> list[dict[str, Any]]:
    equity = 1.0
    rows: list[dict[str, Any]] = []
    for date, daily_return in zip(dates, returns, strict=True):
        equity *= 1.0 + daily_return
        rows.append(
            {
                "date": date.strftime("%Y-%m-%d"),
                "return": daily_return,
                "equity": equity,
            }
        )
    return rows


def _synthetic_panel(dates: pd.DatetimeIndex) -> MarketPanel:
    positions = np.arange(len(dates), dtype=float)
    prices = pd.DataFrame(
        {
            "A": (
                100.0
                * np.exp(-0.0005 * positions)
                * (1.0 + 0.0010 * np.sin(positions / 3.0))
            ),
            "B": 100.0 * np.power(1.008, positions),
            "C": (
                110.0
                * np.exp(-0.0004 * positions)
                * (1.0 + 0.0012 * np.sin(positions / 4.0))
            ),
            "D": (
                120.0
                * np.exp(-0.0003 * positions)
                * (1.0 + 0.0014 * np.sin(positions / 5.0))
            ),
        },
        index=dates,
    )
    return MarketPanel(
        adjusted_close=prices,
        tradable=pd.DataFrame(True, index=dates, columns=prices.columns),
    )


def _synthetic_index(dates: pd.DatetimeIndex) -> pd.Series:
    positions = np.arange(len(dates), dtype=float)
    return pd.Series(
        100.0
        * np.exp(0.0002 * positions)
        * (1.0 + 0.03 * np.sin(positions / 8.0)),
        index=dates,
        dtype=float,
    )


def _write_market_cache(panel: MarketPanel, path: Path) -> None:
    rows: list[dict[str, Any]] = []
    for date in panel.adjusted_close.index:
        for symbol in panel.adjusted_close.columns:
            rows.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "adjClose": float(panel.adjusted_close.loc[date, symbol]),
                    "tradeStatus": 0,
                }
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(path, index=False)


def _write_index_cache(
    index_close: pd.Series,
    root: Path,
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "index-daily.csv"
    pd.DataFrame(
        {
            "date": [
                pd.Timestamp(value).strftime("%Y-%m-%d")
                for value in index_close.index
            ],
            "symbol": INDEX_SYMBOL,
            "close": index_close.to_numpy(dtype=float),
        }
    ).to_csv(path, index=False)
    manifest = {
        "schemaVersion": V9_CACHE_MANIFEST_SCHEMA_VERSION,
        "cacheVersion": V9_CACHE_VERSION,
        "datasets": {
            "indexDaily": {
                "status": "ready",
                "path": path.name,
            }
        },
    }
    (root / "manifest.json").write_text(
        json.dumps(
            manifest,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def _returns_for_labels(
    labels: pd.DataFrame,
    *,
    preserve_dominant: bool,
) -> list[float]:
    counts: dict[str, int] = {}
    result: list[float] = []
    for environment in labels["id"].tolist():
        if not isinstance(environment, str):
            result.append(0.0)
            continue
        offset = counts.get(environment, 0)
        counts[environment] = offset + 1
        if environment == "up-normal":
            low, high = (0.002, 0.006)
        elif preserve_dominant:
            low, high = (-0.0002, 0.0006)
        else:
            low, high = (0.0002, 0.0006)
        result.append(low if offset % 2 == 0 else high)
    return result


def _write_grid_artifacts(
    dates: pd.DatetimeIndex,
    index_close: pd.Series,
    root: Path,
) -> None:
    labels = label_regimes(index_close, dates)
    baseline_returns = _returns_for_labels(labels, preserve_dominant=False)
    persist_grid_daily_returns(
        variant_id="baseline",
        parameters={"window": 20, "topN": 4, "costModel": "none"},
        daily_returns=_daily_rows(dates, baseline_returns),
        root=root,
    )
    variant_returns = _returns_for_labels(labels, preserve_dominant=True)
    for window in MOIRE_GRID_WINDOWS:
        for top_n in MOIRE_GRID_TOP_NS:
            variant_id = f"w{window}-n{top_n}"
            persist_grid_daily_returns(
                variant_id=variant_id,
                parameters={
                    "variantId": variant_id,
                    "window": window,
                    "topN": top_n,
                    "costModel": "none",
                },
                daily_returns=_daily_rows(dates, variant_returns),
                root=root,
            )


def main() -> int:
    arguments = _arguments()
    spec: Any = json.load(sys.stdin)
    if not isinstance(spec, dict):
        raise ValueError("fixture spec must be an object")
    strategy = parse_momentum_strategy(spec)
    if strategy != {"window": 20, "top_n": 4, "cost_model": "none"}:
        raise ValueError("fixture spec does not match the frozen mechanism case")
    window = spec.get("window")
    if not isinstance(window, dict):
        raise ValueError("fixture spec window is invalid")
    dates = pd.bdate_range(
        pd.Timestamp(window["start"]),
        pd.Timestamp(window["end"]),
    )
    if len(dates) != 360:
        raise ValueError("fixture window must contain exactly 360 business days")

    root = arguments.root
    panel = _synthetic_panel(dates)
    index_close = _synthetic_index(dates)
    _write_market_cache(panel, root / "market.csv")
    _write_index_cache(index_close, root / "v9-cache")
    _write_grid_artifacts(dates, index_close, root / "backtest")

    eligible = pd.DataFrame(
        True,
        index=dates,
        columns=panel.adjusted_close.columns,
        dtype=bool,
    )
    eligible.loc[:, "B"] = False
    persist_corrected_backtest_context(
        spec=spec,
        panel=panel,
        eligible=eligible,
        availability_mode="full_pit",
        cache_version=V9_CACHE_VERSION,
        pit_dataset_version=PIT_DATASET_VERSION,
        pit_cache_root=root / "pit",
    )
    sys.stdout.write('{"prepared":true}\n')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
