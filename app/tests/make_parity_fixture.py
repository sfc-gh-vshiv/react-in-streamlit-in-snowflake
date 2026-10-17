"""Write test/parity_fixture.json: a synthetic cube, filter states, and the results
tpch.aggregate() gives for them. The JS test checks src/cube.ts against it; the
Python test checks the fixture is still current.

    python tests/make_parity_fixture.py
"""
from __future__ import annotations

import json
import random
from dataclasses import asdict
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tpch  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[1] / "frontend" / "test" / "parity_fixture.json"
REGIONS = ["AFRICA", "AMERICA", "ASIA", "EUROPE", "MIDDLE EAST"]
SEGMENTS = ["AUTOMOBILE", "BUILDING", "FURNITURE", "HOUSEHOLD", "MACHINERY"]
PRIORITIES = ["1-URGENT", "2-HIGH", "3-MEDIUM", "4-NOT SPECIFIED", "5-LOW"]


def synthetic_cube(rng: random.Random) -> dict:
    nations = [{"n": i, "nation": f"NATION_{i:02d}", "region": REGIONS[i % 5]} for i in range(25)]
    cols = {k: [] for k in "mnspor"}
    for m in range(tpch.MONTHS):
        for n in range(25):
            for s in range(5):
                for p in range(5):
                    if rng.random() < 0.9:          # sparse: keeps the fixture small
                        continue
                    o = rng.randint(1, 60)
                    for k, v in zip("mnspor", (m, n, s, p, o, o * rng.randint(900, 450_000))):
                        cols[k].append(v)
    return {**cols, "segments": SEGMENTS, "priorities": PRIORITIES, "nations": nations,
            "months": [tpch.month_label(i) for i in range(tpch.MONTHS)], "version": "0" * 16}


def filter_states(rng: random.Random, cube: dict) -> list[tpch.Filters]:
    states = [tpch.Filters(), tpch.Filters(first=10, last=10), tpch.Filters(region="ASIA"),
              tpch.Filters(region="ASIA", nation="NATION_02"), tpch.Filters(segment="BUILDING", priority="1-URGENT"),
              tpch.Filters(nation="NATION_02", region="EUROPE")]          # contradictory: nothing matches
    for _ in range(14):
        first = rng.randrange(tpch.MONTHS)
        states.append(tpch.Filters(
            first=first, last=rng.randrange(first, tpch.MONTHS),
            region=rng.choice([None, *REGIONS]),
            nation=rng.choice([None, None, *[x["nation"] for x in cube["nations"]]]),
            segment=rng.choice([None, *SEGMENTS]),
            priority=rng.choice([None, *PRIORITIES])))
    return states


def build() -> dict:
    rng = random.Random(49)
    cube = synthetic_cube(rng)
    cases = [{"filters": asdict(f), "expected": tpch.aggregate(cube, f)} for f in filter_states(rng, cube)]
    return {"cube": cube, "cases": cases}


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(build(), separators=(",", ":")))
    print(f"wrote {FIXTURE}")
