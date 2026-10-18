"""The twin's pandas cross-filtering must match tpch.aggregate() exactly, on the
same synthetic cube and filter states the React app's parity test uses."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "app" / "tests"))
import frame  # noqa: E402
import make_parity_fixture  # noqa: E402
import tpch  # noqa: E402

FIX = make_parity_fixture.build()
DF = frame.frame(FIX["cube"])


def test_shared_module_is_identical_to_the_react_apps():
    assert (ROOT / "tpch.py").read_bytes() == (ROOT.parent / "app" / "tpch.py").read_bytes()


def test_environment_matches_the_starter():
    # starter/tests/test_environment.py checks the starter's copy resolves on the warehouse runtime
    assert (ROOT / "environment.yml").read_bytes() == (ROOT.parent / "starter" / "environment.yml").read_bytes()


@pytest.mark.parametrize("case", FIX["cases"], ids=lambda c: str(c["filters"]))
def test_pandas_aggregate_matches_the_reference(case):
    got = frame.aggregate(DF, tpch.Filters(**case["filters"]))
    exp = case["expected"]
    for k in ("orders", "revenue", "urgent"):
        assert got["kpi"][k] == exp["kpi"][k]
    for k in ("aov", "urgent_pct"):
        assert got["kpi"][k] == pytest.approx(exp["kpi"][k], abs=1e-9)
    assert got["monthly"] == exp["monthly"]
    for d in ("region", "nation", "segment", "priority"):
        assert got[d] == exp[d]
