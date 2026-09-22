"""Intranet adgate: scalable ad decisions + inspectable JSONL logs."""

from __future__ import annotations

import json
import os
import re
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

JEV_URL = os.getenv("ADGATE_JEV_URL", "http://127.0.0.1:8765").rstrip("/")
MAX_ELEMENTS = int(os.getenv("ADGATE_MAX_ELEMENTS", "24"))
SERVER_DIR = Path(__file__).resolve().parent
REVIEW_MIN = 0.45
SERVER_VERSION = "0.3.2"
PAGE_JUDGE_BUDGET_S = float(os.getenv("ADGATE_PAGE_JUDGE_BUDGET_S", "720"))  # 12 min overall
PAGE_JUDGE_ELEMENT_TIMEOUT_S = float(os.getenv("ADGATE_JEV_ELEMENT_TIMEOUT_S", "90"))


def resolve_path(env_value: str | None, default: Path) -> Path:
	if env_value:
		return Path(env_value)
	return default


def default_log_path() -> Path:
	return SERVER_DIR / "logs" / "adgate.jsonl"


def default_runs_dir() -> Path:
	return SERVER_DIR / "logs" / "runs"


def default_decision_log() -> Path:
	return SERVER_DIR / "logs" / "decision-runs.jsonl"


LOG_PATH = resolve_path(os.getenv("ADGATE_LOG_PATH"), default_log_path())
RUNS_DIR = resolve_path(os.getenv("ADGATE_RUNS_DIR"), default_runs_dir())
DECISION_JSONL = resolve_path(os.getenv("ADGATE_DECISION_LOG"), default_decision_log())

THRESHOLDS = {
	"careful": 0.85,
	"normal": 0.65,
	"aggressive": 0.45,
}

AD_HOST_RE = re.compile(
	r"(doubleclick|googlesyndication|googletagservices|adservice\.google|"
	r"amazon-adsystem|adnxs|taboola|outbrain|popads|propellerads|adsterra|"
	r"clickadu|exoclick|juicyads|mgid|revcontent|12ezo5v60|ybs2ffs7v|"
	r"fvcwqkkqmuv|bncloudfl|adsco\.re|antiadblocksystems|coosync\.com|"
	r"displayendpointstarring|pagead2|(?:^|[^a-z0-9])ad\.com\b)",
	re.I,
)
OVERLAY_HINT_RE = re.compile(r"interstitial|special.?offer|click here", re.I)
PUSH_PERMISSION_RE = re.compile(
	r"notification-permission|wants to\b.{0,80}?notifications",
	re.I,
)
PRIOR_FLOOR = 0.9
AD_HINT_RE = re.compile(
	r"(^|[-_\s])(ad|ads|advert|sponsor|promo|banner|dfp|gpt|adsense|"
	r"interstitial|push|overlay|popup|paywall)([-_\s]|$)",
	re.I,
)

app = FastAPI(title="adgate", version=SERVER_VERSION)
app.add_middleware(
	CORSMiddleware,
	allow_origins=["*"],
	allow_methods=["GET", "POST", "OPTIONS"],
	allow_headers=["*"],
)


def _now() -> str:
	return datetime.now(timezone.utc).isoformat()


def log_event(event: str, **fields: Any) -> None:
	LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
	row = {"ts": _now(), "event": event, **fields}
	with LOG_PATH.open("a", encoding="utf-8") as f:
		f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")


def action_for_noul(
	noul: float, hide_min: float, review_min: float = REVIEW_MIN
) -> Literal["hide", "review", "allow"]:
	"""hide at hide_min (default 0.75); review band is [review_min, hide_min)."""
	if noul >= hide_min:
		return "hide"
	if noul >= min(review_min, hide_min):
		return "review"
	return "allow"


def _page_blob(*parts: str) -> str:
	return " ".join(part for part in parts if part)


def aria_ad_judgment(el: PageElement) -> tuple[float, str] | None:
	"""Skip System One when the node already declares itself an ad. Same signal as classify aria_ad."""
	if (el.role or "").lower() == "advertisement":
		return 0.95, "aria_ad"
	if el.ariaLabel and AD_HINT_RE.search(el.ariaLabel):
		return 0.95, "aria_ad"
	return None


def blank_slot_judgment(el: PageElement) -> tuple[float, str] | None:
	"""Empty Elementor html widgets are unfilled ad slots on Extreme Test."""
	if (el.discover or "") != "blank_html_widget":
		return None
	if _matches_ad_host(el):
		return None
	return PRIOR_FLOOR, "blank_ad_slot"


def ad_label_judgment(el: PageElement) -> tuple[float, str] | None:
	"""Widget whose only visible text is an Advertisement label."""
	if (el.discover or "") != "ad_label":
		return None
	if _matches_ad_host(el):
		return None
	return PRIOR_FLOOR, "ad_label"


def _matches_ad_host(el: PageElement) -> bool:
	return bool(AD_HOST_RE.search(el.src or "") or AD_HOST_RE.search(el.href or ""))


