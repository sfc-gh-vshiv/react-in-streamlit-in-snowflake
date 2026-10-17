#!/usr/bin/env python3
"""Fail if Python code calls an `st.*` API the pinned Streamlit doesn't have.

Streamlit in Snowflake's warehouse runtime tops out at a specific Streamlit
version, so code that runs fine against a newer local install can break in
production. Run this with the pinned interpreter:

  ~/.venvs/react-sis/bin/python scripts/check_st_api.py app starter native_twin
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import streamlit


def attr_chain(node: ast.AST) -> list[str] | None:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name) and node.id == "st":
        return list(reversed(parts))
    return None


def missing_apis(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    problems = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute) or isinstance(getattr(node, "ctx", None), ast.Store):
            continue
        chain = attr_chain(node)
        if not chain:
            continue
        obj = streamlit
        for i, name in enumerate(chain):
            if not hasattr(obj, name):
                problems.append(f"{path}:{node.lineno}: st.{'.'.join(chain[: i + 1])} not in streamlit {streamlit.__version__}")
                break
            obj = getattr(obj, name)
    return problems


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv] or [Path(".")]
    files = [p for r in roots for p in ([r] if r.is_file() else r.rglob("*.py")) if "node_modules" not in p.parts]
    problems = sorted({p for f in files for p in missing_apis(f)})
    for p in problems:
        print(p)
    print(f"check_st_api: {len(files)} file(s), {len(problems)} problem(s), streamlit {streamlit.__version__}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
