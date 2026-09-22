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
LOG_PATH = Path(
	os.getenv(
		"ADGATE_LOG_PATH",
		"/home/ruin/projects/experiments/adblock-systemone/logs/adgate.jsonl",
	)
)

THRESHOLDS = {
	"careful": 0.85,
	"normal": 0.65,
	"aggressive": 0.45,
}

AD_HOST_RE = re.compile(
	r"(doubleclick|googlesyndication|googletagservices|adservice\.google|"
	r"amazon-adsystem|adnxs|taboola|outbrain|popads|propellerads|adsterra|"
	r"clickadu|exoclick|juicyads|mgid|revcontent|12ezo5v60|ybs2ffs7v|"
	r"fvcwqkkqmuv|pagead2)",
	re.I,
)
AD_HINT_RE = re.compile(
	r"(^|[-_\s])(ad|ads|advert|sponsor|promo|banner|dfp|gpt|adsense|"
	r"interstitial|push|overlay|popup|paywall)([-_\s]|$)",
	re.I,
)

app = FastAPI(title="adgate", version="0.2.0")
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
		"version": "0.2.0",
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
	for entry in batch.entries[:200]:
		log_event(
			"client",
			sessionId=batch.sessionId,
			client=batch.client,
			**{k: v for k, v in entry.items() if k != "event"},
			clientEvent=entry.get("event") or entry.get("msg") or "log",
		)
	return {"ok": True, "accepted": min(len(batch.entries), 200)}


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


class PageJudgeResponse(BaseModel):
	requestId: str
	site_type: str
	site_type_confidence: float
	site_type_probabilities: dict[str, float]
	elements: list[ElementJudgment]
	ms: int
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

	def _el_blob(el: PageElement) -> dict[str, Any]:
		src = el.src or ""
		hint = None
		if "mail-us" in src:
			hint = "AOL/Yahoo /mail-us/ iframe paths are typically right-rail ad units."
		elif src and AD_HOST_RE.search(src):
			hint = "src host matches a known ad/tracking network."
		return {
			"tag": el.tag,
			"id": el.idAttr,
			"classes": el.classes[:8],
			"role": el.role,
			"ariaLabel": ((el.ariaLabel or "")[:80] or None),
			"text": (el.text or "")[:100],
			"href": ((el.href or "")[:160] or None),
			"src": ((el.src or "")[:200] or None),
			"testId": el.testId,
			"rect": el.rect,
			"fixedOrSticky": el.fixedOrSticky,
			"hint": hint,
		}

	def _jev(state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any]:
		r = httpx.post(
			f"{JEV_URL}/v1/systemone",
			json={"state": state, "model": req.model, "questions": questions},
			timeout=180.0,
		)
		if r.status_code >= 400:
			raise RuntimeError(f"jev-local {r.status_code}: {r.text[:500]}")
		return r.json()

	t0 = time.perf_counter()

	site_type = "other"
	site_probs: dict[str, float] = {}
	site_conf = 0.0
	try:
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

	log_event(
		"page_judge_site_type",
		requestId=request_id,
		site_type=site_type,
		site_conf=site_conf,
	)

	judgments: list[ElementJudgment] = []
	hide_min = float(req.hideMin)
	jev_model = None
	skipped = 0

	for el in elements:
		noul = 0.0
		reason = "s1_ad_or_unrelated"
		try:
			payload = _jev(
				{
					"task": (
						"Score whether this DOM element is an ad or unrelated chrome "
						"versus necessary UI/content for the known site type."
					),
					"page": page_short,
					"site_type": site_type,
					"element": _el_blob(el),
				},
				{
					el.id: {
						"type": "noul",
						"instructions": (
							f"This page was classified as site type `{site_type}`. "
							f"Look at state.element. "
							f"Is this element an advertisement, sponsored/promo unit, or otherwise "
							f"unrelated to a `{site_type}` page's primary purpose "
							f"(ad rail, tracking iframe, junk chrome)?"
						),
						"criteria": {
							"true": "Ad, sponsor, promo, tracking iframe, or unrelated chrome",
							"false": f"Primary content or necessary UI for a {site_type} page",
						},
					}
				},
			)
			jev_model = payload.get("model") or jev_model
			ans = (payload.get("answers") or {}).get(el.id) or {}
			noul = float(ans.get("noul", 0.0))
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
			noul = 0.0

		src = el.src or ""
		if reason not in ("prefix_too_long_skipped", "s1_error_skipped"):
			if site_type == "mail" and "mail-us" in src and noul < 0.85:
				noul = max(noul, 0.9)
				reason = "s1_plus_mail_us_prior"
			elif src and AD_HOST_RE.search(src) and noul < 0.85:
				noul = max(noul, 0.9)
				reason = "s1_plus_adhost_prior"

		if noul >= hide_min:
			action: Literal["hide", "review", "allow"] = "hide"
		elif noul >= 0.45:
			action = "review"
		else:
			action = "allow"

		judgments.append(
			ElementJudgment(id=el.id, noul=round(noul, 4), action=action, reason=reason)
		)
		log_event(
			"page_judge_element",
			requestId=request_id,
			elementId=el.id,
			noul=round(noul, 4),
			action=action,
			reason=reason,
			tag=el.tag,
			src=(el.src or "")[:100],
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
	)

	return PageJudgeResponse(
		requestId=request_id,
		site_type=site_type,
		site_type_confidence=site_conf,
		site_type_probabilities=site_probs,
		elements=judgments,
		ms=ms,
		jev_model=jev_model,
		truncated=truncated,
	)
