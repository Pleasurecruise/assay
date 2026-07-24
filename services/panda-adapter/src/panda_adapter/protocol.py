from __future__ import annotations

from datetime import date, datetime
from hashlib import sha256
import json
import math
import re
from typing import Any

from .backtester import BacktestValidationError, run_panda_backtest
from .client import PANDA_DATA_OPERATIONS, PandaDataClient

DEFAULT_MAX_ROWS = 1_000
MAX_ROWS = 5_000
PROTOCOL_OPERATIONS = {*PANDA_DATA_OPERATIONS, "strategy_backtest"}

PARAMETER_ALIASES = {
    "startDate": "start_date",
    "endDate": "end_date",
    "indexSymbol": "index_symbol",
    "stockSymbol": "stock_symbol",
    "indexComponent": "index_component",
    "isTradingDay": "is_trading_day",
    "infoDate": "info_date",
    "startQuarter": "start_quarter",
    "endQuarter": "end_quarter",
    "isLatest": "is_latest",
}

ALLOWED_PARAMETERS = {
    "market_data": {
        "symbol",
        "start_date",
        "end_date",
        "type",
        "fields",
        "indicator",
        "st",
    },
    "adj_factor": {"symbol", "start_date", "end_date", "fields"},
    "index_weights": {
        "index_symbol",
        "stock_symbol",
        "start_date",
        "end_date",
        "fields",
    },
    "trade_list": {"date", "exchange"},
    "stock_status_change": {"symbol", "start_date", "end_date", "fields"},
    "factor": {
        "symbol",
        "start_date",
        "end_date",
        "type",
        "factors",
        "index_component",
    },
    "trade_calendar": {
        "start_date",
        "end_date",
        "exchange",
        "is_trading_day",
        "fields",
    },
    "financial_forecast": {"symbol", "info_date", "end_quarter", "fields"},
    "financial_performance": {"symbol", "info_date", "end_quarter", "fields"},
    "financial_reports": {
        "symbol",
        "fields",
        "start_quarter",
        "end_quarter",
        "date",
        "is_latest",
    },
}

DATE_KEYS = {"start_date", "end_date", "date", "info_date"}
DATE_PATTERN = re.compile(r"^\d{8}$")
FIELD_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
SYMBOL_PATTERN = re.compile(r"^\d{6}\.(?:SH|SZ|BJ)$")


class ProtocolValidationError(ValueError):
    """Raised when an untrusted tool request does not satisfy the wire contract."""


def _normalize_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _normalize_scalar(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_scalar(item) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        return _normalize_scalar(item())
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    return str(value)


def _to_records(value: Any) -> list[dict[str, Any]]:
    if hasattr(value, "to_dict"):
        records = value.to_dict(orient="records")
    elif isinstance(value, list):
        records = value
    elif isinstance(value, dict) and isinstance(value.get("rows"), list):
        records = value["rows"]
    elif isinstance(value, dict):
        records = [value]
    else:
        raise ProtocolValidationError("Provider result is not tabular")

    normalized = _normalize_scalar(records)
    if not isinstance(normalized, list) or not all(
        isinstance(row, dict) for row in normalized
    ):
        raise ProtocolValidationError("Provider result rows are invalid")
    return normalized


def _normalize_parameters(operation: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ProtocolValidationError("params must be an object")
    allowed = ALLOWED_PARAMETERS[operation]
    normalized: dict[str, Any] = {}
    for key, value in raw.items():
        mapped = PARAMETER_ALIASES.get(key, key)
        if mapped not in allowed:
            raise ProtocolValidationError(
                f'Parameter "{key}" is not allowed for {operation}'
            )
        if mapped in DATE_KEYS:
            values = value if isinstance(value, list) else [value]
            if not all(
                isinstance(item, str) and DATE_PATTERN.fullmatch(item)
                for item in values
            ):
                raise ProtocolValidationError(
                    f'Parameter "{key}" must use YYYYMMDD format'
                )
        if mapped in {"symbol", "stock_symbol", "index_symbol"}:
            values = value if isinstance(value, list) else [value]
            if not 1 <= len(values) <= 200 or not all(
                isinstance(item, str) and SYMBOL_PATTERN.fullmatch(item.upper())
                for item in values
            ):
                raise ProtocolValidationError(
                    f'Parameter "{key}" contains an invalid security symbol'
                )
        if mapped == "fields":
            values = value if isinstance(value, list) else [value]
            if not 1 <= len(values) <= 100 or not all(
                isinstance(item, str) and FIELD_PATTERN.fullmatch(item)
                for item in values
            ):
                raise ProtocolValidationError(
                    'Parameter "fields" contains an invalid field name'
                )
        normalized[mapped] = value
    start_date = normalized.get("start_date")
    end_date = normalized.get("end_date")
    if isinstance(start_date, str) and isinstance(end_date, str):
        if start_date > end_date:
            raise ProtocolValidationError("startDate must not be later than endDate")
        start_year = int(start_date[:4])
        end_year = int(end_date[:4])
        if end_year - start_year > 5:
            raise ProtocolValidationError("date range must not exceed five years")
    return normalized


def _source_ref(operation: str, parameters: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"operation": operation, "params": parameters},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = sha256(canonical.encode("utf-8")).hexdigest()[:20]
    if operation == "strategy_backtest":
        return f"assay:backtest:{digest}"
    return f"pandadata:{operation}:{digest}"


def execute_request(client: PandaDataClient, request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ProtocolValidationError("request must be an object")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id.strip():
        raise ProtocolValidationError("id must be a non-empty string")
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in PROTOCOL_OPERATIONS:
        raise ProtocolValidationError("operation is not allowed")
    max_rows = request.get("maxRows", DEFAULT_MAX_ROWS)
    if (
        not isinstance(max_rows, int)
        or isinstance(max_rows, bool)
        or not 1 <= max_rows <= MAX_ROWS
    ):
        raise ProtocolValidationError(f"maxRows must be between 1 and {MAX_ROWS}")

    raw_parameters = request.get("params", {})
    if operation == "strategy_backtest":
        if not isinstance(raw_parameters, dict):
            raise ProtocolValidationError("params must be an object")
        rows = [run_panda_backtest(client, raw_parameters)]
        parameters = raw_parameters
    else:
        parameters = _normalize_parameters(operation, raw_parameters)
        rows = _to_records(client.query(operation, parameters))
    return {
        "id": request_id,
        "ok": True,
        "data": {
            "operation": operation,
            "sourceRef": _source_ref(operation, parameters),
            "rowCount": len(rows),
            "truncated": len(rows) > max_rows,
            "rows": rows[:max_rows],
        },
    }


def error_response(request_id: str, error: Exception) -> dict[str, Any]:
    if isinstance(error, (ProtocolValidationError, BacktestValidationError)):
        code = "invalid_request"
        message = str(error)
        retryable = False
    else:
        code = "provider_query_failed"
        message = "PandaData query failed; provider details were redacted"
        retryable = True
    return {
        "id": request_id,
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        },
    }
