from __future__ import annotations

import importlib.metadata
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from inspect_ai import eval, eval_set
from inspect_ai.log import read_eval_log

from spike_eval import isolation_probe, resume_probe
from spike_support import FIXTURE_ROOT, LAB_SENTINEL, prepare_ab_workspaces, tree_hash


class FixtureTests(unittest.TestCase):
    def test_versions_are_pinned_and_observed(self) -> None:
        self.assertEqual(importlib.metadata.version("inspect-ai"), "0.3.276")
        self.assertEqual(importlib.metadata.version("inspect-swe"), "0.2.71")

    def test_fixture_starts_failing(self) -> None:
        result = subprocess.run(["node", "--test"], cwd=FIXTURE_ROOT, capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("add additionne deux nombres", result.stdout + result.stderr)

    def test_ab_starts_identical_and_remains_independent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="inspect-spike-ab-") as temporary:
            baseline, prompted, initial_hash = prepare_ab_workspaces(Path(temporary))
            self.assertEqual(initial_hash, tree_hash(FIXTURE_ROOT))
            self.assertEqual(tree_hash(baseline), tree_hash(prompted))
            (baseline / "src" / "math.cjs").write_text("baseline-only\n")
            self.assertNotEqual(tree_hash(baseline), tree_hash(prompted))
            self.assertEqual((prompted / "src" / "math.cjs").read_text(), (FIXTURE_ROOT / "src" / "math.cjs").read_text())
            (prompted / "prompt-only.txt").write_text("prompt\n")
            self.assertFalse((baseline / "prompt-only.txt").exists())

    def test_lab_sentinel_exists_only_as_control(self) -> None:
        self.assertTrue(LAB_SENTINEL.is_file())
        self.assertNotIn(LAB_SENTINEL.name, {path.name for path in FIXTURE_ROOT.rglob("*")})


class InspectIntegrationTests(unittest.TestCase):
    def test_inspect_docker_probe_and_log_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="inspect-spike-logs-") as log_dir:
            [log] = eval(isolation_probe(), model="mockllm/model", log_dir=log_dir, display="none")
            self.assertEqual(log.status, "success", log.error)
            self.assertIsNotNone(log.location)
            persisted = read_eval_log(log.location)
            self.assertEqual(persisted.status, "success")
            self.assertEqual(persisted.eval.task, "isolation_probe")
            self.assertEqual(persisted.eval.model, "mockllm/model")
            self.assertEqual(len(persisted.samples or []), 1)
            sample = persisted.samples[0]
            self.assertEqual(sample.input, "Probe d'isolation")
            self.assertEqual(sample.metadata["initial_tree_sha256"], tree_hash(FIXTURE_ROOT))
            self.assertIsNotNone(sample.output)
            self.assertIn('"target_readable": true', sample.output.completion)
            self.assertTrue(sample.scores)
            score = next(iter(sample.scores.values()))
            report = score.metadata
            self.assertTrue(report["target_readable"])
            self.assertTrue(report["target_writable"])
            self.assertEqual(report["lab_sentinel_matches"], [])
            self.assertEqual(report["lab_sentinel_content_matches"], [])
            self.assertFalse(report["docker_socket_visible"])
            self.assertGreater(len(sample.events), 0)
            self.assertGreater(sample.total_time, 0)

    def test_eval_set_reuses_completed_task_and_retries_only_failed_task(self) -> None:
        with tempfile.TemporaryDirectory(prefix="inspect-spike-resume-") as temporary:
            root = Path(temporary); counters = root / "counters"; logs = root / "logs"
            previous = os.environ.get("INSPECT_SPIKE_COUNTER_DIR")
            os.environ["INSPECT_SPIKE_COUNTER_DIR"] = str(counters)
            try:
                success, _ = eval_set(
                    [resume_probe("completed"), resume_probe("retry")], model="mockllm/model",
                    log_dir=str(logs), retry_attempts=0, retry_immediate=False, max_tasks=1, display="none",
                )
                self.assertFalse(success)
                self.assertEqual((counters / "completed.txt").read_text(), "1")
                self.assertEqual((counters / "retry.txt").read_text(), "1")
                (counters / "allow-retry").write_text("yes")
                success, logs_result = eval_set(
                    [resume_probe("completed"), resume_probe("retry")], model="mockllm/model",
                    log_dir=str(logs), retry_attempts=0, retry_immediate=False, max_tasks=1, display="none",
                )
                self.assertTrue(success)
                self.assertEqual((counters / "completed.txt").read_text(), "1")
                self.assertEqual((counters / "retry.txt").read_text(), "2")
                self.assertTrue(logs_result)
            finally:
                if previous is None:
                    os.environ.pop("INSPECT_SPIKE_COUNTER_DIR", None)
                else:
                    os.environ["INSPECT_SPIKE_COUNTER_DIR"] = previous

    def test_spike_has_no_semantic_judge(self) -> None:
        source = (Path(__file__).parents[1] / "spike_eval.py").read_text()
        self.assertNotIn("model_graded", source)
        self.assertNotIn("llm_judge", source.lower())


if __name__ == "__main__":
    unittest.main()
