"""
Leave-one-year-out calibration for Track Runner crew-risk settings.

This simulates the app's next-station workflow:
  - hold out one race year
  - build the cohort model from all other years
  - after each observed checkpoint, predict the next checkpoint
  - score whether a crew would miss the runner by arriving at each candidate
    low-percentile start time

Usage:
    python3 calibrate_crew_risk.py
"""

from __future__ import annotations

import csv
import math
import statistics
from pathlib import Path

from build_model import AID_STATIONS, CSV_FILES, N_STATIONS, SPLIT_START_COL

BANDWIDTH = 30

CANDIDATE_PERCENTILES = [
    0,
    0.0025,
    0.005,
    0.0075,
    0.01,
    0.015,
    0.02,
    0.025,
    0.03,
    0.04,
    0.05,
    0.075,
    0.10,
    0.15,
    0.20,
    0.25,
]

MODE_TARGETS = [
    ("Crew Safe", 0.05),
    ("Balanced", 0.10),
    ("Aggressive", 0.15),
]


def parse_time_to_minutes(value: str) -> int | None:
    value = value.strip()
    if not value or value == "--:--":
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None
    return round((hours * 3600 + minutes * 60 + seconds) / 60)


def load_runners() -> list[dict]:
    runners = []
    uid = 0

    for year, path in CSV_FILES:
        with Path(path).open(encoding="utf-8") as handle:
            rows = list(csv.reader(handle))

        for row in rows[2:]:
            if len(row) < SPLIT_START_COL + N_STATIONS * 2:
                continue

            splits = [
                parse_time_to_minutes(row[SPLIT_START_COL + station_idx * 2])
                for station_idx in range(N_STATIONS)
            ]

            last_valid = None
            for idx, split in enumerate(splits):
                if split is None:
                    continue
                if last_valid is not None and split < last_valid:
                    split += 1440
                    splits[idx] = split
                last_valid = split

            if not any(split is not None for split in splits):
                continue

            uid += 1
            runners.append(
                {
                    "id": uid,
                    "year": year,
                    "splits": splits,
                    "finished": splits[-1] is not None,
                }
            )

    return runners


def gaussian_weight(diff: float) -> float:
    return math.exp(-0.5 * (diff / BANDWIDTH) ** 2)


def weighted_percentile(samples: list[tuple[int, float]], total_weight: float, percentile: float) -> int:
    cumulative = 0.0
    for value, weight in samples:
        cumulative += weight
        if cumulative / total_weight >= percentile:
            return value
    return samples[-1][0]


def predict(model_runners: list[dict], observations: list[tuple[int, int]], target_idx: int) -> dict | None:
    samples = []

    for runner in model_runners:
        weight = 1.0
        splits = runner["splits"]
        for station_idx, observed_minutes in observations:
            split = splits[station_idx]
            if split is None:
                weight = 0
                break
            weight *= gaussian_weight(split - observed_minutes)

        if weight < 1e-9:
            continue

        target = splits[target_idx]
        if target is not None:
            samples.append((target, weight))

    if len(samples) < 5:
        return None

    samples.sort()
    total_weight = sum(weight for _, weight in samples)
    return {
        percentile: weighted_percentile(samples, total_weight, percentile)
        for percentile in CANDIDATE_PERCENTILES
    }


def round_to_five(minutes: int) -> int:
    return round(minutes / 5) * 5


def quantile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * percentile
    lo = int(position)
    hi = min(lo + 1, len(values) - 1)
    frac = position - lo
    return values[lo] * (1 - frac) + values[hi] * frac


def rounded(value: float | None) -> float | None:
    return None if value is None else round(value, 1)


def summarize(forecasts: list[dict], percentile: float) -> dict:
    misses = []
    waits = []

    for forecast in forecasts:
        start = forecast["pred"][percentile]
        actual = forecast["actual"]
        if actual < start:
            misses.append(start - actual)
        else:
            waits.append(actual - start)

    return {
        "n": len(forecasts),
        "miss_rate": len(misses) / len(forecasts),
        "miss_n": len(misses),
        "miss_med": rounded(quantile(misses, 0.5)),
        "miss_p90": rounded(quantile(misses, 0.9)),
        "wait_med": rounded(quantile(waits, 0.5)),
        "wait_p90": rounded(quantile(waits, 0.9)),
        "wait_p95": rounded(quantile(waits, 0.95)),
        "wait_mean": rounded(statistics.mean(waits)) if waits else None,
    }