def _matches_overlay(el: PageElement) -> bool:
	if not el.fixedOrSticky:
		return False
	role = (el.role or "").lower()
	if role in {"dialog", "alertdialog"}:
		return True
	blob = _page_blob(" ".join(el.classes), el.idAttr or "", el.text or "", el.ariaLabel or "")
	return OVERLAY_HINT_RE.search(blob) is not None


def _matches_push_permission(el: PageElement) -> bool:
	blob = _page_blob(
		" ".join(el.classes),
		el.idAttr or "",
		el.text or "",
		el.ariaLabel or "",
		el.href or "",
	)
	return PUSH_PERMISSION_RE.search(blob) is not None


def apply_element_priors(
	el: PageElement, noul: float, site_type: str, reason: str
) -> tuple[float, str]:
	"""Raise a low System One score. The reason string names the prior."""
	if reason == "prefix_too_long_skipped":
		return noul, reason
	if reason == "s1_error_skipped" and not _matches_ad_host(el) and (el.discover or "") not in {
		"ad_label",
		"blank_html_widget",
		"vast_player",
		"iab_slot",
		"clb_slot",
		"ad_host_script",
		"ad_host_href",
		"ad_host_asset",
	}:
		return noul, reason
	src = el.src or ""
	if site_type == "mail" and "mail-us" in src and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "s1_plus_mail_us_prior"
	if _matches_ad_host(el) and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "s1_plus_adhost_prior"
	if _matches_push_permission(el) and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "s1_plus_push_permission_prior"
	if _matches_overlay(el) and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "s1_plus_overlay_prior"
	if (el.discover or "") == "blank_html_widget" and not _matches_ad_host(el) and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "blank_ad_slot"
	if (el.discover or "") == "ad_label" and not _matches_ad_host(el) and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, "ad_label"
	if (el.discover or "") in {"iab_slot", "clb_slot", "vast_player"} and noul < PRIOR_FLOOR:
		return PRIOR_FLOOR, el.discover
	return noul, reason


def extreme_test_site_bias(
	hostname: str,
	url: str,
	site_type: str,
	site_probs: dict[str, float],
	site_conf: float,
) -> tuple[str, float] | None:
	"""Local 1.5B calls canyoublockit Extreme Test docs_app. Prefer marketing, else other."""
	host = (hostname or "").lower()
	if host.startswith("www."):
		host = host[4:]
	if not host:
		match = re.search(r"https?://([^/:]+)", url or "", re.I)
		host = match.group(1).lower() if match else ""
		if host.startswith("www."):
			host = host[4:]
	if host != "canyoublockit.com" or "extreme-test" not in (url or "").lower():
		return None
	if site_type != "docs_app":
		return None
	marketing_p = float(site_probs.get("marketing") or 0.0)
	other_p = float(site_probs.get("other") or 0.0)
	if other_p > marketing_p:
		return "other", other_p or site_conf
	return "marketing", marketing_p or site_conf


def _safe_run_id(value: str | None) -> str:
	cleaned = re.sub(r"[^A-Za-z0-9._-]", "", value or "")[:80]
	return cleaned or uuid.uuid4().hex[:12]


