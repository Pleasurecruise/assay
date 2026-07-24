"""Prepare the versioned v9 P1 data cache without running any audit.

The operator-facing command performs five bounded pieces of work:

* validate and, when necessary, precisely repair the existing fixed-universe
  price/status cache;
* cache 37 PIT observation points while distinguishing completed month ends
  from the terminal as-of observation;
* cache price and trade status for historical constituents absent from the
  fixed 300-stock panel;
* cache CSI 300 daily closes with exactly 200 pre-window trading observations;
* cache ``ratio_pe_ttm`` and ``market_cap`` for the fixed universe.

Every provider response is persisted as an identity-bound atomic fragment.
The promoted manifest is also atomic and is written only after the PIT hard
gate and base-cache quality gate pass.  Recoverable downstream failures use the
degradations authorized by the v9 task: remove-only PIT correction, a
constituent proxy for regime analysis, or classic-only comparator factors.

Credentials remain behind ``create_initialized_client``.  Provider exception
text and absolute paths never enter manifests or operator output.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from time import monotonic, sleep
from typing import Any, Final, Literal

import pandas as pd

from panda_adapter.availability_audit import (
    DEFAULT_PIT_CACHE_ROOT,
    PIT_SNAPSHOT_SCHEMA_VERSION,
    _LazyClient,
    _load_or_fetch_extra_rows,
)
from panda_adapter.client import create_initialized_client
from panda_adapter.data_transport import (
    DataTransportError,
    RetryPolicy,
    retry_transport,
)
from panda_adapter.market_panel import INDEX_SYMBOL, TRADABLE_TRADE_STATUS
from panda_adapter.source_normalization import (
    as_frame,
    find_column,
    normalize_source_frame,
    normalized_dates,
    optional_column,
)


CACHE_VERSION: Final = "assay-v9-p1-v1"
MANIFEST_SCHEMA_VERSION: Final = "assay-p1-cache-manifest-v1"
FRAGMENT_SCHEMA_VERSION: Final = "assay-p1-fragment-v1"
SPLIT_SCHEMA_VERSION: Final = "assay-p1-split-v1"
EXPECTED_PIT_POINTS: Final = 37
EXPECTED_INDEX_LOOKBACK_DAYS: Final = 200
DEFAULT_STAGE_SECONDS: Final = 20 * 60
INDEX_WINDOW_DAYS: Final = 31
FACTOR_WINDOW_DAYS: Final = 7
PIT_LOOKBACK_DAYS: Final = 7
COMPARATOR_FACTORS: Final = ("ratio_pe_ttm", "market_cap")
INDEX_COLUMNS: Final = ("date", "symbol", "close")
COMPARATOR_COLUMNS: Final = (
    "date",
    "symbol",
    "ratio_pe_ttm",
    "market_cap",
)
HISTORICAL_COLUMNS: Final = ("date", "symbol", "adjClose", "tradeStatus")
DEFAULT_CACHE_ROOT: Final = Path(".cache/assay")
DEFAULT_BASE_CACHE: Final = DEFAULT_CACHE_ROOT / "csi300-3y.csv"
DEFAULT_RETRY_POLICY: Final = RetryPolicy(
    max_attempts=5,
    initial_delay_seconds=0.25,
    max_delay_seconds=2,
)

SourceName = Literal["index-daily", "comparator-factors"]
PointKind = Literal["completed_month_end", "terminal_as_of"]


class P1CacheError(RuntimeError):
    """Safe base class for cache preparation failures."""


class StageDeadlineExceeded(P1CacheError):
    """Raised when one P1 stage exhausts its 20-minute budget."""


class RetryableFragmentFailure(P1CacheError):
    """Raised after one fragment exhausts bounded transport retries."""


class CacheQualityError(P1CacheError):
    """Raised when provider or cached data fails deterministic quality gates."""


class BaseCoverageError(CacheQualityError):
    """Raised when the official calendar disproves base-panel date coverage."""


@dataclass(frozen=True, slots=True)
class P1Config:
    cache_root: Path = DEFAULT_CACHE_ROOT
    base_cache: Path = DEFAULT_BASE_CACHE
    stage_seconds: float = DEFAULT_STAGE_SECONDS
    expected_pit_points: int = EXPECTED_PIT_POINTS
    perform_spot_checks: bool = True

    @property
    def version_root(self) -> Path:
        return self.cache_root / "v9-p1-v1"


@dataclass(frozen=True, slots=True)
class PITPoint:
    date: pd.Timestamp
    kind: PointKind


@dataclass(frozen=True, slots=True)
class CacheRequest:
    source: SourceName
    start_date: pd.Timestamp
    end_date: pd.Timestamp
    symbols: tuple[str, ...]
    fields: tuple[str, ...]


@dataclass(slots=True)
class FragmentStats:
    downloaded: int = 0
    reused: int = 0
    split: int = 0
    invalidated: int = 0


@dataclass(slots=True)
class StageBudget:
    stage: str
    max_seconds: float
    clock: Callable[[], float] = monotonic
    sleeper: Callable[[float], None] = sleep
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY
    started_at: float | None = None

    def __post_init__(self) -> None:
        if self.max_seconds <= 0:
            raise ValueError("stage budget must be positive")
        if self.started_at is None:
            self.started_at = self.clock()

    def ensure_available(self) -> None:
        assert self.started_at is not None
        if self.clock() - self.started_at >= self.max_seconds:
            raise StageDeadlineExceeded(f"{self.stage} deadline exceeded")

    def call(self, label: str, operation: Callable[[], Any]) -> Any:
        self.ensure_available()
        try:
            value = retry_transport(
                label,
                operation,
                policy=self.retry_policy,
                sleeper=self.sleeper,
            )
        except DataTransportError as error:
            self.ensure_available()
            raise RetryableFragmentFailure(
                f"{self.stage} fragment transport exhausted"
            ) from error
        self.ensure_available()
        return value

    def call_pretried(self, operation: Callable[[], Any]) -> Any:
        """Run an operation that already owns a bounded retry policy."""

        self.ensure_available()
        try:
            value = operation()
        except DataTransportError as error:
            self.ensure_available()
            raise RetryableFragmentFailure(
                f"{self.stage} fragment transport exhausted"
            ) from error
        self.ensure_available()
        return value


def _load_base_builder() -> Any:
    path = Path(__file__).with_name("prepare_csi300_cache.py")
    name = "assay_v9_base_cache_builder"
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("base cache builder is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


BASE_BUILDER = _load_base_builder()


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
    _write_bytes_atomic(
        path,
        json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8"),
    )


def _write_frame_atomic(path: Path, frame: pd.DataFrame) -> None:
    _write_bytes_atomic(path, frame.to_csv(index=False).encode("utf-8"))


def _canonical_symbols(values: Iterable[Any]) -> tuple[str, ...]:
    symbols = tuple(
        sorted(
            {
                str(value).strip().upper()
                for value in values
                if not pd.isna(value) and str(value).strip()
            }
        )
    )
    if not symbols:
        raise CacheQualityError("symbol universe is empty")
    return symbols


def _universe_hash(symbols: Sequence[str]) -> str:
    return sha256("\n".join(symbols).encode("utf-8")).hexdigest()[:16]


def _relative_cache_path(path: Path, cache_root: Path) -> str:
    try:
        return path.resolve().relative_to(cache_root.resolve()).as_posix()
    except ValueError:
        return path.name


def _records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return json.loads(frame.to_json(orient="records", double_precision=15))


def _request_metadata(request: CacheRequest) -> dict[str, Any]:
    return {
        "cacheVersion": CACHE_VERSION,
        "source": request.source,
        "start": request.start_date.strftime("%Y-%m-%d"),
        "end": request.end_date.strftime("%Y-%m-%d"),
        "symbols": list(request.symbols),
        "fields": list(request.fields),
    }


def _request_digest(request: CacheRequest) -> str:
    canonical = json.dumps(
        _request_metadata(request),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(canonical).hexdigest()[:16]


def _fragment_path(root: Path, request: CacheRequest) -> Path:
    date_range = (
        f"{request.start_date.strftime('%Y%m%d')}-"
        f"{request.end_date.strftime('%Y%m%d')}"
    )
    return (
        root
        / "fragments"
        / request.source
        / date_range
        / f"request-{_request_digest(request)}.json"
    )


def _split_path(root: Path, request: CacheRequest) -> Path:
    return _fragment_path(root, request).with_suffix(".split.json")


def _frame_keys(frame: pd.DataFrame) -> set[tuple[str, str]]:
    return set(zip(frame["date"], frame["symbol"], strict=True))


def _empty_frame(source: SourceName) -> pd.DataFrame:
    columns = INDEX_COLUMNS if source == "index-daily" else COMPARATOR_COLUMNS
    return pd.DataFrame(columns=list(columns))


def _normalize_index_daily(
    value: Any,
    request: CacheRequest,
) -> pd.DataFrame:
    frame = as_frame(value, "get_index_daily")
    if frame.empty and not len(frame.columns):
        return _empty_frame("index-daily")
    date_column = find_column(
        frame,
        ("date", "trade_date", "datetime"),
        "get_index_daily",
    )
    symbol_column = optional_column(
        frame,
        ("symbol", "index_symbol", "code"),
    )
    close_column = find_column(
        frame,
        ("close", "index_close"),
        "get_index_daily",
    )
    selected = frame[[date_column, close_column]].copy()
    selected.columns = ["date", "close"]
    if symbol_column is None:
        if len(request.symbols) != 1:
            raise CacheQualityError("index response omits a multi-symbol identity")
        selected["symbol"] = request.symbols[0]
    else:
        selected["symbol"] = frame[symbol_column]
    if selected[["date", "symbol", "close"]].isna().any().any():
        raise CacheQualityError("index daily contains missing canonical values")
    selected["date"] = normalized_dates(selected["date"])
    selected["symbol"] = selected["symbol"].astype(str).str.strip().str.upper()
    selected["close"] = pd.to_numeric(selected["close"], errors="coerce")
    if selected[["date", "close"]].isna().any().any():
        raise CacheQualityError("index daily contains invalid canonical values")
    if (~selected["close"].map(math.isfinite)).any() or (selected["close"] <= 0).any():
        raise CacheQualityError("index close must be finite and positive")
    if set(selected["symbol"]) - set(request.symbols):
        raise CacheQualityError("index daily returned an unexpected symbol")
    if (~selected["date"].between(request.start_date, request.end_date)).any():
        raise CacheQualityError("index daily returned an out-of-window row")
    selected["date"] = selected["date"].dt.strftime("%Y-%m-%d")
    selected = selected[["date", "symbol", "close"]]
    if selected.duplicated(["date", "symbol"]).any():
        raise CacheQualityError("index daily contains duplicate primary keys")
    return selected.sort_values(["date", "symbol"]).reset_index(drop=True)


def _normalize_comparator_factors(
    value: Any,
    request: CacheRequest,
) -> pd.DataFrame:
    frame = as_frame(value, "get_factor(comparators)")
    if frame.empty and not len(frame.columns):
        return _empty_frame("comparator-factors")
    date_column = find_column(
        frame,
        ("date", "trade_date", "datetime"),
        "get_factor(comparators)",
    )
    symbol_column = find_column(
        frame,
        ("symbol", "stock_symbol", "stock_code", "code"),
        "get_factor(comparators)",
    )
    factor_columns = [
        find_column(frame, (name,), "get_factor(comparators)")
        for name in COMPARATOR_FACTORS
    ]
    selected = frame[[date_column, symbol_column, *factor_columns]].copy()
    selected.columns = list(COMPARATOR_COLUMNS)
    if selected[["date", "symbol"]].isna().any().any():
        raise CacheQualityError("comparator factors contain a missing primary key")
    selected["date"] = normalized_dates(selected["date"])
    selected["symbol"] = selected["symbol"].astype(str).str.strip().str.upper()
    if selected["date"].isna().any() or selected["symbol"].eq("").any():
        raise CacheQualityError("comparator factors contain an invalid primary key")
    for factor in COMPARATOR_FACTORS:
        raw_missing = selected[factor].isna()
        selected[factor] = pd.to_numeric(selected[factor], errors="coerce")
        invalid_text = selected[factor].isna() & ~raw_missing
        nonfinite = selected[factor].notna() & ~selected[factor].map(math.isfinite)
        if invalid_text.any() or nonfinite.any():
            raise CacheQualityError("comparator factor values must be numeric")
    if set(selected["symbol"]) - set(request.symbols):
        raise CacheQualityError("comparator factors returned an unexpected symbol")
    if (~selected["date"].between(request.start_date, request.end_date)).any():
        raise CacheQualityError("comparator factors returned an out-of-window row")
    selected["date"] = selected["date"].dt.strftime("%Y-%m-%d")
    if selected.duplicated(["date", "symbol"]).any():
        raise CacheQualityError("comparator factors contain duplicate primary keys")
    return selected.sort_values(["date", "symbol"]).reset_index(drop=True)


def _normalize_fragment(value: Any, request: CacheRequest) -> pd.DataFrame:
    if request.source == "index-daily":
        return _normalize_index_daily(value, request)
    return _normalize_comparator_factors(value, request)


def _write_fragment(
    root: Path,
    request: CacheRequest,
    frame: pd.DataFrame,
) -> None:
    normalized = _normalize_fragment(frame, request)
    _write_json_atomic(
        _fragment_path(root, request),
        {
            "schemaVersion": FRAGMENT_SCHEMA_VERSION,
            "request": _request_metadata(request),
            "rows": _records(normalized),
        },
    )


def _read_fragment(root: Path, request: CacheRequest) -> pd.DataFrame:
    path = _fragment_path(root, request)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CacheQualityError("cannot read a P1 cache fragment") from error
    rows = payload.get("rows") if isinstance(payload, Mapping) else None
    if (
        not isinstance(payload, Mapping)
        or payload.get("schemaVersion") != FRAGMENT_SCHEMA_VERSION
        or payload.get("request") != _request_metadata(request)
        or not isinstance(rows, list)
    ):
        raise CacheQualityError("P1 cache fragment identity is invalid")
    return _normalize_fragment(rows, request)


def _split_request(
    request: CacheRequest,
) -> tuple[CacheRequest, CacheRequest] | None:
    if request.start_date < request.end_date:
        midpoint = request.start_date + pd.Timedelta(
            days=(request.end_date - request.start_date).days // 2
        )
        return (
            CacheRequest(
                source=request.source,
                start_date=request.start_date,
                end_date=midpoint,
                symbols=request.symbols,
                fields=request.fields,
            ),
            CacheRequest(
                source=request.source,
                start_date=midpoint + pd.Timedelta(days=1),
                end_date=request.end_date,
                symbols=request.symbols,
                fields=request.fields,
            ),
        )
    if len(request.symbols) <= 1:
        return None
    midpoint = len(request.symbols) // 2
    return (
        CacheRequest(
            source=request.source,
            start_date=request.start_date,
            end_date=request.end_date,
            symbols=request.symbols[:midpoint],
            fields=request.fields,
        ),
        CacheRequest(
            source=request.source,
            start_date=request.start_date,
            end_date=request.end_date,
            symbols=request.symbols[midpoint:],
            fields=request.fields,
        ),
    )


def _split_payload(
    request: CacheRequest,
    children: tuple[CacheRequest, CacheRequest],
) -> dict[str, Any]:
    return {
        "schemaVersion": SPLIT_SCHEMA_VERSION,
        "request": _request_metadata(request),
        "children": [_request_metadata(child) for child in children],
    }


def _write_split(
    root: Path,
    request: CacheRequest,
    children: tuple[CacheRequest, CacheRequest],
) -> None:
    _write_json_atomic(
        _split_path(root, request),
        _split_payload(request, children),
    )


def _read_split(
    root: Path,
    request: CacheRequest,
    children: tuple[CacheRequest, CacheRequest],
) -> None:
    try:
        payload = json.loads(_split_path(root, request).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CacheQualityError("cannot read a P1 split marker") from error
    if payload != _split_payload(request, children):
        raise CacheQualityError("P1 split marker identity is invalid")


def _request_expected_keys(
    request: CacheRequest,
    expected_keys: set[tuple[str, str]],
) -> set[tuple[str, str]]:
    start = request.start_date.strftime("%Y-%m-%d")
    end = request.end_date.strftime("%Y-%m-%d")
    symbols = set(request.symbols)
    return {
        key for key in expected_keys if start <= key[0] <= end and key[1] in symbols
    }


def _combine_fragment_frames(
    frames: Sequence[pd.DataFrame],
    request: CacheRequest,
) -> pd.DataFrame:
    if not frames:
        return _empty_frame(request.source)
    return _normalize_fragment(
        pd.concat(frames, ignore_index=True),
        request,
    )


def _materialize_fragment(
    *,
    root: Path,
    request: CacheRequest,
    expected_keys: set[tuple[str, str]],
    budget: StageBudget,
    downloader: Callable[[CacheRequest], Any],
    stats: FragmentStats,
) -> pd.DataFrame:
    path = _fragment_path(root, request)
    required = _request_expected_keys(request, expected_keys)
    if path.is_file():
        cached = _read_fragment(root, request)
        if _frame_keys(cached) == required:
            stats.reused += 1
            return cached
        path.unlink()
        stats.invalidated += 1

    children = _split_request(request)
    split_path = _split_path(root, request)
    if split_path.is_file():
        if children is None:
            raise CacheQualityError("unsplittable request has a split marker")
        _read_split(root, request, children)
        stats.split += 1
    else:
        try:
            value = budget.call(
                request.source,
                lambda: downloader(request),
            )
            downloaded = _normalize_fragment(value, request)
        except RetryableFragmentFailure:
            if children is None:
                raise
        else:
            if _frame_keys(downloaded) == required:
                _write_fragment(root, request, downloaded)
                stats.downloaded += 1
                return downloaded
            if children is None:
                raise CacheQualityError(
                    f"{request.source} fragment has incomplete key coverage"
                )
        assert children is not None
        _write_split(root, request, children)
        stats.split += 1

    assert children is not None
    child_frames = [
        _materialize_fragment(
            root=root,
            request=child,
            expected_keys=expected_keys,
            budget=budget,
            downloader=downloader,
            stats=stats,
        )
        for child in children
    ]
    combined = _combine_fragment_frames(child_frames, request)
    if _frame_keys(combined) != required:
        raise CacheQualityError(
            f"{request.source} split fragments have incomplete key coverage"
        )
    _write_fragment(root, request, combined)
    return combined


def _read_base_frame(path: Path) -> pd.DataFrame:
    if not path.is_file():
        raise CacheQualityError("base market cache is missing")
    try:
        frame = pd.read_csv(path)
    except (OSError, UnicodeError, ValueError) as error:
        raise CacheQualityError("cannot read base market cache") from error
    required = {"date", "symbol", "adjClose", "tradeStatus"}
    if not required <= set(frame.columns):
        raise CacheQualityError("base market cache schema is incomplete")
    selected = frame[list(HISTORICAL_COLUMNS)].copy()
    if selected.isna().any().any():
        raise CacheQualityError("base market cache contains missing canonical values")
    selected["date"] = pd.to_datetime(selected["date"], errors="coerce")
    selected["symbol"] = selected["symbol"].astype(str).str.strip().str.upper()
    selected["adjClose"] = pd.to_numeric(
        selected["adjClose"],
        errors="coerce",
    )
    selected["tradeStatus"] = pd.to_numeric(
        selected["tradeStatus"],
        errors="coerce",
    )
    if (
        selected[["date", "adjClose", "tradeStatus"]].isna().any().any()
        or selected["symbol"].eq("").any()
    ):
        raise CacheQualityError("base market cache contains invalid canonical values")
    if (~selected["adjClose"].map(math.isfinite)).any() or (
        selected["adjClose"] <= 0
    ).any():
        raise CacheQualityError("base market cache contains an invalid price")
    if (~selected["tradeStatus"].map(math.isfinite)).any() or (
        ~selected["tradeStatus"].mod(1).eq(0)
    ).any():
        raise CacheQualityError("base market cache contains an invalid trade status")
    selected["tradeStatus"] = selected["tradeStatus"].astype(int)
    if selected.duplicated(["date", "symbol"]).any():
        raise CacheQualityError("base market cache contains duplicate primary keys")
    return selected.sort_values(["date", "symbol"]).reset_index(drop=True)


def _base_request(
    *,
    source: Literal["factor-close", "trade-status"],
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    symbols: Sequence[str],
) -> Any:
    canonical = tuple(symbols)
    return BASE_BUILDER.FragmentRequest(
        source=source,
        start_date=start_date,
        end_date=end_date,
        symbols=canonical,
        universe_hash=BASE_BUILDER._universe_hash(canonical),
        universe_size=len(canonical),
    )


def _read_base_status(
    *,
    output: Path,
    symbols: Sequence[str],
    dates: Sequence[pd.Timestamp],
) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for date in dates:
        request = _base_request(
            source="trade-status",
            start_date=date,
            end_date=date,
            symbols=symbols,
        )
        path = BASE_BUILDER._fragment_path(output, request)
        if not path.is_file():
            raise CacheQualityError("base trade-status fragment is missing")
        frames.append(BASE_BUILDER._read_fragment(output, request))
    if not frames:
        raise CacheQualityError("base market cache has no trading dates")
    status = pd.concat(frames, ignore_index=True)
    if status.duplicated(["date", "symbol"]).any():
        raise CacheQualityError("base trade-status fragments contain duplicate keys")
    return status.sort_values(["date", "symbol"]).reset_index(drop=True)


def _base_fragment_complete(
    frame: pd.DataFrame,
    status: pd.DataFrame,
    request: Any,
) -> bool:
    start = request.start_date.strftime("%Y-%m-%d")
    end = request.end_date.strftime("%Y-%m-%d")
    symbols = set(request.symbols)
    scoped_status = status.loc[
        status["date"].between(start, end) & status["symbol"].isin(symbols)
    ]
    status_keys = _frame_keys(scoped_status)
    required = _frame_keys(
        scoped_status.loc[scoped_status["tradeStatus"] == TRADABLE_TRADE_STATUS]
    )
    factor_keys = _frame_keys(frame)
    return factor_keys <= status_keys and required <= factor_keys


def _repair_base_factor_fragment(
    *,
    output: Path,
    request: Any,
    status: pd.DataFrame,
    client: Any,
    budget: StageBudget,
    repaired: list[str],
) -> pd.DataFrame:
    path = BASE_BUILDER._fragment_path(output, request)
    if path.is_file():
        cached = BASE_BUILDER._read_fragment(output, request)
        if _base_fragment_complete(cached, status, request):
            return cached
        path.unlink()
        repaired.append(
            f"{request.start_date.strftime('%Y-%m-%d')}/"
            f"{request.end_date.strftime('%Y-%m-%d')}"
        )

    split_plan = BASE_BUILDER._split_request(request)
    marker = BASE_BUILDER._split_marker_path(path)
    if marker.is_file():
        if split_plan is None:
            raise CacheQualityError("unsplittable base fragment has a split marker")
        axis, children = split_plan
        BASE_BUILDER._read_split_marker(output, request, axis, children)
    else:
        try:
            downloaded = budget.call_pretried(
                lambda: BASE_BUILDER._download_fragment(client, request)
            )
        except RetryableFragmentFailure:
            if split_plan is None:
                raise
        else:
            if _base_fragment_complete(downloaded, status, request):
                BASE_BUILDER._write_fragment(output, request, downloaded)
                return downloaded
            if split_plan is None:
                raise CacheQualityError(
                    "base factor fragment remains incomplete at a single key"
                )
        assert split_plan is not None
        axis, children = split_plan
        BASE_BUILDER._write_split_marker(
            output,
            request,
            axis,
            children,
        )

    assert split_plan is not None
    axis, children = split_plan
    child_frames = [
        _repair_base_factor_fragment(
            output=output,
            request=child,
            status=status,
            client=client,
            budget=budget,
            repaired=repaired,
        )
        for child in children
    ]
    combined = BASE_BUILDER._combine_source_frames(
        child_frames,
        request,
        context=f"{axis}-split repaired factor-close fragments",
    )
    if not _base_fragment_complete(combined, status, request):
        raise CacheQualityError("repaired base factor coverage is incomplete")
    BASE_BUILDER._write_fragment(output, request, combined)
    return combined


def _strict_base_merge(
    factor: pd.DataFrame,
    status: pd.DataFrame,
) -> pd.DataFrame:
    factor_keys = _frame_keys(factor)
    status_keys = _frame_keys(status)
    if factor_keys - status_keys:
        raise CacheQualityError("base factor rows lack trade-status coverage")
    tradable_keys = _frame_keys(
        status.loc[status["tradeStatus"] == TRADABLE_TRADE_STATUS]
    )
    if tradable_keys - factor_keys:
        raise CacheQualityError("base cache lacks tradable factor-close rows")
    merged = factor.merge(
        status,
        on=["date", "symbol"],
        how="left",
        validate="one_to_one",
    )
    if merged["tradeStatus"].isna().any():
        raise CacheQualityError("base merge contains a missing trade status")
    return (
        merged[list(HISTORICAL_COLUMNS)]
        .sort_values(["date", "symbol"])
        .reset_index(drop=True)
    )


def _normalized_source_spot(
    *,
    client: Any,
    budget: StageBudget,
    row: Mapping[str, Any],
) -> dict[str, Any]:
    date = pd.Timestamp(row["date"])
    symbol = str(row["symbol"])
    factor_request = budget.call(
        "spot get_factor(close)",
        lambda: client.get_factor(
            symbol=[symbol],
            start_date=date.strftime("%Y%m%d"),
            end_date=date.strftime("%Y%m%d"),
            factors=["close"],
            type="stock",
        ),
    )
    status_request = budget.call(
        "spot get_market_data(trade_status)",
        lambda: client.get_market_data(
            symbol=[symbol],
            start_date=date.strftime("%Y%m%d"),
            end_date=date.strftime("%Y%m%d"),
            fields=["symbol", "date", "trade_status"],
            type="stock",
        ),
    )
    factor = normalize_source_frame(
        factor_request,
        source="factor-close",
        start_date=date,
        end_date=date,
        symbols=[symbol],
        context="spot get_factor(close)",
    )
    status = normalize_source_frame(
        status_request,
        source="trade-status",
        start_date=date,
        end_date=date,
        symbols=[symbol],
        context="spot get_market_data(trade_status)",
    )
    if len(factor) != 1 or len(status) != 1:
        raise CacheQualityError("price/status spot check returned no exact row")
    expected_close = float(row["adjClose"])
    actual_close = float(factor.iloc[0]["adjClose"])
    expected_status = int(row["tradeStatus"])
    actual_status = int(status.iloc[0]["tradeStatus"])
    if (
        not math.isclose(
            expected_close,
            actual_close,
            rel_tol=1e-10,
            abs_tol=1e-8,
        )
        or expected_status != actual_status
    ):
        raise CacheQualityError("price/status spot check mismatch")
    return {
        "matched": True,
        "date": date.strftime("%Y-%m-%d"),
        "symbol": symbol,
    }


def _frame_quality(frame: pd.DataFrame) -> dict[str, Any]:
    key_nulls = int(frame[["date", "symbol"]].isna().any(axis=1).sum())
    return {
        "rowCount": len(frame),
        "tradingDates": int(frame["date"].nunique()),
        "symbols": int(frame["symbol"].nunique()),
        "nullPrimaryKeys": key_nulls,
        "duplicatePrimaryKeys": int(frame.duplicated(["date", "symbol"]).sum()),
    }


def _prepare_base_cache(
    *,
    config: P1Config,
    client: Any,
    budget: StageBudget,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    base = _read_base_frame(config.base_cache)
    symbols = _canonical_symbols(base["symbol"])
    if len(symbols) != 300:
        raise CacheQualityError("base universe must contain exactly 300 symbols")
    dates = [pd.Timestamp(value) for value in sorted(base["date"].unique())]
    status = _read_base_status(
        output=config.base_cache,
        symbols=symbols,
        dates=dates,
    )
    factor_frames: list[pd.DataFrame] = []
    repaired: list[str] = []
    for start_date, end_date in BASE_BUILDER._factor_windows(
        dates[0],
        dates[-1],
    ):
        factor_frames.append(
            _repair_base_factor_fragment(
                output=config.base_cache,
                request=_base_request(
                    source="factor-close",
                    start_date=start_date,
                    end_date=end_date,
                    symbols=symbols,
                ),
                status=status,
                client=client,
                budget=budget,
                repaired=repaired,
            )
        )
    factor = pd.concat(factor_frames, ignore_index=True)
    repaired_base = _strict_base_merge(factor, status)
    if repaired:
        _write_frame_atomic(config.base_cache, repaired_base)
    spot = {"matched": True, "skipped": True}
    if config.perform_spot_checks:
        sample = repaired_base.iloc[len(repaired_base) // 2]
        spot = _normalized_source_spot(
            client=client,
            budget=budget,
            row=sample,
        )
    quality = _frame_quality(repaired_base)
    quality["statusOnlyNonTradable"] = len(_frame_keys(status) - _frame_keys(factor))
    quality["repairedFragments"] = sorted(set(repaired))
    return repaired_base, {
        "status": "ready",
        "path": _relative_cache_path(config.base_cache, config.cache_root),
        "columns": list(HISTORICAL_COLUMNS),
        **quality,
        "quality": {
            "primaryKeysValid": True,
            "tradableFactorCoverage": True,
        },
        "spotCheck": spot,
    }


def _derive_pit_points(
    dates: Sequence[pd.Timestamp],
    *,
    expected_count: int = EXPECTED_PIT_POINTS,
) -> list[PITPoint]:
    normalized = pd.DatetimeIndex(pd.to_datetime(dates)).sort_values()
    if normalized.empty:
        raise CacheQualityError("cannot derive PIT points from an empty calendar")
    points: list[PITPoint] = []
    grouped = pd.Series(normalized, index=normalized).groupby(normalized.to_period("M"))
    periods = list(grouped.groups)
    for position, period in enumerate(periods):
        point_date = pd.Timestamp(grouped.get_group(period).max()).normalize()
        is_terminal_partial = (
            position == len(periods) - 1 and point_date < period.end_time.normalize()
        )
        points.append(
            PITPoint(
                date=point_date,
                kind=(
                    "terminal_as_of" if is_terminal_partial else "completed_month_end"
                ),
            )
        )
    if len(points) != expected_count:
        raise CacheQualityError(
            "PIT observation count does not match the frozen window"
        )
    return points


def _pit_snapshot_path(
    cache_root: Path,
    point: PITPoint,
) -> Path:
    return (
        cache_root
        / DEFAULT_PIT_CACHE_ROOT.relative_to(DEFAULT_CACHE_ROOT)
        / "index-weights"
        / INDEX_SYMBOL.replace(".", "_")
        / f"{point.date.strftime('%Y%m%d')}.json"
    )


def _read_pit_snapshot(path: Path, point: PITPoint) -> tuple[str, ...]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CacheQualityError("cannot read a PIT snapshot") from error
    symbols = payload.get("symbols") if isinstance(payload, Mapping) else None
    effective = pd.to_datetime(
        payload.get("effectiveDate") if isinstance(payload, Mapping) else None,
        errors="coerce",
    )
    if (
        not isinstance(payload, Mapping)
        or payload.get("schemaVersion") != PIT_SNAPSHOT_SCHEMA_VERSION
        or payload.get("indexSymbol") != INDEX_SYMBOL
        or payload.get("requestedDate") != point.date.strftime("%Y-%m-%d")
        or not isinstance(symbols, list)
        or symbols != sorted(set(symbols))
        or any(not isinstance(symbol, str) or not symbol for symbol in symbols)
        or pd.isna(effective)
        or pd.Timestamp(effective) > point.date
    ):
        raise CacheQualityError("PIT snapshot identity is invalid")
    return tuple(symbols)


def _normalize_index_weights(
    value: Any,
    requested_date: pd.Timestamp,
) -> tuple[tuple[str, ...], str, int, bool]:
    frame = as_frame(value, "get_index_weights")
    if frame.empty:
        raise CacheQualityError("get_index_weights returned no rows")
    date_column = optional_column(
        frame,
        ("date", "trade_date", "datetime"),
    )
    effective_date = requested_date
    if date_column is not None:
        dates = normalized_dates(frame[date_column])
        if dates.isna().any():
            raise CacheQualityError("index weights contain an invalid date")
        eligible = dates <= requested_date
        if not eligible.any():
            raise CacheQualityError("index weights contain no non-future snapshot")
        frame = frame.loc[eligible].copy()
        dates = dates.loc[eligible]
        effective_date = pd.Timestamp(dates.max()).normalize()
        frame = frame.loc[dates == effective_date].copy()
    symbol_column = find_column(
        frame,
        ("stock_symbol", "symbol", "stock_code", "con_code", "code"),
        "get_index_weights",
    )
    weight_column = optional_column(
        frame,
        ("weight", "i_weight", "index_weight"),
    )
    weight_filter_applied = False
    if weight_column is not None:
        weights = pd.to_numeric(frame[weight_column], errors="coerce")
        if weights.isna().any() or (~weights.map(math.isfinite)).any():
            raise CacheQualityError("index weights contain an invalid weight")
        frame = frame.loc[weights > 0].copy()
        weight_filter_applied = True
    raw_rows = len(frame)
    symbols = _canonical_symbols(frame[symbol_column])
    if len(symbols) != 300:
        raise CacheQualityError(
            "positive-weight PIT membership must contain exactly 300 symbols"
        )
    return (
        symbols,
        effective_date.strftime("%Y-%m-%d"),
        raw_rows,
        weight_filter_applied,
    )


def _fetch_pit_snapshot(
    *,
    client: Any,
    budget: StageBudget,
    point: PITPoint,
) -> tuple[tuple[str, ...], dict[str, Any]]:
    start = point.date - pd.Timedelta(days=PIT_LOOKBACK_DAYS - 1)
    value = budget.call(
        "get_index_weights",
        lambda: client.get_index_weights(
            index_symbol=INDEX_SYMBOL,
            start_date=start.strftime("%Y%m%d"),
            end_date=point.date.strftime("%Y%m%d"),
        ),
    )
    symbols, effective, raw_rows, filtered = _normalize_index_weights(
        value,
        point.date,
    )
    payload = {
        "schemaVersion": PIT_SNAPSHOT_SCHEMA_VERSION,
        "indexSymbol": INDEX_SYMBOL,
        "requestedDate": point.date.strftime("%Y-%m-%d"),
        "effectiveDate": effective,
        "symbols": list(symbols),
        "observationKind": point.kind,
        "quality": {
            "rawRows": raw_rows,
            "memberCount": len(symbols),
            "positiveWeightFilterApplied": filtered,
        },
    }
    return symbols, payload


def _prepare_pit_timeline(
    *,
    config: P1Config,
    client: Any,
    base_dates: Sequence[pd.Timestamp],
    budget: StageBudget,
) -> tuple[dict[pd.Timestamp, frozenset[str]], dict[str, Any]]:
    points = _derive_pit_points(
        base_dates,
        expected_count=config.expected_pit_points,
    )
    timeline: dict[pd.Timestamp, frozenset[str]] = {}
    reused = 0
    downloaded = 0
    refreshed = 0
    for point in points:
        path = _pit_snapshot_path(config.cache_root, point)
        symbols: tuple[str, ...] | None = None
        if path.is_file():
            cached = _read_pit_snapshot(path, point)
            if len(cached) == 300:
                symbols = cached
                reused += 1
            else:
                refreshed += 1
        if symbols is None:
            symbols, payload = _fetch_pit_snapshot(
                client=client,
                budget=budget,
                point=point,
            )
            _write_json_atomic(path, payload)
            downloaded += 1
        timeline[point.date] = frozenset(symbols)

    spot: dict[str, Any] = {"matched": True, "skipped": True}
    if config.perform_spot_checks:
        point = points[len(points) // 2]
        sample = sorted(timeline[point.date])[0]
        observed, _ = _fetch_pit_snapshot(
            client=client,
            budget=budget,
            point=point,
        )
        if sample not in observed:
            raise CacheQualityError("PIT membership spot check mismatch")
        spot = {
            "matched": True,
            "date": point.date.strftime("%Y-%m-%d"),
            "symbol": sample,
        }

    completed = sum(point.kind == "completed_month_end" for point in points)
    terminal = [
        point.date.strftime("%Y-%m-%d")
        for point in points
        if point.kind == "terminal_as_of"
    ]
    return timeline, {
        "status": "ready",
        "path": (
            "pit-availability-v1/index-weights/" f"{INDEX_SYMBOL.replace('.', '_')}"
        ),
        "columns": ["requestedDate", "effectiveDate", "symbols"],
        "rowCount": sum(len(symbols) for symbols in timeline.values()),
        "tradingDates": len(points),
        "symbols": len(set().union(*timeline.values())),
        "completedMonthEnds": completed,
        "terminalAsOf": terminal,
        "reused": reused,
        "downloaded": downloaded,
        "refreshed": refreshed,
        "quality": {
            "pointCount": len(points),
            "memberCountPerPoint": 300,
            "terminalAsOfIsNotMonthEnd": bool(terminal),
            "primaryKeysValid": True,
        },
        "spotCheck": spot,
    }


def _required_extra_symbols_by_date(
    *,
    timeline: Mapping[pd.Timestamp, frozenset[str]],
    extra_symbols: set[str],
    trading_dates: Sequence[pd.Timestamp],
) -> dict[pd.Timestamp, frozenset[str]]:
    ordered_dates = pd.DatetimeIndex(pd.to_datetime(trading_dates)).sort_values()
    result: dict[pd.Timestamp, set[str]] = {}
    for point_date, members in timeline.items():
        required = set(members) & extra_symbols
        if not required:
            continue
        point = pd.Timestamp(point_date)
        result.setdefault(point, set()).update(required)
        later = ordered_dates[ordered_dates > point]
        if len(later):
            result.setdefault(pd.Timestamp(later[0]), set()).update(required)
    return {date: frozenset(symbols) for date, symbols in result.items()}


def _prepare_historical_members(
    *,
    config: P1Config,
    client: Any,
    base: pd.DataFrame,
    timeline: Mapping[pd.Timestamp, frozenset[str]],
    budget: StageBudget,
) -> dict[str, Any]:
    base_symbols = set(_canonical_symbols(base["symbol"]))
    pit_union = set().union(*timeline.values())
    extra_symbols = sorted(pit_union - base_symbols)
    materialized = config.version_root / "materialized" / "historical-members.csv"
    if not extra_symbols:
        frame = pd.DataFrame(columns=list(HISTORICAL_COLUMNS))
    else:
        dates = [pd.Timestamp(value) for value in sorted(base["date"].unique())]
        pit_root = config.cache_root / DEFAULT_PIT_CACHE_ROOT.relative_to(
            DEFAULT_CACHE_ROOT
        )
        frame = _load_or_fetch_extra_rows(
            index_symbol=INDEX_SYMBOL,
            symbols=extra_symbols,
            start_date=dates[0],
            end_date=dates[-1],
            trading_dates=dates,
            required_status_symbols_by_date=_required_extra_symbols_by_date(
                timeline=timeline,
                extra_symbols=set(extra_symbols),
                trading_dates=dates,
            ),
            cache_root=pit_root,
            client=_LazyClient(factory=lambda: client, value=client),
            budget=budget,
        )
        frame = frame[list(HISTORICAL_COLUMNS)].copy()
        if frame.isna().any().any():
            raise CacheQualityError(
                "historical-member cache contains missing canonical values"
            )
        if frame.duplicated(["date", "symbol"]).any():
            raise CacheQualityError(
                "historical-member cache contains duplicate primary keys"
            )
        if set(frame["symbol"]) != set(extra_symbols):
            raise CacheQualityError(
                "historical-member cache has incomplete symbol coverage"
            )
    _write_frame_atomic(materialized, frame)

    spot: dict[str, Any] = {"matched": True, "skipped": True}
    if config.perform_spot_checks and not frame.empty:
        sample = frame.iloc[len(frame) // 2]
        spot = _normalized_source_spot(
            client=client,
            budget=budget,
            row=sample,
        )
    quality = (
        _frame_quality(frame)
        if not frame.empty
        else {
            "rowCount": 0,
            "tradingDates": 0,
            "symbols": 0,
            "nullPrimaryKeys": 0,
            "duplicatePrimaryKeys": 0,
        }
    )
    return {
        "status": "ready",
        "mode": "full_pit",
        "path": _relative_cache_path(materialized, config.cache_root),
        "columns": list(HISTORICAL_COLUMNS),
        **quality,
        "expectedSymbols": len(extra_symbols),
        "quality": {
            "primaryKeysValid": True,
            "factorStatusCoverage": True,
            "symbolCoverage": True,
        },
        "spotCheck": spot,
    }


def _normalize_trade_calendar(
    value: Any,
    *,
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> pd.DatetimeIndex:
    frame = as_frame(value, "get_trade_cal")
    if frame.empty:
        raise CacheQualityError("trade calendar returned no rows")
    date_column = find_column(
        frame,
        ("date", "trade_date", "calendar_date"),
        "get_trade_cal",
    )
    dates = normalized_dates(frame[date_column])
    if dates.isna().any():
        raise CacheQualityError("trade calendar contains an invalid date")
    trading_column = optional_column(
        frame,
        ("is_trading_day", "is_open", "trade_status"),
    )
    if trading_column is not None:
        raw = frame[trading_column]
        if raw.dtype == bool:
            trading = raw
        else:
            numeric = pd.to_numeric(raw, errors="coerce")
            if numeric.isna().any():
                text = raw.astype(str).str.strip().str.lower()
                trading = text.isin({"true", "open", "trading", "yes"})
            else:
                trading = numeric.eq(1)
        dates = dates.loc[trading]
    dates = dates.loc[dates.between(start_date, end_date)]
    result = pd.DatetimeIndex(sorted(set(pd.Timestamp(value) for value in dates)))
    if result.empty:
        raise CacheQualityError("trade calendar has no in-window trading dates")
    return result


def _fetch_trade_calendar(
    *,
    root: Path,
    client: Any,
    budget: StageBudget,
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
) -> pd.DatetimeIndex:
    identity = {
        "schemaVersion": "assay-p1-trade-calendar-v1",
        "cacheVersion": CACHE_VERSION,
        "start": start_date.strftime("%Y-%m-%d"),
        "end": end_date.strftime("%Y-%m-%d"),
        "exchange": "SH",
        "isTradingDay": 1,
    }
    digest = sha256(
        json.dumps(
            identity,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:16]
    path = root / "support" / f"trade-calendar-{digest}.json"
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise CacheQualityError("cannot read the cached trade calendar") from error
        rows = payload.get("rows") if isinstance(payload, Mapping) else None
        if (
            not isinstance(payload, Mapping)
            or payload.get("identity") != identity
            or not isinstance(rows, list)
        ):
            raise CacheQualityError("cached trade calendar identity is invalid")
        return _normalize_trade_calendar(
            rows,
            start_date=start_date,
            end_date=end_date,
        )
    value = budget.call(
        "get_trade_cal",
        lambda: client.query(
            "trade_calendar",
            {
                "start_date": start_date.strftime("%Y%m%d"),
                "end_date": end_date.strftime("%Y%m%d"),
                "exchange": "SH",
                "is_trading_day": 1,
            },
        ),
    )
    calendar = _normalize_trade_calendar(
        value,
        start_date=start_date,
        end_date=end_date,
    )
    _write_json_atomic(
        path,
        {
            "identity": identity,
            "rows": [
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "is_trading_day": 1,
                }
                for date in calendar
            ],
        },
    )
    return calendar


def _date_windows(
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    days: int,
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    result: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    cursor = start_date.normalize()
    while cursor <= end_date:
        chunk_end = min(
            cursor + pd.Timedelta(days=days - 1),
            end_date,
        )
        result.append((cursor, chunk_end))
        cursor = chunk_end + pd.Timedelta(days=1)
    return result


def _spot_index_daily(
    *,
    client: Any,
    budget: StageBudget,
    row: Mapping[str, Any],
) -> dict[str, Any]:
    date = pd.Timestamp(row["date"])
    request = CacheRequest(
        source="index-daily",
        start_date=date,
        end_date=date,
        symbols=(INDEX_SYMBOL,),
        fields=INDEX_COLUMNS,
    )
    value = budget.call(
        "spot get_index_daily",
        lambda: client.get_index_daily(
            symbol=INDEX_SYMBOL,
            start_date=date.strftime("%Y%m%d"),
            end_date=date.strftime("%Y%m%d"),
            fields=list(INDEX_COLUMNS),
        ),
    )
    observed = _normalize_index_daily(value, request)
    if len(observed) != 1 or not math.isclose(
        float(observed.iloc[0]["close"]),
        float(row["close"]),
        rel_tol=1e-10,
        abs_tol=1e-8,
    ):
        raise CacheQualityError("index daily spot check mismatch")
    return {
        "matched": True,
        "date": date.strftime("%Y-%m-%d"),
        "symbol": INDEX_SYMBOL,
    }


def _prepare_index_daily(
    *,
    config: P1Config,
    client: Any,
    base: pd.DataFrame,
    budget: StageBudget,
) -> tuple[pd.DatetimeIndex, dict[str, Any]]:
    base_dates = pd.DatetimeIndex(
        sorted(pd.Timestamp(value) for value in base["date"].unique())
    )
    calendar_start = base_dates[0] - pd.Timedelta(days=500)
    calendar = _fetch_trade_calendar(
        root=config.version_root,
        client=client,
        budget=budget,
        start_date=calendar_start,
        end_date=base_dates[-1],
    )
    pre_window = calendar[calendar < base_dates[0]]
    if len(pre_window) < EXPECTED_INDEX_LOOKBACK_DAYS:
        raise CacheQualityError("trade calendar lacks the 200-day index lookback")
    in_window = calendar[(calendar >= base_dates[0]) & (calendar <= base_dates[-1])]
    if set(in_window) != set(base_dates):
        raise BaseCoverageError(
            "official trading calendar contradicts base-panel date coverage"
        )
    requested_dates = pd.DatetimeIndex(
        [*pre_window[-EXPECTED_INDEX_LOOKBACK_DAYS:], *in_window]
    )
    expected_keys = {
        (date.strftime("%Y-%m-%d"), INDEX_SYMBOL) for date in requested_dates
    }
    stats = FragmentStats()
    frames: list[pd.DataFrame] = []

    def download(request: CacheRequest) -> Any:
        return client.get_index_daily(
            symbol=INDEX_SYMBOL,
            start_date=request.start_date.strftime("%Y%m%d"),
            end_date=request.end_date.strftime("%Y%m%d"),
            fields=list(INDEX_COLUMNS),
        )

    for start_date, end_date in _date_windows(
        requested_dates[0],
        requested_dates[-1],
        INDEX_WINDOW_DAYS,
    ):
        request = CacheRequest(
            source="index-daily",
            start_date=start_date,
            end_date=end_date,
            symbols=(INDEX_SYMBOL,),
            fields=INDEX_COLUMNS,
        )
        frames.append(
            _materialize_fragment(
                root=config.version_root,
                request=request,
                expected_keys=expected_keys,
                budget=budget,
                downloader=download,
                stats=stats,
            )
        )
    frame = pd.concat(frames, ignore_index=True)
    frame = (
        frame.loc[frame["date"].isin({key[0] for key in expected_keys})]
        .sort_values(["date", "symbol"])
        .reset_index(drop=True)
    )
    if _frame_keys(frame) != expected_keys:
        raise CacheQualityError("index daily has incomplete trading-date coverage")
    materialized = config.version_root / "materialized" / "index-daily.csv"
    _write_frame_atomic(materialized, frame)
    spot: dict[str, Any] = {"matched": True, "skipped": True}
    if config.perform_spot_checks:
        spot = _spot_index_daily(
            client=client,
            budget=budget,
            row=frame.iloc[len(frame) // 2],
        )
    quality = _frame_quality(frame)
    return calendar, {
        "status": "ready",
        "mode": "official_index",
        "path": _relative_cache_path(materialized, config.cache_root),
        "columns": list(INDEX_COLUMNS),
        **quality,
        "lookbackTradingDays": EXPECTED_INDEX_LOOKBACK_DAYS,
        "fragmentStats": {
            "downloaded": stats.downloaded,
            "reused": stats.reused,
            "split": stats.split,
            "invalidated": stats.invalidated,
        },
        "quality": {
            "primaryKeysValid": True,
            "tradingCalendarMatched": True,
            "positiveClose": True,
        },
        "spotCheck": spot,
    }


def _optional_numbers_match(expected: Any, actual: Any) -> bool:
    if pd.isna(expected) and pd.isna(actual):
        return True
    if pd.isna(expected) or pd.isna(actual):
        return False
    return math.isclose(
        float(expected),
        float(actual),
        rel_tol=1e-10,
        abs_tol=1e-8,
    )


def _spot_comparator_factors(
    *,
    client: Any,
    budget: StageBudget,
    row: Mapping[str, Any],
) -> dict[str, Any]:
    date = pd.Timestamp(row["date"])
    symbol = str(row["symbol"])
    request = CacheRequest(
        source="comparator-factors",
        start_date=date,
        end_date=date,
        symbols=(symbol,),
        fields=COMPARATOR_FACTORS,
    )
    value = budget.call(
        "spot get_factor(comparators)",
        lambda: client.get_factor(
            symbol=[symbol],
            start_date=date.strftime("%Y%m%d"),
            end_date=date.strftime("%Y%m%d"),
            factors=list(COMPARATOR_FACTORS),
            type="stock",
        ),
    )
    observed = _normalize_comparator_factors(value, request)
    if len(observed) != 1 or any(
        not _optional_numbers_match(
            row[factor],
            observed.iloc[0][factor],
        )
        for factor in COMPARATOR_FACTORS
    ):
        raise CacheQualityError("comparator factor spot check mismatch")
    return {
        "matched": True,
        "date": date.strftime("%Y-%m-%d"),
        "symbol": symbol,
    }


def _prepare_comparator_factors(
    *,
    config: P1Config,
    client: Any,
    base: pd.DataFrame,
    budget: StageBudget,
) -> dict[str, Any]:
    symbols = _canonical_symbols(base["symbol"])
    expected_keys = {
        (pd.Timestamp(date).strftime("%Y-%m-%d"), str(symbol))
        for date, symbol in zip(
            base["date"],
            base["symbol"],
            strict=True,
        )
    }
    dates = pd.DatetimeIndex(
        sorted(pd.Timestamp(value) for value in base["date"].unique())
    )
    stats = FragmentStats()
    frames: list[pd.DataFrame] = []

    def download(request: CacheRequest) -> Any:
        return client.get_factor(
            symbol=list(request.symbols),
            start_date=request.start_date.strftime("%Y%m%d"),
            end_date=request.end_date.strftime("%Y%m%d"),
            factors=list(COMPARATOR_FACTORS),
            type="stock",
        )

    for start_date, end_date in _date_windows(
        dates[0],
        dates[-1],
        FACTOR_WINDOW_DAYS,
    ):
        request = CacheRequest(
            source="comparator-factors",
            start_date=start_date,
            end_date=end_date,
            symbols=symbols,
            fields=COMPARATOR_FACTORS,
        )
        frames.append(
            _materialize_fragment(
                root=config.version_root,
                request=request,
                expected_keys=expected_keys,
                budget=budget,
                downloader=download,
                stats=stats,
            )
        )
    frame = pd.concat(frames, ignore_index=True)
    frame = frame.sort_values(["date", "symbol"]).reset_index(drop=True)
    if _frame_keys(frame) != expected_keys:
        raise CacheQualityError("comparator factors have incomplete key coverage")
    materialized = config.version_root / "materialized" / "comparator-factors.csv"
    _write_frame_atomic(materialized, frame)
    spot: dict[str, Any] = {"matched": True, "skipped": True}
    if config.perform_spot_checks:
        complete_rows = frame.dropna(subset=list(COMPARATOR_FACTORS))
        sample_frame = complete_rows if not complete_rows.empty else frame
        spot = _spot_comparator_factors(
            client=client,
            budget=budget,
            row=sample_frame.iloc[len(sample_frame) // 2],
        )
    quality = _frame_quality(frame)
    return {
        "status": "ready",
        "mode": "library_and_classic",
        "path": _relative_cache_path(materialized, config.cache_root),
        "columns": list(COMPARATOR_COLUMNS),
        **quality,
        "missingValues": {
            factor: int(frame[factor].isna().sum()) for factor in COMPARATOR_FACTORS
        },
        "fragmentStats": {
            "downloaded": stats.downloaded,
            "reused": stats.reused,
            "split": stats.split,
            "invalidated": stats.invalidated,
        },
        "quality": {
            "primaryKeysValid": True,
            "baseKeyCoverage": True,
            "valuesNumericOrMissing": True,
        },
        "spotCheck": spot,
    }


def _fallback_dataset(
    *,
    status: Literal["blocked", "degraded"],
    mode: str,
    path: str | None,
    columns: Sequence[str],
    reason_code: str,
    assumption: str,
) -> dict[str, Any]:
    return {
        "status": status,
        "mode": mode,
        "path": path,
        "columns": list(columns),
        "rowCount": 0,
        "tradingDates": 0,
        "symbols": 0,
        "reasonCode": reason_code,
        "quality": {
            "primaryKeysValid": False,
            "verified": False,
        },
        "spotCheck": {
            "matched": False,
            "skipped": True,
        },
        "assumptions": [assumption],
    }


def _new_budget(
    *,
    config: P1Config,
    stage: str,
    clock: Callable[[], float],
    sleeper: Callable[[float], None],
    retry_policy: RetryPolicy,
) -> StageBudget:
    return StageBudget(
        stage=stage,
        max_seconds=config.stage_seconds,
        clock=clock,
        sleeper=sleeper,
        retry_policy=retry_policy,
    )


def _run_report(
    *,
    config: P1Config,
    state: Literal["ready", "degraded", "blocked"],
    datasets: Mapping[str, Any],
    assumptions: Sequence[str],
    window: Mapping[str, str] | None,
    universe: Mapping[str, Any] | None,
    promoted: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "cacheVersion": CACHE_VERSION,
        "state": state,
        "promoted": promoted,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "window": dict(window or {}),
        "universe": dict(universe or {}),
        "datasets": dict(datasets),
        "assumptions": list(dict.fromkeys(assumptions)),
    }


def prepare_v9_p1_cache(
    *,
    config: P1Config = P1Config(),
    client: Any | None = None,
    clock: Callable[[], float] = monotonic,
    sleeper: Callable[[float], None] = sleep,
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) -> dict[str, Any]:
    """Prepare and atomically promote the unified v9 P1 cache manifest."""

    active_client = client or create_initialized_client()
    datasets: dict[str, Any] = {}
    assumptions: list[str] = []
    window: dict[str, str] | None = None
    universe: dict[str, Any] | None = None

    try:
        base, base_result = _prepare_base_cache(
            config=config,
            client=active_client,
            budget=_new_budget(
                config=config,
                stage="base-panel",
                clock=clock,
                sleeper=sleeper,
                retry_policy=retry_policy,
            ),
        )
    except Exception:
        datasets["basePanel"] = _fallback_dataset(
            status="blocked",
            mode="unavailable",
            path=_relative_cache_path(config.base_cache, config.cache_root),
            columns=HISTORICAL_COLUMNS,
            reason_code="BASE_CACHE_QUALITY_FAILED",
            assumption=(
                "The fixed-universe base cache did not pass tradable "
                "factor/status reconciliation and was not promoted."
            ),
        )
        report = _run_report(
            config=config,
            state="blocked",
            datasets=datasets,
            assumptions=datasets["basePanel"]["assumptions"],
            window=None,
            universe=None,
            promoted=False,
        )
        _write_json_atomic(config.version_root / "last-run.json", report)
        return report

    datasets["basePanel"] = base_result
    base_dates = pd.DatetimeIndex(
        sorted(pd.Timestamp(value) for value in base["date"].unique())
    )
    base_symbols = _canonical_symbols(base["symbol"])
    window = {
        "start": base_dates[0].strftime("%Y-%m-%d"),
        "end": base_dates[-1].strftime("%Y-%m-%d"),
    }
    universe = {
        "indexSymbol": INDEX_SYMBOL,
        "baseSymbols": len(base_symbols),
        "baseUniverseHash": _universe_hash(base_symbols),
    }

    timeline: dict[pd.Timestamp, frozenset[str]] | None = None
    try:
        timeline, pit_result = _prepare_pit_timeline(
            config=config,
            client=active_client,
            base_dates=base_dates,
            budget=_new_budget(
                config=config,
                stage="pit-timeline",
                clock=clock,
                sleeper=sleeper,
                retry_policy=retry_policy,
            ),
        )
        datasets["pitTimeline"] = pit_result
        if pit_result["terminalAsOf"]:
            assumptions.append(
                "The final PIT observation is a terminal as-of point, not a "
                "completed month-end rebalance signal."
            )
    except Exception:
        datasets["pitTimeline"] = _fallback_dataset(
            status="blocked",
            mode="hard_gate",
            path=(
                "pit-availability-v1/index-weights/" f"{INDEX_SYMBOL.replace('.', '_')}"
            ),
            columns=("requestedDate", "effectiveDate", "symbols"),
            reason_code="PIT_HARD_GATE_FAILED",
            assumption=(
                "The required PIT timeline is incomplete; no substitute "
                "membership timeline is presented as full PIT evidence."
            ),
        )
        assumptions.extend(datasets["pitTimeline"]["assumptions"])

    if timeline is None:
        datasets["historicalMembers"] = _fallback_dataset(
            status="degraded",
            mode="remove_only",
            path=None,
            columns=HISTORICAL_COLUMNS,
            reason_code="PIT_TIMELINE_DEPENDENCY_MISSING",
            assumption=(
                "Historical constituents cannot be added; availability "
                "correction must remove future constituents only."
            ),
        )
        assumptions.extend(datasets["historicalMembers"]["assumptions"])
    else:
        try:
            datasets["historicalMembers"] = _prepare_historical_members(
                config=config,
                client=active_client,
                base=base,
                timeline=timeline,
                budget=_new_budget(
                    config=config,
                    stage="historical-members",
                    clock=clock,
                    sleeper=sleeper,
                    retry_policy=retry_policy,
                ),
            )
        except Exception:
            datasets["historicalMembers"] = _fallback_dataset(
                status="degraded",
                mode="remove_only",
                path=None,
                columns=HISTORICAL_COLUMNS,
                reason_code="HISTORICAL_MEMBER_DATA_UNAVAILABLE",
                assumption=(
                    "Historical constituents could not be fully cached within "
                    "the stage budget; availability correction must use "
                    "remove-only mode."
                ),
            )
            assumptions.extend(datasets["historicalMembers"]["assumptions"])

    base_calendar_failed = False
    try:
        _, datasets["indexDaily"] = _prepare_index_daily(
            config=config,
            client=active_client,
            base=base,
            budget=_new_budget(
                config=config,
                stage="index-daily",
                clock=clock,
                sleeper=sleeper,
                retry_policy=retry_policy,
            ),
        )
    except BaseCoverageError:
        base_calendar_failed = True
        datasets["indexDaily"] = _fallback_dataset(
            status="blocked",
            mode="base_calendar_mismatch",
            path=None,
            columns=INDEX_COLUMNS,
            reason_code="BASE_TRADING_DATE_COVERAGE_FAILED",
            assumption=(
                "The official trading calendar disproved the base panel's "
                "trading-date coverage; cache promotion is blocked."
            ),
        )
        assumptions.extend(datasets["indexDaily"]["assumptions"])
    except Exception:
        datasets["indexDaily"] = _fallback_dataset(
            status="degraded",
            mode="constituent_proxy",
            path=None,
            columns=INDEX_COLUMNS,
            reason_code="INDEX_DAILY_UNAVAILABLE",
            assumption=(
                "CSI 300 index daily data is unavailable; regime analysis "
                "must use the disclosed constituent equal-weight proxy."
            ),
        )
        assumptions.extend(datasets["indexDaily"]["assumptions"])

    try:
        datasets["comparatorFactors"] = _prepare_comparator_factors(
            config=config,
            client=active_client,
            base=base,
            budget=_new_budget(
                config=config,
                stage="comparator-factors",
                clock=clock,
                sleeper=sleeper,
                retry_policy=retry_policy,
            ),
        )
    except Exception:
        datasets["comparatorFactors"] = _fallback_dataset(
            status="degraded",
            mode="classic_only",
            path=None,
            columns=COMPARATOR_COLUMNS,
            reason_code="COMPARATOR_FACTORS_UNAVAILABLE",
            assumption=(
                "ratio_pe_ttm and market_cap are unavailable; homogeneity "
                "analysis must use only the three self-built classic factors."
            ),
        )
        assumptions.extend(datasets["comparatorFactors"]["assumptions"])

    hard_blocked = datasets["pitTimeline"]["status"] != "ready" or base_calendar_failed
    downstream_degraded = any(
        datasets[name]["status"] != "ready"
        for name in (
            "historicalMembers",
            "indexDaily",
            "comparatorFactors",
        )
    )
    state: Literal["ready", "degraded", "blocked"]
    if hard_blocked:
        state = "blocked"
    elif downstream_degraded:
        state = "degraded"
    else:
        state = "ready"
    promoted = state != "blocked"
    report = _run_report(
        config=config,
        state=state,
        datasets=datasets,
        assumptions=assumptions,
        window=window,
        universe=universe,
        promoted=promoted,
    )
    if promoted:
        _write_json_atomic(config.version_root / "manifest.json", report)
    _write_json_atomic(config.version_root / "last-run.json", report)
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare the bounded, resumable v9 P1 Assay data cache."
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=DEFAULT_CACHE_ROOT,
    )
    parser.add_argument(
        "--base-cache",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--stage-seconds",
        type=float,
        default=DEFAULT_STAGE_SECONDS,
    )
    parser.add_argument(
        "--no-spot-checks",
        action="store_true",
        help="Skip narrow provider spot checks; intended only for diagnostics.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    cache_root = Path(args.cache_root)
    base_cache = (
        Path(args.base_cache)
        if args.base_cache is not None
        else cache_root / "csi300-3y.csv"
    )
    if args.stage_seconds <= 0:
        raise SystemExit("--stage-seconds must be positive")
    BASE_BUILDER._load_repo_credentials()
    try:
        report = prepare_v9_p1_cache(
            config=P1Config(
                cache_root=cache_root,
                base_cache=base_cache,
                stage_seconds=float(args.stage_seconds),
                perform_spot_checks=not args.no_spot_checks,
            )
        )
    except Exception:
        print(
            json.dumps(
                {
                    "cacheVersion": CACHE_VERSION,
                    "state": "blocked",
                    "reasonCode": "P1_PREPARATION_FAILED",
                },
                sort_keys=True,
            )
        )
        return 1
    print(
        json.dumps(
            {
                "cacheVersion": CACHE_VERSION,
                "state": report["state"],
                "promoted": report["promoted"],
            },
            sort_keys=True,
        )
    )
    return 0 if report["promoted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