def main() -> None:
    runners = load_runners()
    years = sorted({runner["year"] for runner in runners})
    forecasts = []
    journeys_by_percentile = {percentile: {} for percentile in CANDIDATE_PERCENTILES}

    for holdout_year in years:
        model_runners = [runner for runner in runners if runner["year"] != holdout_year]
        test_runners = [runner for runner in runners if runner["year"] == holdout_year]

        for runner in test_runners:
            splits = runner["splits"]
            for station_idx in range(N_STATIONS - 1):
                if splits[station_idx] is None or splits[station_idx + 1] is None:
                    continue

                observations = [
                    (idx, round_to_five(split))
                    for idx, split in enumerate(splits[: station_idx + 1])
                    if split is not None
                ]
                pred = predict(model_runners, observations, station_idx + 1)
                if pred is None:
                    continue

                forecasts.append(
                    {
                        "runner_id": runner["id"],
                        "year": holdout_year,
                        "finished": runner["finished"],
                        "target": station_idx + 1,
                        "actual": splits[station_idx + 1],
                        "pred": pred,
                    }
                )

                if runner["finished"]:
                    for percentile in CANDIDATE_PERCENTILES:
                        journey = journeys_by_percentile[percentile].setdefault(
                            runner["id"], {"misses": 0, "transitions": 0}
                        )
                        journey["transitions"] += 1
                        if splits[station_idx + 1] < pred[percentile]:
                            journey["misses"] += 1

    print(f"Runner performances: {len(runners)}")
    print(f"Years: {', '.join(str(year) for year in years)}")
    print(f"Leave-one-year-out next-station forecasts: {len(forecasts)}")
    print()
    print("percentile,miss_rate,miss_n,wait_med,wait_p90,wait_p95,journey_any_miss_finishers")

    for percentile in CANDIDATE_PERCENTILES:
        summary = summarize(forecasts, percentile)
        journeys = list(journeys_by_percentile[percentile].values())
        journey_any_miss = sum(journey["misses"] > 0 for journey in journeys) / len(journeys)
        print(
            f"{percentile:.4f},"
            f"{summary['miss_rate']:.4f},"
            f"{summary['miss_n']},"
            f"{summary['wait_med']},"
            f"{summary['wait_p90']},"
            f"{summary['wait_p95']},"
            f"{journey_any_miss:.4f}"
        )

    print()
    print("Recommended modes")
    for label, target_any_miss in MODE_TARGETS:
        feasible = []
        for percentile in CANDIDATE_PERCENTILES:
            journeys = list(journeys_by_percentile[percentile].values())
            journey_any_miss = sum(journey["misses"] > 0 for journey in journeys) / len(journeys)
            if journey_any_miss <= target_any_miss:
                feasible.append(percentile)

        percentile = max(feasible)
        summary = summarize(forecasts, percentile)
        journeys = list(journeys_by_percentile[percentile].values())
        journey_any_miss = sum(journey["misses"] > 0 for journey in journeys) / len(journeys)
        print(
            f"{label}: p{percentile * 100:g}, "
            f"per-stop miss {summary['miss_rate']:.2%}, "
            f"full-race any miss {journey_any_miss:.2%}, "
            f"median wait {summary['wait_med']} min, "
            f"p90 wait {summary['wait_p90']} min"
        )

    print()
    print("By target station at Crew Safe p1")
    for target_idx in range(1, N_STATIONS):
        station_forecasts = [forecast for forecast in forecasts if forecast["target"] == target_idx]
        summary = summarize(station_forecasts, 0.01)
        print(
            f"{AID_STATIONS[target_idx]['name']}: "
            f"miss {summary['miss_rate']:.2%}, "
            f"median wait {summary['wait_med']} min"
        )


if __name__ == "__main__":
    main()
