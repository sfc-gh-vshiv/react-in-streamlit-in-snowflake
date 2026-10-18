"""environment.yml must resolve on the warehouse runtime, which supports only the '='
specifier and matches it exactly. Python versions have a patch number, so python=3.11
matches nothing and the app fails to start with "Packages not found: python==3.11";
python=3.11.* works. Offline: this checks the file, not Snowflake."""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parents[1]
ENV = yaml.safe_load((HERE / "environment.yml").read_text())
SPEC = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?:=(?P<version>[0-9][0-9A-Za-z.]*(?:\.\*)?))?$")
PYTHON = re.compile(r"^3\.(9|10|11)\.\*$")  # the warehouse runtime offers Python 3.9 to 3.11


def problem(spec: str) -> str | None:
    m = SPEC.match(spec)
    if not m:
        return f"{spec!r}: use name, name=VERSION or name=VERSION.* (only '=' is supported)"
    if m["name"] == "python" and m["version"] and not PYTHON.match(m["version"]):
        return f"{spec!r}: pin Python as 3.9.*, 3.10.* or 3.11.* ('=' is an exact match)"
    return None


def test_uses_the_snowflake_channel_only():
    assert ENV["channels"] == ["snowflake"]


def test_every_dependency_resolves_on_the_warehouse_runtime():
    assert [p for d in ENV["dependencies"] if (p := problem(str(d)))] == []


@pytest.mark.parametrize("spec", ["python=3.11", "python=3.12.*", "streamlit==1.52.2", "pandas>=2.0", "pandas 2.*"])
def test_the_check_rejects_specs_that_do_not_resolve(spec):
    assert problem(spec)


@pytest.mark.parametrize("spec", ["python=3.11.*", "streamlit=1.52.2", "pandas=2.*", "snowflake-snowpark-python"])
def test_the_check_accepts_specs_that_resolve(spec):
    assert problem(spec) is None


def test_both_runtimes_pin_the_same_streamlit():
    conda = {m["name"]: m["version"] for d in ENV["dependencies"] if (m := SPEC.match(str(d)))}
    pypi = tomllib.loads((HERE / "pyproject.toml").read_text())["project"]["dependencies"]
    pins = [m["v"] for d in pypi if (m := re.match(r"^streamlit(\[[^\]]*\])?==(?P<v>\S+)$", d))]
    assert pins == [conda["streamlit"]]
