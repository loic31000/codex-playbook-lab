from __future__ import annotations

import json
import os
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import ModelOutput
from inspect_ai.scorer import CORRECT, INCORRECT, Score, Target, scorer
from inspect_ai.solver import Generate, TaskState, solver
from inspect_ai.util import sandbox
from inspect_swe import codex_cli

from spike_support import FIXTURE_ROOT, LAB_SENTINEL, SPIKE_DIR, tree_hash


CODEX_VERSION = "0.160.0"
TASK_TEXT = """Corrige uniquement la fonction add dans src/math.cjs afin que les tests existants passent.
N'ajoute aucune dépendance et ne modifie pas les tests."""
ADDITIONAL_PROMPT = "Travaille par petites étapes et exécute npm test avant de conclure. N'ajoute aucune dépendance."
SANDBOX = ("docker", str(SPIKE_DIR / "Dockerfile"))


def target_sample(sample_id: str) -> Sample:
    return Sample(
        id=sample_id,
        input=TASK_TEXT,
        files={"/workspace": str(FIXTURE_ROOT)},
        setup="cd /workspace && git init -q && git config user.name 'Inspect Spike' && "
        "git config user.email spike@example.invalid && git add -A && "
        "GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' "
        "git -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -qm initial",
        metadata={"initial_tree_sha256": tree_hash(FIXTURE_ROOT), "codex_cli_version": CODEX_VERSION},
    )


@scorer(metrics=[])
def technical_tests():
    async def score(state: TaskState, target: Target) -> Score:
        tests = await sandbox().exec(["npm", "test"], cwd="/workspace", timeout=120)
        tracked_paths = ["src", "test", "package.json"]
        diff = await sandbox().exec(["git", "diff", "--binary", "--", *tracked_paths], cwd="/workspace")
        status = await sandbox().exec(
            ["git", "status", "--short", "--untracked-files=all", "--", *tracked_paths], cwd="/workspace"
        )
        initial_commit = await sandbox().exec(["git", "rev-parse", "HEAD"], cwd="/workspace")
        passed = tests.returncode == 0 and bool(status.stdout.strip())
        return Score(
            value=CORRECT if passed else INCORRECT,
            answer=state.output.completion,
            explanation="Validation technique uniquement : npm test et présence d'un changement Git.",
            metadata={
                "tests_exit_code": tests.returncode,
                "tests_stdout": tests.stdout,
                "tests_stderr": tests.stderr,
                "git_status": status.stdout,
                "git_diff": diff.stdout,
                "initial_commit": initial_commit.stdout.strip(),
            },
        )

    return score


@task
def codex_spike(variant: str = "baseline") -> Task:
    if variant not in {"baseline", "prompt"}:
        raise ValueError(f"Variante inconnue : {variant}")
    return Task(
        dataset=[target_sample(variant)],
        solver=codex_cli(
            system_prompt=ADDITIONAL_PROMPT if variant == "prompt" else None,
            version=CODEX_VERSION,
            cwd="/workspace",
            web_search="disabled",
            goals=False,
            sandbox_mode="danger-full-access",
            approval_policy="never",
            network_access=False,
        ),
        scorer=technical_tests(),
        sandbox=SANDBOX,
        metadata={"variant": variant, "semantic_judge": False},
        version="1",
    )


@solver
def isolation_probe_solver():
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        environment = sandbox()
        readable = await environment.exec(["test", "-r", "/workspace/src/math.cjs"])
        writable = await environment.exec(["sh", "-lc", "printf 'probe-write\\n' > /workspace/probe-write.txt"])
        sentinel = await environment.exec(
            ["sh", "-lc", f"find / -name {LAB_SENTINEL.name!r} -print -quit 2>/dev/null"], timeout=120
        )
        oracle_text = await environment.exec(
            ["sh", "-lc", "grep -R -l 'CODEX_PLAYBOOK_LAB_SENTINEL_35_MUST_NOT_BE_VISIBLE' "
             "/workspace /root /home /opt /tmp 2>/dev/null || true"], timeout=120
        )
        mounts = await environment.exec(["cat", "/proc/self/mountinfo"])
        root_listing = await environment.exec(["find", "/", "-maxdepth", "2", "-type", "d"])
        report = {
            "target_readable": readable.returncode == 0,
            "target_writable": writable.returncode == 0,
            "lab_sentinel_matches": sentinel.stdout.strip().splitlines(),
            "lab_sentinel_content_matches": oracle_text.stdout.strip().splitlines(),
            "docker_socket_visible": (await environment.exec(["test", "-e", "/var/run/docker.sock"])).returncode == 0,
            "mountinfo": mounts.stdout,
            "root_directories": root_listing.stdout,
        }
        await environment.write_file("/workspace/isolation-report.json", json.dumps(report, indent=2))
        state.output = ModelOutput(model="infrastructure-probe", completion=json.dumps(report, sort_keys=True))
        return state

    return solve


@scorer(metrics=[])
def isolation_probe_scorer():
    async def score(state: TaskState, target: Target) -> Score:
        report = json.loads(state.output.completion)
        isolated = (
            report["target_readable"]
            and report["target_writable"]
            and not report["lab_sentinel_matches"]
            and not report["lab_sentinel_content_matches"]
            and not report["docker_socket_visible"]
        )
        return Score(value=CORRECT if isolated else INCORRECT, metadata=report)

    return score


@task
def isolation_probe() -> Task:
    return Task(
        dataset=[Sample(
            id="isolation",
            input="Probe d'isolation",
            files={"/workspace": str(FIXTURE_ROOT)},
            metadata={"initial_tree_sha256": tree_hash(FIXTURE_ROOT)},
        )],
        solver=isolation_probe_solver(),
        scorer=isolation_probe_scorer(),
        sandbox=SANDBOX,
        metadata={"semantic_judge": False, "lab_sentinel_host_path": str(LAB_SENTINEL)},
        version="1",
    )


@solver
def resume_probe_solver(name: str):
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        counter_dir = Path(os.environ["INSPECT_SPIKE_COUNTER_DIR"])
        counter_dir.mkdir(parents=True, exist_ok=True)
        counter = counter_dir / f"{name}.txt"
        count = int(counter.read_text() if counter.exists() else "0") + 1
        counter.write_text(str(count))
        if name == "retry" and not (counter_dir / "allow-retry").exists():
            raise RuntimeError("interruption contrôlée du spike")
        state.output = ModelOutput(model="resume-probe", completion=f"{name}:{count}")
        return state

    return solve


@scorer(metrics=[])
def completion_scorer():
    async def score(state: TaskState, target: Target) -> Score:
        return Score(value=CORRECT, answer=state.output.completion)

    return score


@task
def resume_probe(name: str = "completed") -> Task:
    return Task(
        dataset=[Sample(id=name, input=f"Resume probe {name}")],
        solver=resume_probe_solver(name),
        scorer=completion_scorer(),
        metadata={"semantic_judge": False},
        version="1",
    )
