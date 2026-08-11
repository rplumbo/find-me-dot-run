"""
build_model.py — Superior 100 Spectator Guide

Reads historical split-time CSVs, scrubs timing errors, and writes model.json.

The model contains:
  - Station metadata and per-station statistics
  - Every runner's split times as compact integer arrays
  - Fastest-ever section durations for every station pair ("section records")

The JavaScript builds cohorts at query time: given the most recent
(station, time) sighting, the cohort is every historical runner who reached
that station within a small window of the sighted time. The arrival
distribution at a later station is that cohort's actual section durations
added to the sighting time. No weighting, no filtering at query time —
every displayed number is a plain statistic of real runners.

Data scrubbing happens HERE, at build time, where every exclusion is logged:
  1. 24-hour wraparound repair, accepted only when the implied section
     pace is plausible (source CSVs store H:MM:SS with H wrapping mod 24).
  2. Section-pace scrub: a split implying a faster-than-humanly-possible
     section is a timing error and is removed.
  3. Split Rock (station 0) is masked for years before 2017 — the course
     changed and old times there run ~25 minutes slower.

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
FINISH_PERCENTILES = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
FINISH_CUTOFF_MINUTES = 38 * 60

# Scrub thresholds. The fastest section pace ever run here by a winner is
# ~9 min/mile (early, downhill-heavy sections); anything under 8 is a
# timing error. Sections longer than 14 hours exceed what aid-station
# cutoffs allow and mark a bad wraparound repair. Cumulative pace beyond
# 28 min/mile is slower than sweep cutoffs permit (legit all-time maxima
# run ~25.7) and marks a slow-side typo.
MIN_SECTION_PACE = 8.0          # minutes per mile
MAX_SECTION_MINUTES = 14 * 60
MAX_CUMULATIVE_PACE = 28.0      # minutes per mile from the start
SPLIT_ROCK_FIRST_VALID_YEAR = 2017  # course changed; older station-0 times differ

DISTANCES = [s["distance"] for s in AID_STATIONS]

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


def parse_finish_time(s: str) -> int | None:
    """Parse the official finish result, including the 24-hour wrap."""
    minutes = parse_time_to_minutes(s)
    if minutes is not None and minutes < 12 * 60:
        minutes += 24 * 60
    return minutes


# ─────────────────────────────────────────────
#  Scrubbing
# ─────────────────────────────────────────────

def section_pace(t_from: int, t_to: int, k_from: int, k_to: int) -> float:
    return (t_to - t_from) / (DISTANCES[k_to] - DISTANCES[k_from])


def scrub_splits(splits: list, log: list, ctx: str) -> list:
    """
    Repair 24h wraparound and remove timing errors, appending one line per
    change to `log`. Returns the scrubbed splits (mutates in place too).
    """
    # Pass 1: wraparound repair with plausibility check.
    last = None
    last_k = None
    for k in range(N_STATIONS):
        if splits[k] is None:
            continue
        if last is not None and splits[k] < last:
            fixed = splits[k] + 1440
            dur = fixed - last
            if section_pace(last, fixed, last_k, k) >= MIN_SECTION_PACE and dur <= MAX_SECTION_MINUTES:
                log.append(f"{ctx} {AID_STATIONS[k]['name']}: wrapped {splits[k]} -> {fixed}")
                splits[k] = fixed
            else:
                log.append(f"{ctx} {AID_STATIONS[k]['name']}: nulled {splits[k]} (non-monotonic, +24h implausible)")
                splits[k] = None
                continue
        last = splits[k]
        last_k = k

    # Pass 2: remove splits implying impossible section paces, measuring
    # from the race start (index -1, time 0, mile 0) as well as between
    # recorded splits. When a pair is bad, null the endpoint that also
    # disagrees with its other neighbor; if ambiguous, trust the earlier
    # split. The virtual start is never a victim.
    def t(k: int) -> int:
        return 0 if k == -1 else splits[k]

    def miles(a: int, b: int) -> float:
        return (DISTANCES[b] if b >= 0 else 0) - (DISTANCES[a] if a >= 0 else 0)

    def bad_pair(a: int, b: int) -> bool:
        return (t(b) - t(a)) / miles(a, b) < MIN_SECTION_PACE

    changed = True
    while changed:
        changed = False
        idx = [-1] + [k for k in range(N_STATIONS) if splits[k] is not None]
        for pos in range(len(idx) - 1):
            a, b = idx[pos], idx[pos + 1]
            if not bad_pair(a, b):
                continue
            if a != -1 and pos > 0 and bad_pair(idx[pos - 1], a):
                victim = a
            elif pos + 2 < len(idx) and bad_pair(b, idx[pos + 2]):
                victim = b
            else:
                victim = b
            log.append(f"{ctx} {AID_STATIONS[victim]['name']}: nulled {splits[victim]} "
                       f"(section faster than {MIN_SECTION_PACE} min/mi)")
            splits[victim] = None
            changed = True
            break

    # Pass 3: slow-side typos — cumulative pace beyond what sweep cutoffs
    # allow cannot be genuine.
    for k in range(N_STATIONS):
        if splits[k] is not None and splits[k] > MAX_CUMULATIVE_PACE * DISTANCES[k]:
            log.append(f"{ctx} {AID_STATIONS[k]['name']}: nulled {splits[k]} "
                       f"(cumulative pace beyond {MAX_CUMULATIVE_PACE} min/mi)")
            splits[k] = None
    return splits


def load_all_runners() -> tuple[list, list, list, dict, list]:
    """
    Parse and scrub all CSVs.

    Returns:
      runners       — list of scrubbed split arrays (for cohort building)
      runner_years  — race year for each entry in `runners` (parallel list)
      named_runners — list of {name, year, splits} dicts (for history lookup)
      finish_times  — elapsed finish times grouped by recorded sex
      scrub_log     — one line per repaired/removed split
    """
    runners       = []
    runner_years  = []
    named_runners = []
    finish_times  = {"men": [], "women": []}
    scrub_log     = []
    for year, path in CSV_FILES:
        p = Path(path)
        if not p.exists():
            print(f"  WARNING: {path} not found — skipping.")
            continue
        with open(p, encoding="utf-8") as fh:
            rows = list(csv.reader(fh))
        for row_num, row in enumerate(rows[2:], start=3):  # skip header and distance row
            if len(row) < SPLIT_START_COL + N_STATIONS * 2:
                continue
            splits = [
                parse_time_to_minutes(row[SPLIT_START_COL + k * 2])
                for k in range(N_STATIONS)
            ]
            scrub_splits(splits, scrub_log, f"{year} row {row_num}")
            if year < SPLIT_ROCK_FIRST_VALID_YEAR and splits[0] is not None:
                splits[0] = None  # course change; summarized in the report
            if any(s is not None for s in splits):
                runners.append(splits)
                runner_years.append(year)
                sex = row[5].strip().upper() if len(row) > 5 else ""
                official_finish = parse_finish_time(row[1]) if len(row) > 1 else None
                if (
                    official_finish is not None
                    and official_finish <= FINISH_CUTOFF_MINUTES
                    and sex in {"M", "F"}
                ):
                    finish_times["men" if sex == "M" else "women"].append(official_finish)
                first = row[3].strip() if len(row) > 3 else ""
                last  = row[4].strip() if len(row) > 4 else ""
                name  = f"{first} {last}".strip()
                if name:
                    named_runners.append({"name": name, "year": year, "splits": splits})
    return runners, runner_years, named_runners, finish_times, scrub_log


def nearest_rank(values: list[int], percentile: int) -> int:
    """Return the nearest-rank cutoff for an ascending list of finish times."""
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile / 100 * len(ordered)))
    return ordered[rank - 1]


def finish_percentile_summary(finish_times: dict) -> dict:
    return {
        group: {
            "count": len(times),
            "cutoffs": {
                str(percentile): nearest_rank(times, percentile)
                for percentile in FINISH_PERCENTILES
            },
        }
        for group, times in finish_times.items()
    }


# ─────────────────────────────────────────────
#  Station Statistics & Section Records
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


def section_records(runners: list, runner_years: list) -> list:
    """
    records[s][t] = [fastest-ever duration in minutes, year it was set]
    for s < t, else None. The floor statistic: no runner in the dataset has
    ever covered section s->t faster.
    """
    records = [[None] * N_STATIONS for _ in range(N_STATIONS)]
    for s in range(N_STATIONS):
        for t in range(s + 1, N_STATIONS):
            best = None
            best_year = None
            for r, year in zip(runners, runner_years):
                a, b = r[s], r[t]
                if a is None or b is None or b < a:
                    continue
                d = b - a
                if best is None or d < best:
                    best, best_year = d, year
            if best is not None:
                records[s][t] = [best, best_year]
    return records


# ─────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────

def main():
    print("Loading and scrubbing runner data…")
    runners, runner_years, named_runners, finish_times, scrub_log = load_all_runners()
    print(f"  {len(runners)} runners loaded.")

    wrapped = sum(1 for l in scrub_log if "wrapped" in l)
    nulled  = sum(1 for l in scrub_log if "nulled" in l)
    masked  = sum(1 for r, y in zip(runners, runner_years)
                  if y < SPLIT_ROCK_FIRST_VALID_YEAR)
    print(f"\nScrub report: {wrapped} wraparound repairs, {nulled} splits removed, "
          f"Split Rock masked for {masked} pre-{SPLIT_ROCK_FIRST_VALID_YEAR} runners.")
    for line in scrub_log:
        if "nulled" in line:
            print(f"  {line}")
    report_path = Path("scrub_report.txt")
    report_path.write_text("\n".join(scrub_log) + "\n", encoding="utf-8")
    print(f"Full log (including wrap repairs): {report_path}")

    print("\nComputing per-station statistics…")
    stats = [station_stats(runners, k) for k in range(N_STATIONS)]
    for k, s in enumerate(stats):
        if s:
            print(f"  {AID_STATIONS[k]['name']:18s}  n={s['count']:3d}  "
                  f"min={s['min']}min  p50={s['p50']}min  max={s['max']}min")

    print("Computing section records…")
    records = section_records(runners, runner_years)

    model = {
        "raceStartHour": RACE_START_HOUR,
        "stations":      AID_STATIONS,
        "stationStats":  stats,
        # records[s][t] = [fastest-ever s->t duration in minutes, year]
        "sectionRecords": records,
        "years":         sorted(set(runner_years)),
        # Each runner is a flat array of N_STATIONS integers (minutes from
        # race start), with null for any station the runner did not reach.
        # The JavaScript cohort logic operates directly on this data.
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

    percentile_path = Path("finish_percentiles.json")
    with open(percentile_path, "w", encoding="utf-8") as fh:
        json.dump({
            "percentiles": FINISH_PERCENTILES,
            "groups": finish_percentile_summary(finish_times),
        }, fh, separators=(",", ":"))
    size_kb = percentile_path.stat().st_size / 1024
    print(f"Wrote {percentile_path}  ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
