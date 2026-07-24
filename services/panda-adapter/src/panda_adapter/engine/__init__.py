"""S1a pure backtest engine and its S0 JSON boundary."""

from .constants import COST_LADDER, COST_MODELS, ENGINE_VERSION
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
    "calculate_metrics",
    "momentum_signal",
    "order_cost_rate",
    "run_cost_ladder",
    "run_grid",
    "run_momentum_backtest",
    "run_request",
]
