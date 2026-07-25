"""S1a pure backtest engine and its S0 JSON boundary."""

from .artifacts import (
    daily_returns_artifact_path,
    persist_grid_daily_returns,
)
from .constants import (
    AUDIT_TOOL_CONTRACT_VERSION,
    COST_LADDER,
    COST_MODELS,
    ENGINE_VERSION,
)
from .core import (
    calculate_metrics,
    momentum_signal,
    order_cost_rate,
    run_momentum_backtest,
)
from .experiments import run_cost_ladder, run_grid
from .protocol import run_request

__all__ = [
    "COST_LADDER",
    "COST_MODELS",
    "ENGINE_VERSION",
    "AUDIT_TOOL_CONTRACT_VERSION",
    "calculate_metrics",
    "momentum_signal",
    "order_cost_rate",
    "run_cost_ladder",
    "run_grid",
    "run_momentum_backtest",
    "run_request",
    "daily_returns_artifact_path",
    "persist_grid_daily_returns",
]
