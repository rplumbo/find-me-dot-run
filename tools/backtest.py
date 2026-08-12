"""
Leave-one-year-out backtest of the Spectator Guide's cohort statistics.

This is the verification gate for the claims the app makes to families.
Every displayed statistic comes from ONE group: the runners who reached the
sighted station near the sighted time. The gate checks that those group
statistics stay honest for future runners:

  1. "Earliest" (the group minimum, the display's lower bound) behaves like
     a sample minimum should: beaten 1-4% of the time.
  2. "Half arrived by" (the median) splits future arrivals ~50/50.
  3. The middle-half window (1-in-4 to 3-in-4) contains ~50% of arrivals.
  4. "19 of 20 by" is exceeded by roughly 1 in 20 arrivals (<= 8%).

It replicates js/track.js predict() EXACTLY (same windows, same widening,
same percentile rule) on scrubbed data from build_model.load_all_runners().
For each held-out year, cohorts and section records are built from all
other years, and every runner's recorded splits are replayed as sightings
rounded to the 5-minute grid the UI enforces.

Run:  python3 tools/backtest.py        (exits non-zero if a claim fails)
"""

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import os
os.chdir(Path(__file__).resolve().parent.parent)

from build_model import load_all_runners, N_STATIONS

# Must match js/track.js
COHORT_WINDOWS = [10, 15, 20]
COHORT_TARGET_SIZE = 40
MIN_COHORT_SIZE = 5


def pct(sorted_ts, p):
    """Percentile rule shared with the JS: smallest t with cum/n >= p."""
    n = len(sorted_ts)
    cum = 0
    for t in sorted_ts:
        cum += 1
        if cum / n >= p:
            return t
    return sorted_ts[-1]


def predict(train, observations, target_idx):
    """Mirror of js/track.js predict()."""
    relevant = [o for o in observations if o[0] < target_idx]
    if not relevant:
        return None
    latest_idx, latest_min = max(relevant, key=lambda o: o[0])

    durations = []
    dnf = 0
    for w in COHORT_WINDOWS:
        durations = []
        dnf = 0
        for r in train:
            split = r[latest_idx]
            if split is None or abs(split - latest_min) > w:
                continue
            target = r[target_idx]
            if target is None:
                if not any(r[k] is not None for k in range(target_idx, N_STATIONS)):
                    dnf += 1
                continue
            if target < split:
                continue
            durations.append(target - split)
        if len(durations) >= COHORT_TARGET_SIZE:
            break

    if len(durations) < MIN_COHORT_SIZE:
        return None
    ts = sorted(latest_min + d for d in durations)
    return {
        "p0": ts[0],
        "p05": pct(ts, 0.05),
        "p25": pct(ts, 0.25),
        "p50": pct(ts, 0.50),
        "p75": pct(ts, 0.75),
        "p95": pct(ts, 0.95),
        "n": len(ts),
        "dnf": dnf,
    }


def r5(m):
    """The UI's 5-minute dropdown grid."""
    return round(m / 5) * 5


def main():
    runners, runner_years, _named, _finish, _log = load_all_runners()
    by_year = defaultdict(list)
    for r, y in zip(runners, runner_years):
        by_year[y].append(r)
    years = sorted(by_year)

    n_pred = 0
    beat_p0 = 0
    beat_p50 = 0
    beat_p95 = 0
    in_band = 0
    races = 0
    races_beat_p0 = 0
    no_prediction = 0

    for test_year in years:
        train = [r for y in years if y != test_year for r in by_year[y]]
        for splits in by_year[test_year]:
            recorded = [k for k in range(N_STATIONS) if splits[k] is not None]
            race_beat = False
            race_preds = 0
            for i in range(len(recorded) - 1):
                k, tgt = recorded[i], recorded[i + 1]
                pr = predict(train, [(k, r5(splits[k]))], tgt)
                if not pr:
                    no_prediction += 1
                    continue
                actual = splits[tgt]
                n_pred += 1
                race_preds += 1
                if actual < pr["p0"]:
                    beat_p0 += 1
                    race_beat = True
                if actual < pr["p50"]:
                    beat_p50 += 1
                if actual > pr["p95"]:
                    beat_p95 += 1
                if pr["p25"] <= actual <= pr["p75"]:
                    in_band += 1
            if race_preds >= 3:
                races += 1
                if race_beat:
                    races_beat_p0 += 1

    p0_rate = beat_p0 / n_pred
    p0_race_rate = races_beat_p0 / races
    p50_rate = beat_p50 / n_pred
    p95_rate = beat_p95 / n_pred
    cov = in_band / n_pred

    print(f"predictions: {n_pred}  (no prediction possible: {no_prediction})")
    print(f"races (>=3 predictions): {races}")
    print(f"arrived before group Earliest:  {beat_p0} ({p0_rate:.2%} of predictions, "
          f"{p0_race_rate:.1%} of races at least once)")
    print(f"arrived before 'half by':       {beat_p50} ({p50_rate:.1%})")
    print(f"arrived after '19 of 20 by':    {beat_p95} ({p95_rate:.2%})")
    print(f"middle-half window coverage:    {cov:.1%}")

    checks = [
        ("group earliest beaten 1-4%", 0.01 <= p0_rate <= 0.04),
        ("half-by splits arrivals 47-53%", 0.47 <= p50_rate <= 0.53),
        ("19-of-20 exceeded <= 8%", p95_rate <= 0.08),
        ("middle-half coverage 47-53%", 0.47 <= cov <= 0.53),
    ]
    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if failed:
        sys.exit(1)
    print("All claims verified.")


if __name__ == "__main__":
    main()