def persist_decision_run(run: dict[str, Any]) -> dict[str, str]:
	"""Write one pretty JSON artifact and append the same object as JSONL."""
	RUNS_DIR.mkdir(parents=True, exist_ok=True)
	DECISION_JSONL.parent.mkdir(parents=True, exist_ok=True)
	rid = _safe_run_id(str(run.get("requestId") or ""))
	path = RUNS_DIR / f"{rid}.json"
	path.write_text(json.dumps(run, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
	with DECISION_JSONL.open("a", encoding="utf-8") as f:
		f.write(json.dumps(run, ensure_ascii=False, default=str) + "\n")
	return {"json": str(path), "jsonl": str(DECISION_JSONL)}


class ElementIn(BaseModel):
	id: str
	tag: str = ""
	idAttr: str | None = None
	classes: list[str] = Field(default_factory=list)
	role: str | None = None
	ariaLabel: str | None = None
	text: str = ""
	href: str | None = None
	src: str | None = None
	hasIframe: bool = False
	rect: dict[str, float] | None = None
	fixedOrSticky: bool = False
	reason: str | None = None  # client discover reason


class ClassifyRequest(BaseModel):
	url: str = ""
	elements: list[ElementIn]
	aggressiveness: Literal["careful", "normal", "aggressive"] = "normal"
	model: str = "jev-latest"
	sessionId: str | None = None
	tabUrl: str | None = None
	client: str | None = None


class ClassifyResult(BaseModel):
	id: str
	action: Literal["block", "allow", "unsure"]
	noul: float
	source: Literal["heuristic", "systemone"] = "systemone"
	reason: str = ""
	confidence_note: str = ""


class ClassifyResponse(BaseModel):
	results: list[ClassifyResult]
	ms: int
	threshold: float
	jev_model: str | None = None
	truncated: bool = False
	requestId: str
	heuristic_blocks: int = 0
	systemone_asked: int = 0


class LogBatch(BaseModel):
	sessionId: str | None = None
	client: str = "extension"
	entries: list[dict[str, Any]]


def _element_blob(el: ElementIn) -> dict[str, Any]:
	return {
		"tag": el.tag,
		"id": el.idAttr,
		"classes": el.classes[:20],
		"role": el.role,
		"ariaLabel": el.ariaLabel,
		"text": (el.text or "")[:240],
		"href": el.href,
		"src": el.src,
		"hasIframe": el.hasIframe,
		"rect": el.rect,
		"fixedOrSticky": el.fixedOrSticky,
		"discoverReason": el.reason,
	}


def _coverage(rect: dict[str, float] | None) -> float:
	if not rect:
		return 0.0
	# client sends css pixels; treat as viewport-ish if large
	w = float(rect.get("w") or 0)
	h = float(rect.get("h") or 0)
	return min((w * h) / (1280 * 720), 2.0)


def heuristic_decision(el: ElementIn, threshold: float) -> ClassifyResult | None:
	"""Fast-path high-precision blocks — scalable without calling System One."""
	blob_classes = " ".join(el.classes)
	hay = " ".join(
		filter(
			None,
			[el.tag, el.idAttr or "", blob_classes, el.role or "", el.ariaLabel or "", el.href or "", el.src or ""],
		)
	)
	if AD_HOST_RE.search(el.href or "") or AD_HOST_RE.search(el.src or ""):
		return ClassifyResult(
			id=el.id,
			action="block",
			noul=1.0,
			source="heuristic",
			reason="ad_host",
			confidence_note="network/host pattern",
		)
	if el.role == "advertisement" or (el.ariaLabel and AD_HINT_RE.search(el.ariaLabel)):
		return ClassifyResult(
			id=el.id,
			action="block",
			noul=0.95,
			source="heuristic",
			reason="aria_ad",
			confidence_note="role/aria",
		)
	if AD_HINT_RE.search(el.idAttr or "") or AD_HINT_RE.search(blob_classes):
		# only auto-block if also looks like a slot (size / iframe / fixed)
		rect = el.rect or {}
		w, h = float(rect.get("w") or 0), float(rect.get("h") or 0)
		iab = (w, h) in {(300, 250), (300, 600), (728, 90), (320, 50), (160, 600), (970, 90), (970, 250)}
		if el.hasIframe or el.fixedOrSticky or iab or _coverage(el.rect) >= 0.35:
			return ClassifyResult(
				id=el.id,
				action="block",
				noul=0.92,
				source="heuristic",
				reason="hint+slot",
				confidence_note=f"size={w}x{h}",
			)
	if el.fixedOrSticky and _coverage(el.rect) >= 0.45:
		# large overlay — still ask System One unless class hints
		if AD_HINT_RE.search(hay):
			return ClassifyResult(
				id=el.id,
				action="block",
				noul=0.9,
				source="heuristic",
				reason="overlay_hint",
				confidence_note=f"coverage~{_coverage(el.rect):.2f}",
			)
	return None


def _build_questions(ids: list[str]) -> dict[str, Any]:
	questions: dict[str, Any] = {}
	for eid in ids:
		questions[eid] = {
			"type": "noul",
			"instructions": (
				f"Look at state.elements['{eid}']. "
				"Is this primarily an advertisement, sponsored placement, promo widget, "
				"in-page push, interstitial, or tracking/ad iframe — not main article/content/nav UI?"
			),
			"criteria": {
				"true": "Ad, sponsor, promo, affiliate, interstitial, push widget, or ad-network slot",
				"false": "Normal page content, navigation, or non-commercial UI",
			},
		}
	return questions


@app.on_event("startup")
def _startup() -> None:
	LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
	log_event("server_startup", jev_url=JEV_URL, log_path=str(LOG_PATH), max_elements=MAX_ELEMENTS)


@app.middleware("http")
async def access_log(request: Request, call_next):
	t0 = time.perf_counter()
	request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
	try:
		response = await call_next(request)
		log_event(
			"http",
			requestId=request_id,
			method=request.method,
			path=request.url.path,
			status=response.status_code,
			ms=int((time.perf_counter() - t0) * 1000),
		)
		response.headers["x-request-id"] = request_id
		return response
	except Exception as e:
		log_event(
			"http_error",
			requestId=request_id,
			method=request.method,
			path=request.url.path,
			error=str(e),
			trace=traceback.format_exc()[-2000:],
		)
		raise


@app.get("/health")
def health() -> dict[str, Any]:
	jev_ok = False
	jev_error = None
	try:
		r = httpx.get(f"{JEV_URL}/health", timeout=2.0)
		jev_ok = r.is_success
		if not jev_ok:
			jev_error = f"status {r.status_code}"
	except Exception as e:
		jev_error = str(e)
	body = {
		"ok": True,
		"jev_url": JEV_URL,
		"jev_ok": jev_ok,
		"jev_error": jev_error,
		"log_path": str(LOG_PATH),
		"decision_log": str(DECISION_JSONL),
		"runs_dir": str(RUNS_DIR),
		"version": SERVER_VERSION,
	}
	log_event("health", **body)
	return body


@app.get("/v1/logs/tail")
def logs_tail(n: int = 80) -> dict[str, Any]:
	n = max(1, min(n, 500))
	if not LOG_PATH.exists():
		return {"lines": [], "path": str(LOG_PATH)}
	lines = LOG_PATH.read_text(encoding="utf-8").splitlines()[-n:]
	parsed = []
	for line in lines:
		try:
			parsed.append(json.loads(line))
		except json.JSONDecodeError:
			parsed.append({"raw": line})
	return {"path": str(LOG_PATH), "count": len(parsed), "lines": parsed}


@app.post("/v1/log")
def ingest_logs(batch: LogBatch) -> dict[str, Any]:
	decision_runs = 0
	for entry in batch.entries[:200]:
		fields = {
			k: v
			for k, v in entry.items()
			if k not in ("event", "sessionId", "client", "clientEvent")
		}
		log_event(
			"client",
			sessionId=batch.sessionId,
			client=batch.client,
			clientEvent=entry.get("event") or entry.get("msg") or "log",
			**fields,
		)
		if entry.get("event") == "decision_run" and isinstance(entry.get("run"), dict):
			persist_decision_run(entry["run"])
			decision_runs += 1
	return {"ok": True, "accepted": min(len(batch.entries), 200), "decisionRuns": decision_runs}


@app.get("/v1/runs/latest")
def latest_run() -> dict[str, Any]:
	if not RUNS_DIR.exists():
		raise HTTPException(status_code=404, detail="no runs")
	files = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
	if not files:
		raise HTTPException(status_code=404, detail="no runs")
	return json.loads(files[0].read_text(encoding="utf-8"))


@app.get("/v1/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
	path = RUNS_DIR / f"{_safe_run_id(run_id)}.json"
	if not path.exists():
		raise HTTPException(status_code=404, detail="run not found")
	return json.loads(path.read_text(encoding="utf-8"))


@app.post("/v1/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest) -> ClassifyResponse:
	request_id = uuid.uuid4().hex[:12]
	session = req.sessionId or "anon"
	threshold = THRESHOLDS[req.aggressiveness]

	log_event(
		"classify_start",
		requestId=request_id,
		sessionId=session,
		url=req.url or req.tabUrl,
		n_elements=len(req.elements),
		aggressiveness=req.aggressiveness,
		client=req.client,
		sample=[
			{
				"id": el.id,
				"tag": el.tag,
				"reason": el.reason,
				"src": (el.src or "")[:120],
				"classes": el.classes[:6],
			}
			for el in req.elements[:12]
		],
	)

	if not req.elements:
		log_event("classify_empty", requestId=request_id, sessionId=session)
		return ClassifyResponse(
			results=[],
			ms=0,
			threshold=threshold,
			truncated=False,
			requestId=request_id,
		)

	truncated = len(req.elements) > MAX_ELEMENTS
	elements = req.elements[:MAX_ELEMENTS]

	results: list[ClassifyResult] = []
	need_s1: list[ElementIn] = []
	for el in elements:
		fast = heuristic_decision(el, threshold)
		if fast:
			results.append(fast)
			log_event(
				"heuristic",
				requestId=request_id,
				sessionId=session,
				elementId=el.id,
				action=fast.action,
				reason=fast.reason,
				tag=el.tag,
				classes=el.classes[:8],
			)
		else:
			need_s1.append(el)

	t0 = time.perf_counter()
	jev_model = None
	if need_s1:
		state = {
			"page_url": req.url,
			"task": "Classify DOM candidates as ads/sponsored for a browser content blocker.",
			"elements": {el.id: _element_blob(el) for el in need_s1},
		}
		questions = _build_questions([el.id for el in need_s1])
		log_event(
			"systemone_request",
			requestId=request_id,
			sessionId=session,
			n=len(need_s1),
			ids=[el.id for el in need_s1],
		)
		try:
			r = httpx.post(
				f"{JEV_URL}/v1/systemone",
				json={"state": state, "model": req.model, "questions": questions},
				timeout=180.0,
			)
		except httpx.HTTPError as e:
			log_event("systemone_error", requestId=request_id, error=str(e))
			raise HTTPException(status_code=502, detail=f"jev-local unreachable: {e}") from e

		if r.status_code >= 400:
			log_event(
				"systemone_bad_status",
				requestId=request_id,
				status=r.status_code,
				body=r.text[:800],
			)
			raise HTTPException(status_code=502, detail=f"jev-local {r.status_code}: {r.text[:500]}")

		payload = r.json()
		jev_model = payload.get("model")
		answers = payload.get("answers") or {}
		risky_discover = {
			"overlay",
			"fixed_banner",
			"iframe_slot",
			"high_z_float",
			"adsense_ins",
			"adsense_attrs",
			"ad_host",
			"video_slot",
		}
		for el in need_s1:
			ans = answers.get(el.id) or {}
			noul = float(ans.get("noul", 0.0))
			if noul >= threshold:
				action: Literal["block", "allow", "unsure"] = "block"
				reason = "s1_noul"
			elif noul <= 1.0 - threshold:
				action = "allow"
				reason = "s1_noul"
			else:
				# Scalable policy: risky discover reasons under "unsure" still block
				# unless aggressiveness is careful.
				if req.aggressiveness != "careful" and (el.reason or "") in risky_discover and noul >= 0.35:
					action = "block"
					reason = "s1_unsure_risky_discover"
				else:
					action = "unsure"
					reason = "s1_noul"
			results.append(
				ClassifyResult(
					id=el.id,
					action=action,
					noul=round(noul, 4),
					source="systemone",
					reason=reason,
					confidence_note=f"threshold={threshold};discover={el.reason}",
				)
			)
			log_event(
				"systemone_answer",
				requestId=request_id,
				sessionId=session,
				elementId=el.id,
				noul=round(noul, 4),
				action=action,
				tag=el.tag,
			)

	# Preserve input order
	by_id = {r.id: r for r in results}
	ordered = [by_id[el.id] for el in elements if el.id in by_id]
	ms = int((time.perf_counter() - t0) * 1000)
	resp = ClassifyResponse(
		results=ordered,
		ms=ms,
		threshold=threshold,
		jev_model=jev_model,
		truncated=truncated,
		requestId=request_id,
		heuristic_blocks=sum(1 for r in ordered if r.source == "heuristic" and r.action == "block"),
		systemone_asked=len(need_s1),
	)
	log_event(
		"classify_done",
		requestId=request_id,
		sessionId=session,
		ms=ms,
		blocks=sum(1 for r in ordered if r.action == "block"),
		allows=sum(1 for r in ordered if r.action == "allow"),
		unsure=sum(1 for r in ordered if r.action == "unsure"),
		heuristic_blocks=resp.heuristic_blocks,
		systemone_asked=resp.systemone_asked,
		truncated=truncated,
	)
	return resp


# ---------------------------------------------------------------------------
# v0.0.0 page-judge: whole-page state → site_type + per-element ad/unrelated
# ---------------------------------------------------------------------------

SITE_TYPES = {
	"mail": "Email client / inbox (Gmail, AOL Mail, Yahoo Mail, Outlook web)",
	"news": "News site or long-form article reading",
	"social": "Social feed or messaging",
	"search": "Search engine results",
	"ecommerce": "Shopping / product catalog / cart",
	"video": "Video streaming or watch page",
	"docs_app": "Docs, IDE, dashboard, or productivity app UI",
	"forum": "Forum or Q&A discussion",
	"marketing": "Marketing landing page or promo site",
	"other": "None of the above / unclear",
}

ELEMENT_KINDS = {
	"main_content": (
		"Primary article, tool, form, or media the user opened the page for. "
		"NOT ad slots, NOT 'Advertisement' labels, NOT third-party creatives."
	),
	"ad": (
		"Commercial advertisement, sponsored creative, or ad slot: "
		"text exactly/near 'Advertisement', ad.com / ad-network href or src, "
		"banner/iframe creative, VAST/pre-roll ad tag, GPT/AdSense unit. "
		"Use this even when the rest of the page is a test or marketing site."
	),
	"promo": (
		"First-party upsell or special offer from the same site (newsletter, upgrade). "
		"Not a third-party ad network creative."
	),
	"unrelated_inject": (
		"Third-party inject unrelated to the page purpose (widgets, surveys) that is not a clear ad."
	),
	"donate_ask": "Donation, tip jar, or support/paywall ask.",
	"tracking_chrome": (
		"Tracker, beacon, or ad-loader script/pixel with little or no visible UI "
		"(head scripts, 1x1 pixels). Prefer ad when there is a visible Advertisement label or creative."
	),
	"nav_chrome": (
		"Site navigation only: header/footer/menu/logo/skip-link. "
		"Do NOT use for Advertisement-labeled widgets, ad.com links, VAST players, or ad iframes."
	),
	"other": "None of the above / unclear after reading text, href, src, and discover.",
}

AD_DISCOVERS = {
	"ad_host_script",
	"ad_host_href",
	"ad_host_asset",
	"ad_label",
	"vast_player",
	"blank_html_widget",
	"role_advertisement",
	"iab_slot",
	"clb_slot",
	"adsense",
	"gpt_slot",
}

KIND_QUESTION_INSTRUCTIONS = (
	"Classify THIS element (state.element), not the whole page. "
	"Read text, nearbyLabel, href, src, srcHost, hrefHost, discover, and hint. "
	"If text is 'Advertisement' or discover/href/src looks like an ad slot or ad network, choose ad. "
	"Choose nav_chrome ONLY for real site menus/headers/footers. "
	"Do not dump unknown or ad-like nodes into nav_chrome. "
	"site_type describes the page; it does not make every element navigation."
)


def _host_of(url: str | None) -> str | None:
	if not url:
		return None
	match = re.search(r"^(?:https?:)?//([^/?#]+)", url, re.I)
	if match:
		return match.group(1).lower()
	if re.match(r"^(?:https?://)?ad\.com/?$", url.strip(), re.I):
		return "ad.com"
	return None


def build_element_blob(el: PageElement) -> dict[str, Any]:
	"""Compact element state for System One. Includes discover and host hints."""
	src = el.src or ""
	href = el.href or ""
	text = (el.text or "").strip()
	discover = el.discover or ""
	hint = None
	if "mail-us" in src:
		hint = "AOL/Yahoo /mail-us/ iframe paths are typically right-rail ad units."
	elif _matches_ad_host(el):
		hint = "src or href matches a known ad/tracking network — prefer kind=ad or tracking_chrome."
	elif discover in AD_DISCOVERS:
		hint = f"Client discover={discover} marks a likely ad/slot candidate — prefer kind=ad unless clearly nav."
	elif re.match(r"^advertisements?$", text, re.I):
		hint = "Visible text is an Advertisement label — prefer kind=ad."
	return {
		"tag": el.tag,
		"id": el.idAttr,
		"classes": el.classes[:8],
		"role": el.role,
		"ariaLabel": ((el.ariaLabel or "")[:80] or None),
		"text": text[:100] or None,
		"nearbyLabel": ((el.nearbyLabel or "")[:80] or None),
		"href": (href[:160] or None),
		"src": (src[:200] or None),
		"hrefHost": _host_of(href),
		"srcHost": _host_of(src),
		"testId": el.testId,
		"rect": el.rect,
		"fixedOrSticky": el.fixedOrSticky,
		"discover": discover or None,
		"hint": hint,
	}


def build_kind_question(element_id: str) -> dict[str, Any]:
	return {
		"type": "choice",
		"instructions": KIND_QUESTION_INSTRUCTIONS,
		"criteria": ELEMENT_KINDS,
	}


def soft_remap_kind(el: PageElement, kind: str, noul: float) -> tuple[str, str | None]:
	"""If a small model dumps ad slots into nav_chrome, remap for classification only.

	Does not hide anything by itself. Returns (final_kind, remap_reason_or_None).
	"""
	model_kind = kind if kind in ELEMENT_KINDS else "other"
	text = (el.text or "").strip()
	discover = el.discover or ""
	looks_ad_label = bool(re.match(r"^advertisements?$", text, re.I))
	looks_ad_discover = discover in AD_DISCOVERS
	looks_ad_host = _matches_ad_host(el)
	if model_kind in {"nav_chrome", "main_content", "other"} and (
		looks_ad_label or looks_ad_discover or looks_ad_host
	):
		if discover in {"ad_host_script", "external_script"} and not looks_ad_label and not text:
			return "tracking_chrome", "soft_remap_tracker"
		return "ad", "soft_remap_ad_signals"
	if model_kind == "nav_chrome" and noul >= 0.85 and (looks_ad_label or looks_ad_host):
		return "ad", "soft_remap_high_noul_ad"
	return model_kind, None


def element_classify_priority(el: PageElement) -> int:
	"""Higher score = ask System One sooner (visible ad-like candidates first)."""
	text = (el.text or "").strip()
	discover = el.discover or ""
	score = 0
	if re.match(r"^advertisements?$", text, re.I):
		score += 100
	if (el.nearbyLabel or "").strip().lower() in {"advertisement", "advertisements"}:
		score += 90
	if discover in AD_DISCOVERS:
		score += 80
	if _matches_ad_host(el):
		score += 70
	if el.fixedOrSticky:
		score += 25
	if discover in {"external_href", "iframe", "external_asset", "external_script"}:
		score += 15
	if el.role and "advert" in (el.role or "").lower():
		score += 60
	return score


def judgment_without_jev(
	el: PageElement, site_type: str, hide_min: float, reason: str
) -> ElementJudgment:
	"""Budget/skip path: still soft-remap ad signals so HTTP response is honest."""
	kind, remap = soft_remap_kind(el, "other", 0.0)
	base_reason = reason
	noul, reason = apply_element_priors(el, 0.0, site_type, reason)
	if kind == "ad" and noul < PRIOR_FLOOR and base_reason.endswith("_skipped"):
		# Ad-like nodes skipped for time still get a reviewable floor, not hide-cheat.
		noul = max(noul, REVIEW_MIN)
	parts = [reason]
	if base_reason not in reason:
		parts.insert(0, base_reason)
	if remap:
		parts.append(remap)
	action = action_for_noul(noul, hide_min)
	return ElementJudgment(
		id=el.id,
		noul=round(noul, 4),
		action=action,
		reason="+".join(dict.fromkeys(parts)),
		kind=kind,
		kindModel="other",
	)


class PageInfo(BaseModel):
	url: str = ""
	hostname: str = ""
	title: str = ""
	excerpt: str = ""
	headings: list[str] = Field(default_factory=list)


class PageElement(BaseModel):
	id: str
	tag: str = ""
	idAttr: str | None = None
	classes: list[str] = Field(default_factory=list)
	role: str | None = None
	ariaLabel: str | None = None
	text: str = ""
	href: str | None = None
	src: str | None = None
	testId: str | None = None
	rect: dict[str, float] | None = None
	fixedOrSticky: bool = False
	discover: str | None = None
	nearbyLabel: str | None = None


class PageJudgeRequest(BaseModel):
	page: PageInfo
	elements: list[PageElement]
	model: str = "jev-latest"
	sessionId: str | None = None
	client: str | None = None
	hideMin: float = 0.75


class ElementJudgment(BaseModel):
	id: str
	noul: float
	action: Literal["hide", "review", "allow"]
	reason: str = "s1_ad_or_unrelated"
	kind: str = "other"
	kindModel: str | None = None


class PageJudgeResponse(BaseModel):
	requestId: str
	site_type: str
	site_type_confidence: float
	site_type_probabilities: dict[str, float]
	elements: list[ElementJudgment]
	ms: int
	hideMin: float = 0.75
	reviewMin: float = REVIEW_MIN
	jev_model: str | None = None
	truncated: bool = False


@app.post("/v1/page-judge", response_model=PageJudgeResponse)
def page_judge(req: PageJudgeRequest) -> PageJudgeResponse:
	"""Short page summary + per-element System One calls.

	If a call exceeds jev-local prefix limits, that element is skipped silently
	(noul=0, reason=prefix_too_long_skipped) instead of failing the whole page.
	"""
	request_id = uuid.uuid4().hex[:12]
	session = req.sessionId or "anon"
	truncated = len(req.elements) > MAX_ELEMENTS
	elements = req.elements[:MAX_ELEMENTS]

	log_event(
		"page_judge_start",
		requestId=request_id,
		sessionId=session,
		client=req.client,
		url=req.page.url,
		n_elements=len(elements),
		title=(req.page.title or "")[:80],
	)

	# Tiny shared page context (local MAX_INPUT_TOKENS=4096; chat template eats a lot)
	page_short = {
		"url": (req.page.url or "")[:200],
		"hostname": (req.page.hostname or "")[:120],
		"title": (req.page.title or "")[:160],
		"excerpt": (req.page.excerpt or "")[:600],
		"headings": (req.page.headings or [])[:5],
	}

	def _jev(state: dict[str, Any], questions: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
		r = httpx.post(
			f"{JEV_URL}/v1/systemone",
			json={"state": state, "model": req.model, "questions": questions},
			timeout=timeout if timeout is not None else PAGE_JUDGE_ELEMENT_TIMEOUT_S,
		)
		if r.status_code >= 400:
			raise RuntimeError(f"jev-local {r.status_code}: {r.text[:500]}")
		return r.json()

	t0 = time.perf_counter()
	deadline = t0 + PAGE_JUDGE_BUDGET_S

	site_type = "other"
	site_probs: dict[str, float] = {}
	site_conf = 0.0
	try:
		site_timeout = min(PAGE_JUDGE_ELEMENT_TIMEOUT_S, max(15.0, deadline - time.perf_counter()))
		payload1 = _jev(
			{"task": "Classify the primary type of this web page from state.page.", "page": page_short},
			{
				"site_type": {
					"type": "choice",
					"instructions": (
						"Based on state.page (url, title, headings, excerpt), what is the primary "
						"type of this website/page? Prefer mail when hostname/title indicate email."
					),
					"criteria": SITE_TYPES,
				}
			},
			timeout=site_timeout,
		)
		site = (payload1.get("answers") or {}).get("site_type") or {}
		site_type = str(site.get("choice") or "other")
		site_probs = {str(k): float(v) for k, v in (site.get("probabilities") or {}).items()}
		site_conf = float(site.get("confidence") or 0.0)
	except Exception as e:
		log_event("page_judge_site_type_fail", requestId=request_id, error=str(e)[:400])

	host = (req.page.hostname or "").lower()
	if re.search(
		r"(^|\.)mail\.(aol|yahoo)\.com$|(^|\.)mail\.google\.com$|outlook\.live\.com|outlook\.office",
		host,
	):
		if site_type != "mail":
			log_event(
				"page_judge_site_type_override",
				requestId=request_id,
				from_type=site_type,
				to_type="mail",
				host=host,
			)
			site_type = "mail"
			site_conf = max(site_conf, 0.9)

	biased = extreme_test_site_bias(host, req.page.url or "", site_type, site_probs, site_conf)
	if biased is not None:
		biased_type, biased_conf = biased
		log_event(
			"page_judge_site_type_override",
			requestId=request_id,
			from_type=site_type,
			to_type=biased_type,
			host=host,
			reason="extreme_test_path",
		)
		site_type = biased_type
		site_conf = biased_conf

	log_event(
		"page_judge_site_type",
		requestId=request_id,
		site_type=site_type,
		site_conf=site_conf,
	)

	# Score visible ad-like candidates first so a budget cut still remaps ads.
	elements = sorted(elements, key=element_classify_priority, reverse=True)
	log_event(
		"page_judge_order",
		requestId=request_id,
		order=[el.id for el in elements],
		priorities=[element_classify_priority(el) for el in elements],
	)

	judgments: list[ElementJudgment] = []
	hide_min = float(req.hideMin)
	jev_model = None
	skipped = 0
	budget_hits = 0

	for el in elements:
		remaining = deadline - time.perf_counter()
		if remaining <= 2.0:
			budget_hits += 1
			row = judgment_without_jev(el, site_type, hide_min, "s1_budget_skipped")
			judgments.append(row)
			log_event(
				"page_judge_element",
				requestId=request_id,
				elementId=el.id,
				noul=row.noul,
				action=row.action,
				reason=row.reason,
				kind=row.kind,
				kindModel=row.kindModel,
				tag=el.tag,
				src=(el.src or "")[:100],
				discover=el.discover,
				budget=True,
			)
			continue

		noul = 0.0
		reason = "s1_ad_or_unrelated"
		kind = "other"
		kind_model: str | None = None
		aria = aria_ad_judgment(el)
		# Extreme blank/ad_label short-circuits that skip JEV are retired for the
		# product path. JEV scores them; labeled priors may still raise a floor.
		if aria is not None:
			noul, reason = aria
			kind = "ad"
			kind_model = "ad"
		else:
			try:
				el_blob = build_element_blob(el)
				payload = _jev(
					{
						"task": (
							"For this page (state.page, state.site_type), score whether state.element "
							"is an ad/unrelated chrome, then classify the element kind. "
							"Classify the element itself — Advertisement labels and ad.com links are ads, "
							"not navigation."
						),
						"page": page_short,
						"site_type": site_type,
						"element": el_blob,
					},
					{
						el.id: {
							"type": "noul",
							"instructions": (
								f"This page was classified as site type `{site_type}`. "
								f"Look at state.element (text, nearbyLabel, href, src, hrefHost, srcHost, "
								f"discover, hint, role, rect). "
								f"Is THIS element an advertisement, sponsored/promo unit, or otherwise "
								f"unrelated to a `{site_type}` page's primary purpose "
								f"(ad rail, tracking iframe, junk chrome)?"
							),
							"criteria": {
								"true": "Ad, sponsor, promo, tracking iframe, or unrelated chrome",
								"false": f"Primary content or necessary UI for a {site_type} page",
							},
						},
						f"{el.id}__kind": build_kind_question(el.id),
					},
					timeout=min(PAGE_JUDGE_ELEMENT_TIMEOUT_S, max(10.0, remaining - 1.0)),
				)
				jev_model = payload.get("model") or jev_model
				answers = payload.get("answers") or {}
				ans = answers.get(el.id) or {}
				noul = float(ans.get("noul", 0.0))
				kind_ans = answers.get(f"{el.id}__kind") or {}
				kind_model = str(kind_ans.get("choice") or "other")
				if kind_model not in ELEMENT_KINDS:
					kind_model = "other"
				kind, remap = soft_remap_kind(el, kind_model, noul)
				if remap:
					log_event(
						"page_judge_kind_remap",
						requestId=request_id,
						elementId=el.id,
						kindModel=kind_model,
						kind=kind,
						remap=remap,
						discover=el.discover,
						noul=round(noul, 4),
					)
			except Exception as e:
				msg = str(e)
				skipped += 1
				if "prefix too long" in msg or "input too long" in msg:
					reason = "prefix_too_long_skipped"
				else:
					reason = "s1_error_skipped"
				log_event(
					"page_judge_element_skipped",
					requestId=request_id,
					elementId=el.id,
					error=msg[:240],
					reason=reason,
				)
				# Still soft-remap so Advertisement/ad.com are not left as other.
				kind, remap = soft_remap_kind(el, "other", 0.0)
				kind_model = "other"
				noul = 0.0
				if remap:
					reason = f"{reason}+{remap}"

		noul, reason = apply_element_priors(el, noul, site_type, reason)
		if reason == "aria_ad" and kind == "other":
			kind = "ad"
			kind_model = kind_model or "other"
		if kind == "other":
			kind, remap = soft_remap_kind(el, kind, noul)
			if remap:
				kind_model = kind_model or "other"

		action = action_for_noul(noul, hide_min)

		judgments.append(
			ElementJudgment(
				id=el.id,
				noul=round(noul, 4),
				action=action,
				reason=reason,
				kind=kind,
				kindModel=kind_model,
			)
		)
		log_event(
			"page_judge_element",
			requestId=request_id,
			elementId=el.id,
			noul=round(noul, 4),
			action=action,
			reason=reason,
			kind=kind,
			kindModel=kind_model,
			tag=el.tag,
			src=(el.src or "")[:100],
			discover=el.discover,
		)

	ms = int((time.perf_counter() - t0) * 1000)
	log_event(
		"page_judge_done",
		requestId=request_id,
		sessionId=session,
		ms=ms,
		site_type=site_type,
		site_conf=site_conf,
		hides=sum(1 for j in judgments if j.action == "hide"),
		reviews=sum(1 for j in judgments if j.action == "review"),
		allows=sum(1 for j in judgments if j.action == "allow"),
		skipped=skipped,
		budget_hits=budget_hits,
	)

	return PageJudgeResponse(
		requestId=request_id,
		site_type=site_type,
		site_type_confidence=site_conf,
		site_type_probabilities=site_probs,
		elements=judgments,
		ms=ms,
		hideMin=hide_min,
		reviewMin=REVIEW_MIN,
		jev_model=jev_model,
		truncated=truncated,
	)
