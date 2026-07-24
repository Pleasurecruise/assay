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
