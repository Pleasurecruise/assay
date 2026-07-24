"""Create a deterministic cache used only when PandaData credentials are absent.

All symbols are flat. The strategy therefore has no gross edge and transaction
costs produce a clear cost-stress failure. This fixture proves integration; it
is not market evidence and must never be presented as a real-data audit.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

DEFAULT_OUTPUT = Path(".cache/assay/csi300-3y-synthetic.csv")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="20230724")
    parser.add_argument("--end", default="20260723")
    parser.add_argument("--symbols", type=int, default=100)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if args.symbols < 70:
        parser.error("--symbols must be at least 70 for the sprint grid")

    dates = pd.bdate_range(args.start, args.end)
    symbols = [f"{index:06d}.SZ" for index in range(1, args.symbols + 1)]
    rows = pd.MultiIndex.from_product(
        [dates, symbols],
        names=["date", "symbol"],
    ).to_frame(index=False)
    rows["date"] = rows["date"].dt.strftime("%Y-%m-%d")
    rows["adjClose"] = 100.0
    rows["tradeStatus"] = 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rows.to_csv(args.output, index=False)
    print(
        f"synthetic cache ready: path={args.output} "
        f"rows={len(rows)} symbols={args.symbols}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
