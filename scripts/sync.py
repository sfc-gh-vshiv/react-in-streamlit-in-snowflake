#!/usr/bin/env python3
"""Keep the skill's assets/ identical to starter/, and the app copies of the bridge
in step with the starter.

    python scripts/sync.py           # copy starter/ into skills/.../assets/
    python scripts/sync.py --check   # exit 1 if anything differs (CI and tests use this)
"""
from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STARTER = ROOT / "starter"
ASSETS = ROOT / "skills" / "sis-to-react-in-sis" / "assets"
SKIP = {"node_modules", "__pycache__", ".pytest_cache", ".DS_Store"}
COPIES = [  # (source, copy): files the apps share with the starter
    (STARTER / "react_bridge.py", ROOT / "app" / "react_bridge.py"),
    (STARTER / "frontend" / "src" / "kit.tsx", ROOT / "app" / "frontend" / "src" / "kit.tsx"),
    (ROOT / "app" / "tpch.py", ROOT / "native_twin" / "tpch.py"),
]


def files(base: Path) -> set[Path]:
    return {p.relative_to(base) for p in base.rglob("*") if p.is_file() and not SKIP & set(p.relative_to(base).parts)}


def differences() -> list[str]:
    out = []
    a, b = files(STARTER), files(ASSETS) if ASSETS.exists() else set()
    out += [f"only in starter: {p}" for p in sorted(a - b)]
    out += [f"only in skill assets: {p}" for p in sorted(b - a)]
    out += [f"differs: {p}" for p in sorted(a & b) if not filecmp.cmp(STARTER / p, ASSETS / p, shallow=False)]
    out += [f"differs: {c.relative_to(ROOT)} vs {s.relative_to(ROOT)}" for s, c in COPIES if not filecmp.cmp(s, c, shallow=False)]
    return out


def main() -> int:
    if "--check" in sys.argv:
        diff = differences()
        for d in diff:
            print(d)
        print(f"sync: {'in step' if not diff else f'{len(diff)} difference(s)'}", file=sys.stderr)
        return 1 if diff else 0
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    shutil.copytree(STARTER, ASSETS, ignore=shutil.ignore_patterns(*SKIP))
    for s, c in COPIES:
        shutil.copy2(s, c)
    print(f"copied starter/ to {ASSETS.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
