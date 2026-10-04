from __future__ import annotations

import hashlib
import shutil
from pathlib import Path


SPIKE_DIR = Path(__file__).resolve().parent
LAB_ROOT = SPIKE_DIR.parents[1]
FIXTURE_ROOT = LAB_ROOT / "fixtures" / "inspect-spike-target"
LAB_SENTINEL = LAB_ROOT / "fixtures" / "inspect-spike-lab-sentinel.txt"


def tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for candidate in sorted(path for path in root.rglob("*") if path.is_file()):
        relative = candidate.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(candidate.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def prepare_ab_workspaces(destination: Path) -> tuple[Path, Path, str]:
    baseline = destination / "baseline"
    prompted = destination / "prompt"
    shutil.copytree(FIXTURE_ROOT, baseline)
    shutil.copytree(FIXTURE_ROOT, prompted)
    baseline_hash = tree_hash(baseline)
    prompted_hash = tree_hash(prompted)
    if baseline_hash != prompted_hash:
        raise RuntimeError("BASELINE et AVEC PROMPT n'ont pas le même état initial")
    return baseline, prompted, baseline_hash
