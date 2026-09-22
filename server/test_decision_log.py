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


class PageJudgePriorTests(unittest.TestCase):
	def test_ad_host_matches_href_and_ad_com_only(self) -> None:
		linked = app.PageElement(id="e", tag="a", href="https://ad.com/click")
		noul, reason = app.apply_element_priors(linked, 0.12, "marketing", "s1_ad_or_unrelated")
		self.assertEqual((noul, reason), (0.9, "s1_plus_adhost_prior"))

		iframe = app.PageElement(id="e", tag="iframe", src="https://servedby.doubleclick.net/ad")
		noul, reason = app.apply_element_priors(iframe, 0.2, "news", "s1_ad_or_unrelated")
		self.assertEqual(reason, "s1_plus_adhost_prior")

		story = app.PageElement(id="e", tag="a", href="https://head.com/story")
		noul, reason = app.apply_element_priors(story, 0.1, "news", "s1_ad_or_unrelated")
		self.assertEqual((noul, reason), (0.1, "s1_ad_or_unrelated"))
		self.assertIsNone(app.AD_HOST_RE.search("https://head.com/story"))
		self.assertIsNone(app.AD_HOST_RE.search("https://notad.com/x"))

	def test_overlay_and_push_priors_are_labeled(self) -> None:
		dialog = app.PageElement(id="e", fixedOrSticky=True, role="dialog", text="Welcome")
		self.assertEqual(
			app.apply_element_priors(dialog, 0.2, "marketing", "s1_ad_or_unrelated"),
			(0.9, "s1_plus_overlay_prior"),
		)
		offer = app.PageElement(id="e", fixedOrSticky=True, classes=["slot"], text="Special Offer")
		self.assertEqual(
			app.apply_element_priors(offer, 0.4, "marketing", "s1_ad_or_unrelated")[1],
			"s1_plus_overlay_prior",
		)
		click = app.PageElement(id="e", fixedOrSticky=True, text="Click here")
		self.assertEqual(
			app.apply_element_priors(click, 0.3, "other", "s1_ad_or_unrelated")[1],
			"s1_plus_overlay_prior",
		)
		loose = app.PageElement(id="e", fixedOrSticky=False, role="dialog", text="interstitial")
		self.assertEqual(
			app.apply_element_priors(loose, 0.2, "marketing", "s1_ad_or_unrelated")[1],
			"s1_ad_or_unrelated",
		)

		push = app.PageElement(id="e", classes=["notification-permission"], text="Allow")
		self.assertEqual(
			app.apply_element_priors(push, 0.15, "marketing", "s1_ad_or_unrelated"),
			(0.9, "s1_plus_push_permission_prior"),
		)
		prose = app.PageElement(id="e", text="This site wants to send you notifications")
		self.assertEqual(
			app.apply_element_priors(prose, 0.1, "marketing", "s1_ad_or_unrelated")[1],
			"s1_plus_push_permission_prior",
		)
		settings = app.PageElement(id="e", text="Manage notifications in settings")
		self.assertEqual(
			app.apply_element_priors(settings, 0.1, "docs_app", "s1_ad_or_unrelated")[1],
			"s1_ad_or_unrelated",
		)

	def test_aria_ad_short_circuit_and_extreme_site_bias(self) -> None:
		self.assertEqual(app.aria_ad_judgment(app.PageElement(id="e", role="Advertisement")), (0.95, "aria_ad"))
		self.assertEqual(app.aria_ad_judgment(app.PageElement(id="e", ariaLabel="ads")), (0.95, "aria_ad"))
		self.assertIsNone(app.aria_ad_judgment(app.PageElement(id="e", role="button", text="Save")))

		biased = app.extreme_test_site_bias(
			"www.canyoublockit.com",
			"https://www.canyoublockit.com/extreme-test/",
			"docs_app",
			{"docs_app": 0.7, "marketing": 0.2, "other": 0.05},
			0.7,
		)
		self.assertEqual(biased, ("marketing", 0.2))
		other = app.extreme_test_site_bias(
			"",
			"https://canyoublockit.com/extreme-test/#push",
			"docs_app",
			{"other": 0.4, "marketing": 0.1},
			0.55,
		)
		self.assertEqual(other[0], "other")
		self.assertIsNone(
			app.extreme_test_site_bias(
				"canyoublockit.com",
				"https://canyoublockit.com/extreme-test/",
				"news",
				{},
				0.4,
			)
		)
		self.assertIsNone(
			app.extreme_test_site_bias(
				"canyoublockit.com",
				"https://canyoublockit.com/about",
				"docs_app",
				{},
				0.4,
			)
		)

	def test_priors_do_not_relabel_a_high_score_or_a_skip(self) -> None:
		host = app.PageElement(id="e", href="https://ad.com/x")
		self.assertEqual(
			app.apply_element_priors(host, 0.97, "marketing", "s1_ad_or_unrelated"),
			(0.97, "s1_ad_or_unrelated"),
		)
		self.assertEqual(
			app.apply_element_priors(host, 0.0, "marketing", "prefix_too_long_skipped"),
			(0.0, "prefix_too_long_skipped"),
		)


if __name__ == "__main__":
	unittest.main()
