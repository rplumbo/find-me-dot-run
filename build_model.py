"""
build_model.py — Superior 100 Spectator Guide

Reads historical split-time CSVs and writes model.json.

The model contains:
  - Station metadata and per-station statistics
  - Every runner's split times as compact integer arrays

The JavaScript uses this data to run joint Gaussian kernel regression at
query time: given one or more (station, time) observations, it finds the
cohort of historical runners who match the *full* observed race history
(weight = product of kernels across all observations), then reads off the
conditional distribution at each target station from that cohort.

This is the correct "peers who share their race history" model. Pre-computing
pairwise conditionals and combining them independently would be wrong for
multiple observations because it ignores the joint constraint.

Usage:
    python3 build_model.py
"""

import csv
import json
import math
from pathlib import Path

# ─────────────────────────────────────────────
#  Configuration
# ─────────────────────────────────────────────

RACE_START_HOUR = 8  # 8:00 AM

AID_STATIONS = [
    {"name": "Split Rock",    "distance": 8.4},
    {"name": "Beaver Bay",    "distance": 18.7},
    {"name": "Silver Bay",    "distance": 23.0},
    {"name": "Tettegouche",   "distance": 33.1},
    {"name": "County Road 6", "distance": 42.4},
    {"name": "Finland",       "distance": 50.0},
    {"name": "Sonju Lake Rd", "distance": 57.7},
    {"name": "Crosby",        "distance": 62.0},
    {"name": "Sugarloaf",     "distance": 71.5},
    {"name": "Cramer Road",   "distance": 77.0},
    {"name": "Temperance",    "distance": 83.9},
    {"name": "Sawbill",       "distance": 89.2},
    {"name": "Oberg",         "distance": 94.8},
    {"name": "Finish",        "distance": 102.0},
]

# Each entry is (year, path)
CSV_FILES = [
    (2014, "historical_data/Superior 100 Splits - 2014 - Superior 100 Splits - 2014.csv"),
    (2015, "historical_data/Superior 100 Splits - 2015 - Superior 100 Splits - 2015.csv"),
    (2016, "historical_data/Superior 100 Splits - 2016 - Superior 100 Splits - 2016.csv"),
    (2017, "historical_data/Superior 100 Splits - 2017 - Sheet1.csv"),
    (2018, "historical_data/Superior 100 Splits - 2018  - Sheet1.csv"),
    (2019, "historical_data/Superior 100 Splits - 2019  - Sheet1.csv"),
    (2021, "historical_data/Superior 100 Splits - 2021 - 2021.csv"),
    (2022, "historical_data/Superior 100 Splits - 2022 - 2022.csv"),
    (2023, "historical_data/Superior 100 Splits - 2023 - 2023.csv"),
    (2024, "historical_data/Superior 100 Splits - 2024 - 2024.csv"),
    (2025, "historical_data/Superior 100 Splits - 2025 - 2025.csv"),
]

SPLIT_START_COL = 12
N_STATIONS      = len(AID_STATIONS)

# ─────────────────────────────────────────────
#  CSV Parsing
# ─────────────────────────────────────────────

def parse_time_to_minutes(s: str) -> int | None:
    """Convert "H:MM:SS" cumulative race time to whole minutes from race start."""
    s = s.strip()
    if not s or s == "--:--":
        return None
    parts = s.split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, sec = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None
    return round((h * 3600 + m * 60 + sec) / 60)


def load_all_runners() -> tuple[list, list]:
    """
    Parse all CSVs.

    Returns:
      runners       — list of raw split arrays (anonymous, for kernel regression)
      named_runners — list of {name, year, splits} dicts (for history lookup)
    """
    runners       = []
    named_runners = []
    for year, path in CSV_FILES:
        p = Path(path)
        if not p.exists():
            print(f"  WARNING: {path} not found — skipping.")
            continue
        with open(p, encoding="utf-8") as fh:
            rows = list(csv.reader(fh))
        for row in rows[2:]:          # skip header and distance row
            if len(row) < SPLIT_START_COL + N_STATIONS * 2:
                continue
            splits = [
                parse_time_to_minutes(row[SPLIT_START_COL + k * 2])
                for k in range(N_STATIONS)
            ]
            # Fix 24-hour wraparound: source CSVs store times as H:MM:SS but
            # H wraps mod 24, so runners passing 24h appear to have small times.
            # Enforce monotonicity by adding 1440 wherever a split wrapped.
            last_valid = None
            for k in range(N_STATIONS):
                if splits[k] is not None:
                    if last_valid is not None and splits[k] < last_valid:
                        splits[k] += 1440
                    last_valid = splits[k]
            if any(s is not None for s in splits):
                runners.append(splits)
                first = row[3].strip() if len(row) > 3 else ""
                last  = row[4].strip() if len(row) > 4 else ""
                name  = f"{first} {last}".strip()
                if name:
                    named_runners.append({"name": name, "year": year, "splits": splits})
    return runners, named_runners


# ─────────────────────────────────────────────
#  Station Statistics
# ─────────────────────────────────────────────

def station_stats(runners: list, idx: int) -> dict | None:
    times = sorted(t for r in runners if (t := r[idx]) is not None)
    if not times:
        return None
    n    = len(times)
    mean = sum(times) / n
    std  = math.sqrt(sum((t - mean) ** 2 for t in times) / n)
    pct  = lambda p: times[max(0, int(n * p))]
    return {
        "mean":  round(mean, 1),
        "std":   round(std, 1),
        "min":   times[0],
        "max":   times[-1],
        "p5":    pct(0.05),
        "p10":   pct(0.10),
        "p25":   pct(0.25),
        "p50":   pct(0.50),
        "p75":   pct(0.75),
        "p90":   pct(0.90),
        "p95":   pct(0.95),
        "count": n,
    }


# ─────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────

def main():
    print("Loading runner data…")
    runners, named_runners = load_all_runners()
    print(f"  {len(runners)} runners loaded.")

    print("Computing per-station statistics…")
    stats = [station_stats(runners, k) for k in range(N_STATIONS)]
    for k, s in enumerate(stats):
        if s:
            print(f"  {AID_STATIONS[k]['name']:18s}  n={s['count']:3d}  "
                  f"p10={s['p10']}min  p50={s['p50']}min  p90={s['p90']}min")

    model = {
        "raceStartHour": RACE_START_HOUR,
        "stations":      AID_STATIONS,
        "stationStats":  stats,
        # Each runner is a flat array of N_STATIONS integers (minutes from
        # race start), with null for any station the runner did not reach.
        # The JavaScript kernel regression operates directly on this data.
        "runners": runners,
    }

    out_path = Path("model.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(model, fh, separators=(",", ":"))
    size_kb = out_path.stat().st_size / 1024
    print(f"\nWrote {out_path}  ({size_kb:.1f} KB)")

    named_path = Path("named_runners.json")
    with open(named_path, "w", encoding="utf-8") as fh:
        json.dump(named_runners, fh, separators=(",", ":"))
    size_kb = named_path.stat().st_size / 1024
    print(f"Wrote {named_path}  ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
