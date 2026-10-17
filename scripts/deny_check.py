#!/usr/bin/env python3
"""Fail if any denied identifier appears in the given files or folders.

The deny list is read from a file kept OUTSIDE the repository, because a
committed list would publish the very names it is meant to keep out.

Matching is case-insensitive and substring-based. Exact strings passed with
--allow are masked before matching, so an intentional reference (for example
the repo's own URL) passes while every other occurrence of a denied term fails.

Usage:
  python scripts/deny_check.py --deny-file ~/private/denylist.txt \
      --allow github.com/<you>/<repo>  .
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"}
MAX_BYTES = 20 * 1024 * 1024
SHORT_TERM = 4


def load_terms(path: Path) -> list[str]:
    terms = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        term = raw.strip()
        if term and not term.startswith("#"):
            terms.append(term.lower())
    return terms


def iter_files(roots: list[Path]):
    for root in roots:
        if root.is_file():
            yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                yield Path(dirpath) / name


def read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:4096]:
        # Binary file (images, video). Check it by eye, not by grep.
        return None
    return data.decode("utf-8", errors="replace")


def matcher(term: str) -> re.Pattern:
    # Short acronyms collide with ordinary words ("SIG" sits inside "design"),
    # so they only match with no letter on either side. Longer terms match as
    # substrings, which still catches them inside URLs, schema names and emails.
    body = re.escape(term)
    if len(term) <= SHORT_TERM:
        body = rf"(?<![a-z]){body}(?![a-z])"
    return re.compile(body)


def scan(roots: list[Path], terms: list[str], allow: list[str]) -> list[str]:
    allow_lower = [a.lower() for a in allow]
    patterns = [matcher(t) for t in terms]
    hits = []
    for path in iter_files(roots):
        text = read_text(path)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            low = line.lower()
            for a in allow_lower:
                low = low.replace(a, " " * len(a))
            for i, pattern in enumerate(patterns, 1):
                if pattern.search(low):
                    hits.append(f"{path}:{lineno}: denied term #{i}")
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--deny-file", required=True, type=Path)
    ap.add_argument("--allow", action="append", default=[], help="exact string to mask before matching")
    ap.add_argument("paths", nargs="+", type=Path)
    args = ap.parse_args()

    terms = load_terms(args.deny_file)
    if not terms:
        print("deny_check: the deny list is empty, refusing to pass vacuously", file=sys.stderr)
        return 2
    hits = scan(args.paths, terms, args.allow)
    for hit in hits:
        print(hit)
    print(f"deny_check: {len(hits)} hit(s) across {len(terms)} terms", file=sys.stderr)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
