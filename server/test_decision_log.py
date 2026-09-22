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
		# Defaults must be under this checkout's server/, not a hardcoded absolute home path.
		self.assertEqual(log_path.parent.parent, Path(app.SERVER_DIR))
		self.assertEqual(app.resolve_path("/tmp/custom.jsonl", log_path), Path("/tmp/custom.jsonl"))
		self.assertEqual(app.resolve_path(None, log_path), log_path)

	def test_element_kinds_and_judgment_kind_field(self) -> None:
		self.assertIn("ad", app.ELEMENT_KINDS)
		self.assertIn("donate_ask", app.ELEMENT_KINDS)
		self.assertIn("nav_chrome", app.ELEMENT_KINDS)
		self.assertIn("tracking_chrome", app.ELEMENT_KINDS)
		row = app.ElementJudgment(
			id="e0", noul=0.9, action="hide", reason="s1_ad_or_unrelated", kind="ad", kindModel="nav_chrome"
		)
		self.assertEqual(row.kind, "ad")
		self.assertEqual(row.kindModel, "nav_chrome")
		plain = app.ElementJudgment(id="e1", noul=0.1, action="allow")
		self.assertEqual(plain.kind, "other")
		self.assertEqual(app.SERVER_VERSION, "0.3.2")

	def test_kind_question_payload_has_clear_option_instructions(self) -> None:
		"""Hermetic: kind choice sent to System One includes improved criteria + instructions."""
		q = app.build_kind_question("e0")
		self.assertEqual(q["type"], "choice")
		self.assertEqual(q["criteria"], app.ELEMENT_KINDS)
		instr = q["instructions"]
		self.assertIn("Advertisement", instr)
		self.assertIn("nav_chrome ONLY", instr)
		self.assertIn("discover", instr)
		self.assertIn("hrefHost", instr)
		self.assertIn("site_type", instr)
		self.assertIn("Do NOT use for Advertisement", app.ELEMENT_KINDS["nav_chrome"])
		self.assertIn("Commercial advertisement", app.ELEMENT_KINDS["ad"])
		self.assertIn("First-party upsell", app.ELEMENT_KINDS["promo"])
		self.assertIn("Tracker, beacon", app.ELEMENT_KINDS["tracking_chrome"])
		self.assertIn("Primary article", app.ELEMENT_KINDS["main_content"])

	def test_element_blob_includes_discover_hosts_and_ad_hints(self) -> None:
		label = app.PageElement(
			id="w1",
			tag="div",
			text="Advertisement",
			discover="ad_label",
			href="https://ad.com/click",
			src="//cdn.bncloudfl.com/bn/creative.gif",
			nearbyLabel="Advertisement",
		)
		blob = app.build_element_blob(label)
		self.assertEqual(blob["discover"], "ad_label")
		self.assertEqual(blob["hrefHost"], "ad.com")
		self.assertEqual(blob["srcHost"], "cdn.bncloudfl.com")
		self.assertEqual(blob["text"], "Advertisement")
		self.assertEqual(blob["nearbyLabel"], "Advertisement")
		self.assertIsNotNone(blob["hint"])
		self.assertIn("ad", (blob["hint"] or "").lower())

		vast = app.PageElement(
			id="v1",
			tag="div",
			discover="vast_player",
			text="",
		)
		vast_blob = app.build_element_blob(vast)
		self.assertEqual(vast_blob["discover"], "vast_player")
		self.assertIn("vast_player", vast_blob["hint"] or "")

	def test_soft_remap_kind_fixes_nav_chrome_collapse_without_hiding(self) -> None:
		"""Model says nav_chrome; ad signals remap kind for ranks — not a force-hide."""
		ad_label = app.PageElement(id="e", tag="div", text="Advertisement", discover="ad_label")
		kind, reason = app.soft_remap_kind(ad_label, "nav_chrome", 0.95)
		self.assertEqual(kind, "ad")
		self.assertEqual(reason, "soft_remap_ad_signals")

		ad_com = app.PageElement(id="e", tag="a", href="https://ad.com/x", discover="ad_host_href", text="Buy")
		kind, reason = app.soft_remap_kind(ad_com, "nav_chrome", 0.92)
		self.assertEqual(kind, "ad")
		self.assertEqual(reason, "soft_remap_ad_signals")

		script = app.PageElement(
			id="e",
			tag="script",
			src="//pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
			discover="ad_host_script",
			text="",
		)
		kind, reason = app.soft_remap_kind(script, "other", 0.7)
		self.assertEqual(kind, "tracking_chrome")
		self.assertEqual(reason, "soft_remap_tracker")

		real_nav = app.PageElement(id="e", tag="nav", text="Home About Contact", discover="")
		kind, reason = app.soft_remap_kind(real_nav, "nav_chrome", 0.1)
		self.assertEqual(kind, "nav_chrome")
		self.assertIsNone(reason)

		# Already-correct model kind is left alone
		kind, reason = app.soft_remap_kind(ad_label, "ad", 0.9)
		self.assertEqual(kind, "ad")
		self.assertIsNone(reason)

	def test_classify_priority_scores_ad_like_first(self) -> None:
		ad = app.PageElement(id="a", text="Advertisement", discover="ad_label")
		nav = app.PageElement(id="n", tag="nav", text="Home", discover="")
		link = app.PageElement(id="l", href="https://ad.com/x", discover="ad_host_href", text="Buy")
		self.assertGreater(app.element_classify_priority(ad), app.element_classify_priority(nav))
		self.assertGreater(app.element_classify_priority(link), app.element_classify_priority(nav))
		ordered = sorted([nav, ad, link], key=app.element_classify_priority, reverse=True)
		self.assertEqual([el.id for el in ordered][0], "a")

	def test_budget_skip_still_remaps_ad_kind(self) -> None:
		"""Honesty: budget/skip path returns remapped kind=ad in the judgment object."""
		el = app.PageElement(id="e", text="Advertisement", discover="ad_label")
		row = app.judgment_without_jev(el, "marketing", 0.75, "s1_budget_skipped")
		self.assertEqual(row.kind, "ad")
		self.assertEqual(row.kindModel, "other")
		self.assertIn("budget", row.reason)
		self.assertIn("soft_remap", row.reason)

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

		aol = app.PageElement(
			id="e",
			tag="iframe",
			src="https://gpt.mail.aol.com/f/gam/gptIframe?sz=300x250",
		)
		noul, reason = app.apply_element_priors(aol, 0.27, "mail", "s1_ad_or_unrelated")
		self.assertEqual((noul, reason), (0.9, "s1_plus_mail_gam_prior"))

		data_ad = app.PageElement(id="e", tag="div", discover="data_ad_row", text="Capital One")
		noul, reason = app.apply_element_priors(data_ad, 0.4, "mail", "s1_ad_or_unrelated")
		self.assertEqual((noul, reason), (0.9, "s1_plus_data_ad_row_prior"))

		copy = app.PageElement(id="e", tag="a", discover="ad_label", text="Advertisement Capital One bonus")
		noul, reason = app.apply_element_priors(copy, 0.65, "mail", "s1_ad_or_unrelated")
		self.assertEqual(reason, "ad_label")

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

	def test_blank_slot_and_ad_label_priors(self) -> None:
		blank = app.PageElement(
			id="e",
			tag="div",
			classes=["elementor-widget", "elementor-widget-html", "elementor-element-8db3f61"],
			discover="blank_html_widget",
			text="",
		)
		self.assertEqual(app.blank_slot_judgment(blank), (0.9, "blank_ad_slot"))
		self.assertEqual(
			app.apply_element_priors(blank, 0.08, "marketing", "s1_ad_or_unrelated"),
			(0.9, "blank_ad_slot"),
		)
		label = app.PageElement(
			id="e",
			tag="div",
			classes=["elementor-widget-html"],
			discover="ad_label",
			text="Advertisement",
		)
		self.assertEqual(app.ad_label_judgment(label), (0.9, "ad_label"))
		hosted = app.PageElement(
			id="e",
			tag="div",
			discover="blank_html_widget",
			src="//ybs2ffs7v.com/lv/esnk/1837835/code.js",
		)
		self.assertIsNone(app.blank_slot_judgment(hosted))
		self.assertEqual(
			app.apply_element_priors(hosted, 0.1, "marketing", "s1_ad_or_unrelated")[1],
			"s1_plus_adhost_prior",
		)

	def test_ingest_log_ignores_duplicate_session_fields(self) -> None:
		result = app.ingest_logs(
			app.LogBatch(
				sessionId="sess-1",
				client="extension-bg-0.2.4",
				entries=[
					{
						"event": "page_judge_fetch",
						"sessionId": "sess-1",
						"client": "extension",
						"clientEvent": "nope",
						"n": 2,
					}
				],
			)
		)
		self.assertEqual(result["ok"], True)
		self.assertGreaterEqual(result["accepted"], 1)

	def test_creative_cdn_is_an_ad_host(self) -> None:
		creative = app.PageElement(
			id="e",
			tag="img",
			src="https://cdn.bncloudfl.com/bn/730/e27/758/creative.gif",
		)
		self.assertTrue(app._matches_ad_host(creative))
		self.assertEqual(
			app.apply_element_priors(creative, 0.1, "marketing", "s1_error_skipped")[1],
			"s1_plus_adhost_prior",
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
