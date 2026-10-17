"""deploy.sh uploads exactly what deploy.manifest lists, and refuses anything that
looks like a credential or escapes the app folder (checked with --check, which
changes nothing and needs no Snowflake connection)."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[1] / "deploy.sh"
pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


def check(tmp_path: Path, manifest: str, files=("streamlit_app.py",)) -> subprocess.CompletedProcess:
    for f in files:
        (tmp_path / f).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / f).write_text("x")
    (tmp_path / "deploy.manifest").write_text(manifest)
    return subprocess.run(["bash", str(DEPLOY), str(tmp_path), "DB.SCH.APP", "--check"],
                          capture_output=True, text=True)


def test_uploads_exactly_the_manifest(tmp_path):
    r = check(tmp_path, "# comment\nstreamlit_app.py\nui/sl_ui.js  # bundle\n",
              files=("streamlit_app.py", "ui/sl_ui.js", ".streamlit/secrets.toml", "notes.py"))
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == ["upload", "streamlit_app.py", "upload", "ui/sl_ui.js"]


@pytest.mark.parametrize("entry", [
    ".streamlit/secrets.toml", "secrets.toml", ".env", ".env.local", "key.p8", "rsa.pem", "id_rsa",
    "connections.toml", "config.toml", "../escape.py", "/etc/passwd", "~/x.py", "sub/../../x.py", "data.parquet",
])
def test_refuses_credentials_escapes_and_unknown_types(tmp_path, entry):
    files = ["streamlit_app.py"] + ([entry] if not entry.startswith(("/", "~", "..")) and ".." not in entry else [])
    r = check(tmp_path, f"streamlit_app.py\n{entry}\n", files=files)
    assert r.returncode != 0
    assert "deploy.sh:" in r.stderr


def test_refuses_missing_files_and_needs_the_entry_point(tmp_path):
    assert check(tmp_path, "streamlit_app.py\nmissing.py\n").returncode != 0
    assert check(tmp_path, "react_bridge.py\n", files=("react_bridge.py",)).returncode != 0


@pytest.mark.parametrize("title", ["ends with a backslash \\", 'has "quotes"', "semi;colon", "it's"])
def test_refuses_titles_that_could_break_the_sql(tmp_path, title):
    (tmp_path / "streamlit_app.py").write_text("x")
    (tmp_path / "deploy.manifest").write_text("streamlit_app.py\n")
    r = subprocess.run(["bash", str(DEPLOY), str(tmp_path), "DB.SCH.APP", "--title", title, "--check"],
                       capture_output=True, text=True)
    assert r.returncode != 0


def test_accepts_a_plain_title(tmp_path):
    (tmp_path / "streamlit_app.py").write_text("x")
    (tmp_path / "deploy.manifest").write_text("streamlit_app.py\n")
    r = subprocess.run(["bash", str(DEPLOY), str(tmp_path), "DB.SCH.APP", "--title", "Instant BI (native)", "--check"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("app", ["DB.SCH", "DB.SCH.APP.X", "DB.SCH.APP;DROP", "db.sch.\"q\""])
def test_refuses_odd_app_names(tmp_path, app):
    (tmp_path / "streamlit_app.py").write_text("x")
    (tmp_path / "deploy.manifest").write_text("streamlit_app.py\n")
    r = subprocess.run(["bash", str(DEPLOY), str(tmp_path), app, "--check"], capture_output=True, text=True)
    assert r.returncode != 0
