"""Operator-run PandaData smoke test and resumable CSI 300 cache builder.

Credentials are read only through ``PANDA_DATA_USERNAME`` and
``PANDA_DATA_PASSWORD`` by ``create_initialized_client``. This sprint uses a
single current constituent query for speed. The resulting cache therefore has
survivorship bias and must be reported as a limitation; it is not PIT data.

The v3 cache layout follows measured PandaData throughput:

* ``get_factor(close)`` is requested for the full universe in seven-calendar-
  day windows.
* The union of returned factor dates defines the trading dates.
* ``get_market_data(trade_status)`` is requested for the full universe one
  trading day at a time.

Each source fragment is an atomic JSON payload carrying the dataset version,
full-universe hash, request window, and exact requested symbol subset. A
transport failure first splits factor windows by date; a single factor date or
any status date then splits by symbol list. Persistent split markers make
restarts follow the same tree and fetch only missing leaves.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Literal

import pandas as pd

from panda_adapter.client import create_initialized_client
from panda_adapter.data_transport import (
    DataTransportError,
    RetryPolicy,
    retry_transport,
)

INDEX_SYMBOL = "000300.SH"
DEFAULT_OUTPUT = Path(".cache/assay/csi300-3y.csv")
DEFAULT_BATCH_SIZE = 100
FACTOR_WINDOW_DAYS = 7
FRAGMENT_RETRY_POLICY = RetryPolicy(
    max_attempts=5,
    initial_delay_seconds=0.1,
    max_delay_seconds=0.2,
)
CREDENTIAL_KEYS = ("PANDA_DATA_USERNAME", "PANDA_DATA_PASSWORD")
DATASET_VERSION = "factor-close-trade-status-v3"
FRAGMENT_SCHEMA_VERSION = "horizontal-fragment-v1"
SPLIT_MARKER_VERSION = "horizontal-split-v1"
SourceName = Literal["factor-close", "trade-status"]
SplitAxis = Literal["date", "symbols"]
SOURCE_VALUE_COLUMNS: dict[SourceName, str] = {
    "factor-close": "adjClose",
    "trade-status": "tradeStatus",
}


@dataclass(frozen=True, slots=True)
class FragmentRequest:
    source: SourceName
    start_date: pd.Timestamp
    end_date: pd.Timestamp
    symbols: tuple[str, ...]
    universe_hash: str
    universe_size: int


@dataclass(slots=True)
class BuildStats:
    downloaded: int = 0
    reused: int = 0
    split: int = 0
    status_only_dropped: int = 0


def _load_repo_credentials(path: Path = Path(".env")) -> None:
    """Load only PandaData keys without executing the dotenv file as shell."""

    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if key not in CREDENTIAL_KEYS or key in os.environ:
            continue
        value = value.strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        os.environ[key] = value


def _as_frame(value: Any, name: str) -> pd.DataFrame:
    if isinstance(value, pd.DataFrame):
        return value.copy()
    if isinstance(value, dict):
        rows = value.get("rows", value.get("data", value))
        return pd.DataFrame(rows)
    if isinstance(value, list):
        return pd.DataFrame(value)
    raise RuntimeError(f"{name} returned unsupported type {type(value).__name__}")


def _column(frame: pd.DataFrame, candidates: Iterable[str], name: str) -> str:
    by_lower = {str(column).lower(): str(column) for column in frame.columns}
    for candidate in candidates:
        matched = by_lower.get(candidate.lower())
        if matched is not None:
            return matched
    raise RuntimeError(
        f"{name} response is missing one of these columns: "
        f"{', '.join(candidates)}"
    )


def _optional_column(
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


def _normalized_dates(values: pd.Series) -> pd.Series:
    text = values.astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    return pd.to_datetime(text, format="mixed", errors="coerce")


def _normalize_symbols(values: Iterable[Any], *, context: str) -> list[str]:
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


def _symbols_from_weights(value: Any) -> tuple[list[str], str]:
    frame = _as_frame(value, "get_index_weights")
    date_column = _optional_column(frame, ("date", "trade_date", "datetime"))
    snapshot_date = "unknown"
    if date_column is not None:
        dates = _normalized_dates(frame[date_column])
        latest = dates.max()
        if not pd.isna(latest):
            frame = frame[dates == latest]
            snapshot_date = latest.strftime("%Y-%m-%d")
    symbol_column = _column(
        frame,
        ("stock_symbol", "symbol", "stock_code", "con_code", "code"),
        "get_index_weights",
    )
    return (
        _normalize_symbols(
            frame[symbol_column].tolist(),
            context="get_index_weights",
        ),
        snapshot_date,
    )


def _symbols_from_cache(path: Path) -> tuple[list[str], str]:
    frame = pd.read_csv(path, usecols=["date", "symbol"], dtype={"symbol": str})
    symbols = _normalize_symbols(
        frame["symbol"].tolist(),
        context=f"constituent cache {path}",
    )
    dates = _normalized_dates(frame["date"])
    latest = dates.max()
    snapshot_date = "unknown" if pd.isna(latest) else latest.strftime("%Y-%m-%d")
    return symbols, snapshot_date


def _parse_boundary(value: str, name: str) -> pd.Timestamp:
    parsed = pd.to_datetime(value, format="mixed", errors="coerce")
    if pd.isna(parsed):
        raise ValueError(f"{name} is not a valid date: {value}")
    return pd.Timestamp(parsed).normalize()


def _factor_windows(
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> Iterable[tuple[pd.Timestamp, pd.Timestamp]]:
    """Yield contiguous seven-calendar-day factor windows."""

    cursor = start_date
    while cursor <= end_date:
        chunk_end = min(
            cursor + pd.Timedelta(days=FACTOR_WINDOW_DAYS - 1),
            end_date,
        )
        yield cursor, chunk_end
        cursor = chunk_end + pd.Timedelta(days=1)


def _universe_hash(symbols: Iterable[str]) -> str:
    canonical = "\n".join(symbols).encode("utf-8")
    return sha256(canonical).hexdigest()[:16]


def _subset_hash(symbols: Iterable[str]) -> str:
    canonical = "\n".join(symbols).encode("utf-8")
    return sha256(canonical).hexdigest()[:16]


def _parts_root(
    output: Path,
    universe_hash: str,
    universe_size: int,
) -> Path:
    return (
        output.parent
        / f".{output.stem}-{DATASET_VERSION}.parts"
        / f"universe-{universe_size}-{universe_hash}"
    )


def _fragment_path(output: Path, request: FragmentRequest) -> Path:
    date_range = (
        f"{request.start_date.strftime('%Y%m%d')}-"
        f"{request.end_date.strftime('%Y%m%d')}"
    )
    subset = _subset_hash(request.symbols)
    filename = f"symbols-{len(request.symbols)}-{subset}.part.json"
    return (
        _parts_root(
            output,
            request.universe_hash,
            request.universe_size,
        )
        / request.source
        / date_range
        / filename
    )


def _split_marker_path(fragment_path: Path) -> Path:
    return fragment_path.with_name(
        fragment_path.name.removesuffix(".part.json") + ".split.json"
    )


def _request_metadata(request: FragmentRequest) -> dict[str, Any]:
    return {
        "datasetVersion": DATASET_VERSION,
        "fragmentSchemaVersion": FRAGMENT_SCHEMA_VERSION,
        "source": request.source,
        "start": request.start_date.strftime("%Y-%m-%d"),
        "end": request.end_date.strftime("%Y-%m-%d"),
        "symbols": list(request.symbols),
        "universeHash": request.universe_hash,
        "universeSize": request.universe_size,
    }


def _write_bytes_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _write_json_atomic(path: Path, value: Any) -> None:
    content = json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    _write_bytes_atomic(path, content)


def _write_frame_atomic(path: Path, frame: pd.DataFrame) -> None:
    _write_bytes_atomic(path, frame.to_csv(index=False).encode("utf-8"))


def _empty_source_frame(source: SourceName) -> pd.DataFrame:
    return pd.DataFrame(columns=["date", "symbol", SOURCE_VALUE_COLUMNS[source]])


def _normalize_source_frame(
    value: Any,
    request: FragmentRequest,
    *,
    context: str,
) -> pd.DataFrame:
    """Convert one endpoint response into a strictly scoped source fragment."""

    frame = _as_frame(value, context)
    value_column = SOURCE_VALUE_COLUMNS[request.source]
    if frame.empty and not len(frame.columns):
        return _empty_source_frame(request.source)

    date_column = _column(frame, ("date", "trade_date", "datetime"), context)
    symbol_column = _column(
        frame,
        ("symbol", "stock_symbol", "stock_code", "code"),
        context,
    )
    if request.source == "factor-close":
        raw_value_column = _column(frame, ("adjClose", "close"), context)
    else:
        raw_value_column = _column(
            frame,
            ("tradeStatus", "trade_status"),
            context,
        )

    selected = frame[[date_column, symbol_column, raw_value_column]].copy()
    if selected.isna().any().any():
        raise RuntimeError(f"{context} contains missing canonical values")
    selected.columns = ["date", "symbol", value_column]
    selected["date"] = _normalized_dates(selected["date"])
    selected["symbol"] = (
        selected["symbol"].astype(str).str.strip().str.upper()
    )
    selected[value_column] = pd.to_numeric(
        selected[value_column],
        errors="coerce",
    )
    if selected[["date", value_column]].isna().any().any():
        raise RuntimeError(f"{context} contains invalid canonical values")

    requested_symbols = set(request.symbols)
    outside_symbols = set(selected["symbol"]) - requested_symbols
    if outside_symbols:
        raise RuntimeError(f"{context} returned rows outside requested symbols")
    outside_window = ~selected["date"].between(
        request.start_date,
        request.end_date,
    )
    if outside_window.any():
        raise RuntimeError(f"{context} returned rows outside requested window")
    if selected.duplicated(["date", "symbol"]).any():
        raise RuntimeError(f"{context} contains duplicate symbol/date keys")

    finite = selected[value_column].map(math.isfinite)
    if request.source == "factor-close":
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


def _frame_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return json.loads(
        frame.to_json(orient="records", double_precision=15)
    )


def _write_fragment(
    output: Path,
    request: FragmentRequest,
    frame: pd.DataFrame,
) -> None:
    normalized = _normalize_source_frame(
        frame,
        request,
        context=f"materialized {request.source} fragment",
    )
    payload = {
        "request": _request_metadata(request),
        "rows": _frame_records(normalized),
    }
    _write_json_atomic(_fragment_path(output, request), payload)


def _read_fragment(
    output: Path,
    request: FragmentRequest,
) -> pd.DataFrame:
    path = _fragment_path(output, request)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read cached source fragment: {path}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"cached source fragment is not an object: {path}")
    if payload.get("request") != _request_metadata(request):
        raise RuntimeError(f"cached source fragment identity mismatch: {path}")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError(f"cached source fragment rows are invalid: {path}")
    return _normalize_source_frame(
        rows,
        request,
        context=f"cached {request.source} fragment {path}",
    )


def _split_date_request(
    request: FragmentRequest,
) -> tuple[FragmentRequest, FragmentRequest] | None:
    if request.start_date >= request.end_date:
        return None
    midpoint = request.start_date + pd.Timedelta(
        days=(request.end_date - request.start_date).days // 2
    )
    return (
        FragmentRequest(
            source=request.source,
            start_date=request.start_date,
            end_date=midpoint,
            symbols=request.symbols,
            universe_hash=request.universe_hash,
            universe_size=request.universe_size,
        ),
        FragmentRequest(
            source=request.source,
            start_date=midpoint + pd.Timedelta(days=1),
            end_date=request.end_date,
            symbols=request.symbols,
            universe_hash=request.universe_hash,
            universe_size=request.universe_size,
        ),
    )


def _split_symbol_request(
    request: FragmentRequest,
) -> tuple[FragmentRequest, FragmentRequest] | None:
    if len(request.symbols) <= 1:
        return None
    midpoint = len(request.symbols) // 2
    return (
        FragmentRequest(
            source=request.source,
            start_date=request.start_date,
            end_date=request.end_date,
            symbols=request.symbols[:midpoint],
            universe_hash=request.universe_hash,
            universe_size=request.universe_size,
        ),
        FragmentRequest(
            source=request.source,
            start_date=request.start_date,
            end_date=request.end_date,
            symbols=request.symbols[midpoint:],
            universe_hash=request.universe_hash,
            universe_size=request.universe_size,
        ),
    )


def _split_request(
    request: FragmentRequest,
) -> tuple[SplitAxis, tuple[FragmentRequest, FragmentRequest]] | None:
    if request.source == "factor-close":
        date_children = _split_date_request(request)
        if date_children is not None:
            return "date", date_children
    symbol_children = _split_symbol_request(request)
    if symbol_children is not None:
        return "symbols", symbol_children
    return None


def _split_marker_payload(
    request: FragmentRequest,
    axis: SplitAxis,
    children: tuple[FragmentRequest, FragmentRequest],
) -> dict[str, Any]:
    return {
        "markerVersion": SPLIT_MARKER_VERSION,
        "request": _request_metadata(request),
        "splitAxis": axis,
        "children": [_request_metadata(child) for child in children],
    }


def _write_split_marker(
    output: Path,
    request: FragmentRequest,
    axis: SplitAxis,
    children: tuple[FragmentRequest, FragmentRequest],
) -> None:
    _write_json_atomic(
        _split_marker_path(_fragment_path(output, request)),
        _split_marker_payload(request, axis, children),
    )


def _read_split_marker(
    output: Path,
    request: FragmentRequest,
    expected_axis: SplitAxis,
    expected_children: tuple[FragmentRequest, FragmentRequest],
) -> None:
    path = _split_marker_path(_fragment_path(output, request))
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read cache split marker: {path}") from error
    expected = _split_marker_payload(
        request,
        expected_axis,
        expected_children,
    )
    if payload != expected:
        raise RuntimeError(f"cache split marker identity mismatch: {path}")


def _download_fragment(
    client: Any,
    request: FragmentRequest,
) -> pd.DataFrame:
    start_text = request.start_date.strftime("%Y%m%d")
    end_text = request.end_date.strftime("%Y%m%d")
    symbols = list(request.symbols)
    if request.source == "factor-close":
        value = retry_transport(
            f"get_factor(close) {start_text}-{end_text} "
            f"symbols={len(symbols)}",
            lambda: client.get_factor(
                symbol=symbols,
                start_date=start_text,
                end_date=end_text,
                factors=["close"],
                type="stock",
            ),
            policy=FRAGMENT_RETRY_POLICY,
        )
        context = "get_factor(close)"
    else:
        if request.start_date != request.end_date:
            raise RuntimeError("trade-status fragment must cover one date")
        value = retry_transport(
            f"get_market_data(trade_status) {start_text} "
            f"symbols={len(symbols)}",
            lambda: client.get_market_data(
                symbol=symbols,
                start_date=start_text,
                end_date=end_text,
                fields=["symbol", "date", "trade_status"],
                type="stock",
            ),
            policy=FRAGMENT_RETRY_POLICY,
        )
        context = "get_market_data(trade_status)"
    return _normalize_source_frame(value, request, context=context)


def _combine_source_frames(
    values: list[pd.DataFrame],
    request: FragmentRequest,
    *,
    context: str,
) -> pd.DataFrame:
    if not values:
        return _empty_source_frame(request.source)
    return _normalize_source_frame(
        pd.concat(values, ignore_index=True),
        request,
        context=context,
    )


def _materialize_fragment(
    client: Any,
    output: Path,
    request: FragmentRequest,
    stats: BuildStats,
) -> pd.DataFrame:
    """Read or fetch a fragment, following a persistent split tree."""

    fragment_path = _fragment_path(output, request)
    if fragment_path.exists():
        stats.reused += 1
        return _read_fragment(output, request)

    split_plan = _split_request(request)
    marker_path = _split_marker_path(fragment_path)
    if marker_path.exists():
        if split_plan is None:
            raise RuntimeError(
                f"unsplittable fragment has a split marker: {marker_path}"
            )
        axis, children = split_plan
        _read_split_marker(output, request, axis, children)
        stats.split += 1
    else:
        try:
            downloaded = _download_fragment(client, request)
        except DataTransportError:
            if split_plan is None:
                raise
            axis, children = split_plan
            _write_split_marker(output, request, axis, children)
            stats.split += 1
        else:
            _write_fragment(output, request, downloaded)
            stats.downloaded += 1
            return downloaded

    if split_plan is None:
        raise RuntimeError("fragment split invariant failed")
    axis, children = split_plan
    child_frames = [
        _materialize_fragment(client, output, child, stats)
        for child in children
    ]
    combined = _combine_source_frames(
        child_frames,
        request,
        context=f"{axis}-split {request.source} fragments",
    )
    _write_fragment(output, request, combined)
    return combined


def _merge_price_left(
    factor: pd.DataFrame,
    status: pd.DataFrame,
    symbols: list[str],
    stats: BuildStats,
) -> pd.DataFrame:
    factor_keys = set(zip(factor["date"], factor["symbol"], strict=True))
    status_keys = set(zip(status["date"], status["symbol"], strict=True))
    factor_only = factor_keys - status_keys
    if factor_only:
        raise RuntimeError(
            "factor/status key coverage mismatch: "
            f"factorOnly={len(factor_only)}"
        )
    status_only = status_keys - factor_keys
    stats.status_only_dropped = len(status_only)
    if status_only:
        print(
            f"status-only keys dropped: {len(status_only)}",
            file=sys.stderr,
        )

    actual_factor_symbols = set(factor["symbol"])
    expected_symbols = set(symbols)
    if actual_factor_symbols != expected_symbols:
        raise RuntimeError(
            "factor symbol coverage mismatch: "
            f"expected={len(expected_symbols)} "
            f"actual={len(actual_factor_symbols)}"
        )

    merged = factor.merge(
        status,
        on=["date", "symbol"],
        how="left",
        validate="one_to_one",
    )
    if merged["tradeStatus"].isna().any():
        raise RuntimeError("factor rows are missing trade status after merge")
    if merged.duplicated(["date", "symbol"]).any():
        raise RuntimeError("canonical cache contains duplicate symbol/date keys")
    return (
        merged[["date", "symbol", "adjClose", "tradeStatus"]]
        .sort_values(["date", "symbol"])
        .reset_index(drop=True)
    )


def _progress(
    label: str,
    completed: int,
    total: int,
    stats: BuildStats,
) -> None:
    print(
        f"{label}: {completed}/{total} "
        f"downloaded={stats.downloaded} reused={stats.reused} "
        f"split={stats.split}",
        file=sys.stderr,
    )


def smoke(start_date: str, end_date: str) -> None:
    client = retry_transport("PandaData initialization", create_initialized_client)
    market = _as_frame(
        retry_transport(
            "get_market_data",
            lambda: client.get_market_data(
                symbol="000001.SZ",
                start_date=start_date,
                end_date=end_date,
                fields=["symbol", "date", "trade_status"],
                type="stock",
            ),
        ),
        "get_market_data",
    )
    factors = _as_frame(
        retry_transport(
            "get_adj_factor",
            lambda: client.get_adj_factor(
                symbol="000001.SZ",
                start_date=start_date,
                end_date=end_date,
            ),
        ),
        "get_adj_factor",
    )
    close = _as_frame(
        retry_transport(
            "get_factor(close)",
            lambda: client.get_factor(
                symbol="000001.SZ",
                start_date=start_date,
                end_date=end_date,
                factors=["close"],
                type="stock",
            ),
        ),
        "get_factor",
    )
    print(
        "smoke ok: "
        f"marketRows={len(market)} adjFactorRows={len(factors)} "
        f"factorCloseRows={len(close)}"
    )


def build_cache(
    start_date: str,
    end_date: str,
    output: Path,
    batch_size: int,
    constituents_from_cache: Path | None = None,
) -> None:
    window_start = _parse_boundary(start_date, "start date")
    window_end = _parse_boundary(end_date, "end date")
    if window_start > window_end:
        raise ValueError("start date must not be after end date")
    if batch_size <= 0:
        raise ValueError("batch size must be positive")

    client = retry_transport("PandaData initialization", create_initialized_client)
    if constituents_from_cache is not None:
        symbols, snapshot_date = _symbols_from_cache(constituents_from_cache)
    else:
        weights = retry_transport(
            "get_index_weights",
            lambda: client.get_index_weights(
                index_symbol=INDEX_SYMBOL,
                start_date=end_date,
                end_date=end_date,
            ),
        )
        symbols, snapshot_date = _symbols_from_weights(weights)

    universe_hash = _universe_hash(symbols)
    universe_size = len(symbols)
    full_symbols = tuple(symbols)
    stats = BuildStats()

    factor_windows = list(_factor_windows(window_start, window_end))
    factor_frames: list[pd.DataFrame] = []
    for index, (chunk_start, chunk_end) in enumerate(factor_windows, start=1):
        request = FragmentRequest(
            source="factor-close",
            start_date=chunk_start,
            end_date=chunk_end,
            symbols=full_symbols,
            universe_hash=universe_hash,
            universe_size=universe_size,
        )
        factor_frames.append(
            _materialize_fragment(client, output, request, stats)
        )
        if index % batch_size == 0 or index == len(factor_windows):
            _progress("factor windows ready", index, len(factor_windows), stats)

    full_factor_request = FragmentRequest(
        source="factor-close",
        start_date=window_start,
        end_date=window_end,
        symbols=full_symbols,
        universe_hash=universe_hash,
        universe_size=universe_size,
    )
    factor = _combine_source_frames(
        factor_frames,
        full_factor_request,
        context="assembled factor-close panel",
    )
    if factor.empty:
        raise RuntimeError("factor close produced an empty panel")

    trading_dates = sorted(
        pd.Timestamp(value) for value in factor["date"].unique()
    )
    status_frames: list[pd.DataFrame] = []
    for index, trading_date in enumerate(trading_dates, start=1):
        request = FragmentRequest(
            source="trade-status",
            start_date=trading_date,
            end_date=trading_date,
            symbols=full_symbols,
            universe_hash=universe_hash,
            universe_size=universe_size,
        )
        status_frames.append(
            _materialize_fragment(client, output, request, stats)
        )
        if index % batch_size == 0 or index == len(trading_dates):
            _progress(
                "trade-status dates ready",
                index,
                len(trading_dates),
                stats,
            )

    full_status_request = FragmentRequest(
        source="trade-status",
        start_date=trading_dates[0],
        end_date=trading_dates[-1],
        symbols=full_symbols,
        universe_hash=universe_hash,
        universe_size=universe_size,
    )
    status = _combine_source_frames(
        status_frames,
        full_status_request,
        context="assembled trade-status panel",
    )
    cache = _merge_price_left(factor, status, symbols, stats)
    _write_frame_atomic(output, cache)
    print(
        "cache ready: "
        f"path={output} rows={len(cache)} "
        f"symbols={cache['symbol'].nunique()} snapshot={snapshot_date} "
        f"source={DATASET_VERSION} universeHash={universe_hash} "
        f"downloaded={stats.downloaded} reused={stats.reused} "
        f"split={stats.split} "
        f"statusOnlyDropped={stats.status_only_dropped} "
        "limitation=fixed-current-constituents"
    )


def main() -> int:
    _load_repo_credentials()
    parser = argparse.ArgumentParser(
        description="Smoke PandaData or build a fixed-universe CSI 300 CSV cache."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    smoke_parser = subparsers.add_parser("smoke")
    smoke_parser.add_argument("--start", required=True)
    smoke_parser.add_argument("--end", required=True)

    cache_parser = subparsers.add_parser("cache")
    cache_parser.add_argument("--start", required=True)
    cache_parser.add_argument("--end", required=True)
    cache_parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    cache_parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=(
            "Progress reporting interval; horizontal requests always retain "
            "the full current universe before adaptive splitting."
        ),
    )
    cache_parser.add_argument(
        "--constituents-from-cache",
        type=Path,
        help="Reuse symbols from a previously verified fixed-snapshot cache.",
    )

    args = parser.parse_args()
    if args.command == "smoke":
        smoke(args.start, args.end)
        return 0
    if args.batch_size <= 0:
        parser.error("--batch-size must be positive")
    build_cache(
        args.start,
        args.end,
        args.output,
        args.batch_size,
        args.constituents_from_cache,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
