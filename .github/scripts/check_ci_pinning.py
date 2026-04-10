#!/usr/bin/env python3

from __future__ import annotations

import re
import sys
from pathlib import Path


WORKFLOW_DIR = Path(".github/workflows")
REPO_CONFIG_FILES = [
    Path(".goreleaser.yml"),
]
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
USES_RE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
HF_MAIN_RE = re.compile(r"https://huggingface\.co/[^/\s]+/[^/\s]+/resolve/main/")


def main() -> int:
    errors: list[str] = []

    for workflow in sorted(WORKFLOW_DIR.glob("*.yml")):
        lines = workflow.read_text(encoding="utf-8").splitlines()
        for line_no, line in enumerate(lines, start=1):
            match = USES_RE.match(line)
            if not match:
                continue

            reference = match.group(1)
            if reference.startswith("./") or reference.startswith("docker://"):
                continue

            if "@" not in reference:
                errors.append(f"{workflow}:{line_no}: missing @ref in uses: {reference}")
                continue

            _, ref = reference.rsplit("@", 1)
            if not SHA_RE.fullmatch(ref):
                errors.append(
                    f"{workflow}:{line_no}: action ref is not pinned to a 40-char commit SHA: {reference}"
                )

        for line_no, line in enumerate(lines, start=1):
            if HF_MAIN_RE.search(line):
                errors.append(
                    f"{workflow}:{line_no}: mutable Hugging Face resolve/main URL must be pinned to an immutable revision"
                )

    for config_file in REPO_CONFIG_FILES:
        if not config_file.exists():
            continue
        for line_no, line in enumerate(config_file.read_text(encoding="utf-8").splitlines(), start=1):
            if HF_MAIN_RE.search(line):
                errors.append(
                    f"{config_file}:{line_no}: mutable Hugging Face resolve/main URL must be pinned to an immutable revision"
                )

    if errors:
        print("CI pinning check failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print("CI pinning check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
