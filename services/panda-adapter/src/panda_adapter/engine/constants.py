"""Frozen S1a calculation constants.

This is intentionally a small policy surface.  Suspensions, delistings, and
holes are valued at the last observed adjusted close and earn a zero return
until another quote appears.  An untradeable selected name is not backfilled.
That conservative-but-crude behavior is an explicit MVP deviation, not a
claim that the portfolio is realistically executable.
"""

from __future__ import annotations

from typing import Final

ENGINE_VERSION: Final = "s1a-1"
TRADING_DAYS_PER_YEAR: Final = 252
AUDIT_TOOL_CONTRACT_VERSION: Final = "1.0.0"

# CHECKS_WIRING §2 regime labels.  A return dated t is classified only with
# information available through t-1.
REGIME_TREND_MA_DAYS: Final = 200
REGIME_VOLATILITY_WINDOW_DAYS: Final = 60
REGIME_HIGH_VOLATILITY_QUANTILE: Final = 2.0 / 3.0
REGIME_SPLIT_SOURCE_REF: Final = "artifact:regime-dependency/regime-split"

# CHECKS_WIRING §3 classic comparator formulas.  These are deliberately kept
# beside the engine constants until BACKTESTER D9 is promoted to a full ADR:
# momentum_20 = close[t] / close[t-20] - 1
# reversal_5 = -(close[t] / close[t-5] - 1)
# volatility_20 = std(close.pct_change(), 20, ddof=1) * sqrt(252)
HOMOGENEITY_MOMENTUM_WINDOW: Final = 20
HOMOGENEITY_REVERSAL_WINDOW: Final = 5
HOMOGENEITY_VOLATILITY_WINDOW: Final = 20
HOMOGENEITY_AUDIT_SOURCE_REF: Final = (
    "artifact:homogeneity-decay/spearman-ic"
)
HOMOGENEITY_COMPARATORS: Final = (
    "momentum_20",
    "reversal_5",
    "volatility_20",
    "ratio_pe_ttm",
    "market_cap",
)

DAILY_RETURNS_ARTIFACT_SCHEMA_VERSION: Final = (
    "backtest-daily-returns-artifact-v1"
)

# All rates are decimal fractions of order notional.
COST_MODELS: Final = {
    "none": {
        "commissionPerSide": 0.0,
        "stampDutyOnSell": 0.0,
        "impactPerSide": 0.0,
        "totalMultiplier": 1.0,
    },
    "standard": {
        "commissionPerSide": 0.00025,
        "stampDutyOnSell": 0.0005,
        "impactPerSide": 0.0,
        "totalMultiplier": 1.0,
    },
    "realistic": {
        "commissionPerSide": 0.00025,
        "stampDutyOnSell": 0.0005,
        "impactPerSide": 0.001,
        "totalMultiplier": 1.0,
    },
    # The multiplier applies to the complete realistic order cost.
    "pessimistic": {
        "commissionPerSide": 0.00025,
        "stampDutyOnSell": 0.0005,
        "impactPerSide": 0.001,
        "totalMultiplier": 1.5,
    },
}
COST_LADDER: Final = ("standard", "realistic", "pessimistic")
