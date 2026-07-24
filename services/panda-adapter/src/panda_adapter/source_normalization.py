"""Canonical normalization shared by market-cache and PIT data acquisition."""

from __future__ import annotations

from collections.abc import Iterable
import math
from typing import Any, Literal

import pandas as pd

SourceName = Literal["factor-close", "trade-status"]

SOURCE_VALUE_COLUMNS: dict[SourceName, str] = {
    "factor-close": "adjClose",
    "trade-status": "tradeStatus",
}


def as_frame(value: Any, name: str) -> pd.DataFrame:
    if isinstance(value, pd.DataFrame):
        return value.copy()
    if isinstance(value, dict):
        rows = value.get("rows", value.get("data", value))
        return pd.DataFrame(rows)
    if isinstance(value, list):
        return pd.DataFrame(value)
    raise RuntimeError(f"{name} returned unsupported type {type(value).__name__}")


def find_column(
    frame: pd.DataFrame,
    candidates: Iterable[str],
    name: str,
) -> str:
    by_lower = {str(column).lower(): str(column) for column in frame.columns}
    for candidate in candidates:
        matched = by_lower.get(candidate.lower())
        if matched is not None:
            return matched
    raise RuntimeError(
        f"{name} response is missing one of these columns: " f"{', '.join(candidates)}"
    )


def optional_column(
    frame: pd.DataFrame,
    candidates: Iterable[str],
) -> str | None:
    by_lower = {str(column).lower(): str(column) for column in frame.columns}
    return next(
        (
            matched
            for candidate in candidates
            if (matched := by_lower.get(candidate.lower())) is not None
        ),
        None,
    )


def normalized_dates(values: pd.Series) -> pd.Series:
    text = values.astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    return pd.to_datetime(text, format="mixed", errors="coerce")


def normalize_symbols(
    values: Iterable[Any],
    *,
    context: str,
) -> list[str]:
    symbols = sorted(
        {
            str(value).strip().upper()
            for value in values
            if not pd.isna(value) and str(value).strip()
        }
    )
    if not symbols:
        raise RuntimeError(f"{context} returned no constituent symbols")
    return symbols


def symbols_from_weights(
    value: Any,
    *,
    requested_date: pd.Timestamp | None = None,
) -> tuple[list[str], str]:
    """Return the latest non-future constituent snapshot in a response."""

    frame = as_frame(value, "get_index_weights")
    date_column = optional_column(
        frame,
        ("date", "trade_date", "datetime"),
    )
    snapshot_date = "unknown"
    if date_column is not None:
        dates = normalized_dates(frame[date_column])
        if dates.isna().any():
            raise RuntimeError("get_index_weights returned an invalid snapshot date")
        if requested_date is not None:
            eligible = dates <= requested_date
            if not eligible.any():
                raise RuntimeError("get_index_weights returned no non-future snapshot")
            frame = frame[eligible]
            dates = dates[eligible]
        latest = dates.max()
        if not pd.isna(latest):
            frame = frame[dates == latest]
            snapshot_date = pd.Timestamp(latest).strftime("%Y-%m-%d")
    elif requested_date is not None:
        snapshot_date = requested_date.strftime("%Y-%m-%d")

    symbol_column = find_column(
        frame,
        ("stock_symbol", "symbol", "stock_code", "con_code", "code"),
        "get_index_weights",
    )
    return (
        normalize_symbols(
            frame[symbol_column].tolist(),
            context="get_index_weights",
        ),
        snapshot_date,
    )


def normalize_source_frame(
    value: Any,
    *,
    source: SourceName,
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Iterable[str],
    context: str,
) -> pd.DataFrame:
    """Convert an endpoint response into a strictly scoped source fragment."""

    requested_symbols = tuple(sorted(set(symbols)))
    frame = as_frame(value, context)
    value_column = SOURCE_VALUE_COLUMNS[source]
    if frame.empty and not len(frame.columns):
        return pd.DataFrame(columns=["date", "symbol", value_column])

    date_column = find_column(
        frame,
        ("date", "trade_date", "datetime"),
        context,
    )
    symbol_column = find_column(
        frame,
        ("symbol", "stock_symbol", "stock_code", "code"),
        context,
    )
    raw_value_column = (
        find_column(frame, ("adjClose", "close"), context)
        if source == "factor-close"
        else find_column(
            frame,
            ("tradeStatus", "trade_status"),
            context,
        )
    )

    selected = frame[[date_column, symbol_column, raw_value_column]].copy()
    if selected.isna().any().any():
        raise RuntimeError(f"{context} contains missing canonical values")
    selected.columns = ["date", "symbol", value_column]
    selected["date"] = normalized_dates(selected["date"])
    selected["symbol"] = selected["symbol"].astype(str).str.strip().str.upper()
    selected[value_column] = pd.to_numeric(
        selected[value_column],
        errors="coerce",
    )
    if selected[["date", value_column]].isna().any().any():
        raise RuntimeError(f"{context} contains invalid canonical values")

    outside_symbols = set(selected["symbol"]) - set(requested_symbols)
    if outside_symbols:
        raise RuntimeError(f"{context} returned rows outside requested symbols")
    outside_window = ~selected["date"].between(start_date, end_date)
    if outside_window.any():
        raise RuntimeError(f"{context} returned rows outside requested window")
    if selected.duplicated(["date", "symbol"]).any():
        raise RuntimeError(f"{context} contains duplicate symbol/date keys")

    finite = selected[value_column].map(math.isfinite)
    if source == "factor-close":
        if (~finite).any() or (selected[value_column] <= 0).any():
            raise RuntimeError(
                f"{context} contains nonpositive or nonfinite factor close"
            )
    else:
        integral = selected[value_column].mod(1).eq(0)
        if (~finite).any() or (~integral).any():
            raise RuntimeError(
                f"{context} contains nonintegral or nonfinite trade status"
            )
        selected[value_column] = selected[value_column].astype(int)

    selected["date"] = selected["date"].dt.strftime("%Y-%m-%d")
    return selected.sort_values(["date", "symbol"]).reset_index(drop=True)
