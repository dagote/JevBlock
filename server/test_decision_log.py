"""Decision-log persistence and hide/review thresholds. No live JEV call."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="adgate-test-"))
os.environ["ADGATE_LOG_PATH"] = str(_TMP / "adgate.jsonl")
os.environ["ADGATE_RUNS_DIR"] = str(_TMP / "runs")
os.environ["ADGATE_DECISION_LOG"] = str(_TMP / "decision-runs.jsonl")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app  # noqa: E402


class DecisionLogTests(unittest.TestCase):
	def test_default_paths_are_server_local(self) -> None:
		log_path = app.default_log_path()
		self.assertEqual(log_path.parts[-3:], ("server", "logs", "adgate.jsonl"))
		self.assertEqual(app.default_runs_dir().parts[-3:], ("server", "logs", "runs"))
		self.assertEqual(
			app.default_decision_log().parts[-3:],
			("server", "logs", "decision-runs.jsonl"),
		)
		self.assertNotIn("ruin", str(log_path))
		self.assertEqual(app.resolve_path("/tmp/custom.jsonl", log_path), Path("/tmp/custom.jsonl"))
		self.assertEqual(app.resolve_path(None, log_path), log_path)

	def test_review_band(self) -> None:
		self.assertEqual(app.action_for_noul(0.75, 0.75), "hide")
		self.assertEqual(app.action_for_noul(0.93, 0.75), "hide")
		self.assertEqual(app.action_for_noul(0.749, 0.75), "review")
		self.assertEqual(app.action_for_noul(0.45, 0.75), "review")
		self.assertEqual(app.action_for_noul(0.449, 0.75), "allow")
		self.assertEqual(app.action_for_noul(0.3, 0.3), "hide")
		self.assertEqual(app.action_for_noul(0.2, 0.3), "allow")

	def test_ingest_writes_json_and_jsonl(self) -> None:
		from fastapi.testclient import TestClient

		fixture = json.loads(
			(Path(__file__).resolve().parents[1] / "fixtures" / "decision-log.sample.json").read_text(
				encoding="utf-8"
			)
		)
		client = TestClient(app.app)
		res = client.post(
			"/v1/log",
			json={
				"sessionId": "test",
				"client": "unit",
				"entries": [{"event": "decision_run", "run": fixture}],
			},
		)
		self.assertEqual(res.status_code, 200)
		body = res.json()
		self.assertEqual(body["decisionRuns"], 1)
		saved = json.loads((_TMP / "runs" / "dry-extreme-sample.json").read_text(encoding="utf-8"))
		self.assertEqual(saved["schema"], "adgate.decision_log.v1")
		self.assertEqual(saved["page"]["url"], "https://canyoublockit.com/extreme-test/")
		self.assertEqual(saved["decisions"][0]["cascadeParents"][0]["reason"], "empty_parent")
		lines = (_TMP / "decision-runs.jsonl").read_text(encoding="utf-8").splitlines()
		self.assertEqual(json.loads(lines[-1])["requestId"], "dry-extreme-sample")
		fetched = client.get("/v1/runs/dry-extreme-sample")
		self.assertEqual(fetched.status_code, 200)
		self.assertEqual(fetched.json()["requestId"], "dry-extreme-sample")
		latest = client.get("/v1/runs/latest")
		self.assertEqual(latest.status_code, 200)
		self.assertEqual(latest.json()["requestId"], "dry-extreme-sample")


if __name__ == "__main__":
	unittest.main()
