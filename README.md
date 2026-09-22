# JevBlock (Adgate)

Chrome extension + intranet service that uses a **System One / Jev-compatible** judge to score page elements as ads (or unrelated chrome) given whole-page context.

Extension version is `extension/manifest.json` (**0.1.8**). Server version is **0.3.2**. Page-judge timeout is 15 minutes with background single-flight; the flight helper stays inside a factory so the service worker can `importScripts` it without a duplicate global binding. Force-hide cheats stay off. Block OFF = classify-only decision log. After a rank hide, empty ad rails collapse and one neighborhood re-classify pass judges still-visible siblings in that wrapper with the same ranks.

**Service URL** defaults to Dagote hosted Adgate/JEV: `https://www.dagote.ai/api/jev`. Set an API key in the popup (`x-api-key`). The default scorer is **jev-tiny** (0.5B) on Dagote. You can still pick `jev-latest` or `jev-3b` from `GET /models`. The extension always sends that `model` id on `POST /v1/page-judge` and does not rely on the server default alone. A stored model is left as-is; only a missing model is filled with `jev-tiny`. A Dagote `429` / busy reply (“Already generating a reply”) is retried using `retryAfter`. A local open-weight jev-local is **not** the same quality as hosted TypeSafe Jev. LAN fallback (not the default): Adgate `http://192.168.0.119:8770`, jev-local `http://192.168.0.119:8765`.

## How it works

1. Extension extracts a short page summary + candidate DOM elements (iframes, fixed overlays, external href/src, large slots)
2. Service worker POSTs to the configured service `POST /v1/page-judge` (Dagote hosted by default) with an explicit `model` and `x-api-key` when a key is set
3. Adgate asks **jev-local** at `ADGATE_JEV_URL`:
   - **site_type** (`choice`)
   - per element **noul** and **kind** (`ad` / `promo` / `unrelated_inject` / `donate_ask` / …)
4. **Review mode (default):** inspect class, score, and whether a user rank caused hide.
5. **Block:** when enabled, hide if the element’s class is enabled in ranks and noul ≥ that class threshold. Then empty parents collapse. One neighborhood re-classify pass sends still-visible siblings in that wrapper through the same page-judge and ranks.

### Scores

| noul | Action | Block on |
|------|--------|----------|
| ≥ `hideMin` (default **0.75**) | `hide` | Element is removed, then empty parents collapse |
| **0.45** ≤ noul < `hideMin` | `review` | Kept. Shown in the review band for tuning |
| < 0.45 | `allow` | Kept |

Empty-parent collapse stops at `html`, `body`, `main`, `header`, `nav`, and `footer` (and the landmark roles `main`, `banner`, `navigation`, `contentinfo`) and at common app roots (`root`, `app`, `__next`, `__nuxt`). A full-bleed shell (`h-full` + `w-full`, or about 40% of the viewport) stays only while it still holds real content; an empty ad rail collapses, including a flex or grid column that only held the creative. A parent is empty when it has no real text, media, or controls left. Blank, `about:blank`, and ~0-size iframes do not count. A lone “Advertisement” label does not count. `aside` / `div` shells can collapse; 1×1 tracking pixels do not keep a shell alive.

## Repo layout

| Path | Role |
|------|------|
| `extension/` | Chrome MV3 unpacked extension (review page, optional early script) |
| `server/` | FastAPI adgate (`/v1/page-judge`, `/v1/log`, `/v1/runs`, `/health`) |
| `fixtures/decision-log.sample.json` | Dry-run decision log (no live scorer) |
| `scripts/tail-logs.sh` | Inspect JSONL logs |
| `PRODUCT.md` | Product / decision model notes |
| `INSTALL.md` | Install / stale-build notes |

## Quick start

### 1. jev-local (System One scorer)

On the host GPU box, run [jev-local](https://github.com/us/jev-local) (or your own `/v1/systemone` compatible server) on `:8765`.

### 2. adgate service

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
ADGATE_JEV_URL=http://127.0.0.1:8765 ./scripts/start.sh
# listens 0.0.0.0:8770
```

Optional systemd user unit: `server/systemd/adgate.service`

### 3. Chrome extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`  
2. Confirm version in the card matches `extension/manifest.json`  
3. Service URL defaults to `https://www.dagote.ai/api/jev`. Paste an API key, then **Refresh models** (or Save) so the list comes from `GET /models`. The chosen id is stored and sent on every judge call. To use LAN Adgate instead, type `http://192.168.0.119:8770` (API key optional). jev-local on that network is `http://192.168.0.119:8765` and is not the extension default.
4. **Judge this tab**, then **Open review** for the decision list

**Block** stays off until you enable it. On-page `%` chips and the data panel are under **Advanced** and default off.

Logs default next to the server, not a home-directory path:

- `server/logs/adgate.jsonl` — service + client events (`ADGATE_LOG_PATH`)
- `server/logs/decision-runs.jsonl` — one decision-log object per line (`ADGATE_DECISION_LOG`)
- `server/logs/runs/<requestId>.json` — the same run as a file (`ADGATE_RUNS_DIR`)

Set those env vars to keep an older absolute path. `./scripts/tail-logs.sh` reads `ADGATE_LOG_PATH` or `server/logs/adgate.jsonl`.

## API sketch

`POST /v1/page-judge`

```json
{
  "page": { "url": "...", "hostname": "...", "title": "...", "excerpt": "...", "headings": [] },
  "elements": [{ "id": "e0", "tag": "iframe", "src": "...", "classes": [], "rect": {} }],
  "hideMin": 0.75,
  "model": "jev-tiny"
}
```

Send header `x-api-key` when an API key is set (Dagote hosted). Omit it for LAN Adgate that does not require a key. `GET {Service URL}/models` returns `{ data: [{ id, hf_id, aliases }], default, loaded }`. List every `data[].id` and send the chosen id even if `loaded` is only the tiny model.

Question types on the System One API (`POST /v1/systemone`, used by adgate, not called directly by the extension):

| type | Role |
|------|------|
| `noul` | Probability a yes/no statement is true (ad / unrelated) |
| `choice` | One label from a criteria map (site type, element kind) |
| `score` | A numeric rating. Page-judge in this repo asks `noul` and `choice` |

Hosted Dagote (`https://www.dagote.ai/api/jev`) is the default. Local open-weight models behind jev-local are not hosted TypeSafe Jev quality.

Response includes `site_type`, probabilities, per-element `noul` / `action`, plus `hideMin` and `reviewMin`.

The extension builds a decision log (`schema: adgate.decision_log.v1`) after it applies removals. Each element has `id`, `tag`, `src`, `href`, `classes`, `idAttr`, `text`, `role`, `rect`, `fixedOrSticky`, `discover` (why the live scan kept the node), `noul`, `action`, `reason`, `removed`, and `cascadeParents` (`reason: empty_parent`). That object is stored in `chrome.storage.local`, shipped through `POST /v1/log` as a `decision_run` entry, and written to the run files above. The review page shows the candidate count and a “Found via” tally. It can export JSON and JSONL, or load a file (including `fixtures/decision-log.sample.json`).

`GET /v1/runs/latest` and `GET /v1/runs/{requestId}` return a saved run.

## Extreme Test review loop

Target: https://canyoublockit.com/extreme-test/

This page is a stress catalog (pop-unders, interstitials, push prompts, in-page push, banners, ad hosts). It is not a claim that every cell is blocked.

1. Start jev-local and adgate (above). Confirm `GET /health` shows `jev_ok` if the scorer is up.
2. Load unpacked `extension/` and confirm the card says **0.1.8**. Reload if it still says 0.1.7 or older.
3. Service URL defaults to Dagote. Set the API key. The default model is `jev-tiny`; pick `jev-latest` or `jev-3b` from `GET /models` if you want a larger scorer. LAN Adgate `http://192.168.0.119:8770` still works if you type it in. Confirm `GET /health` on that service. Enable **Block**. Configure hide ranks (ad/promo on by default). Leave Extreme force-hide cheats **off**.
4. Open a page, reload so 0.1.8 attaches, click **Judge this tab** with Block **off** first. Review should list candidates with kind+noul (Advertisement/ad.com should be `ad`, not `nav_chrome` or `judge_error`). Then enable Block and ranks to remove.
5. Check empty parents in the “After” column (`reason: empty_parent`). The summary line starts with the candidate count. Export JSON/JSONL or reload the latest run from the review page.
6. Optional **Advanced → Extreme early defenses**, then reload the test tab. That registers `early.js` at `document_start` in the page world (pop-under gate + notification deny + known-host node strip). **Block** also enables `rules.json` through `declarativeNetRequest` for known ad hosts. With Block off, those network rules stay disabled so the judge can still see the requests.
7. Nodes that early defenses or DNR remove before the judge never appear in the decision log. The log is the DOM judge’s record.

To inspect the dry fixture without a scorer: **Open review → Load JSON** and choose `fixtures/decision-log.sample.json`. From a static server rooted at this repo, `extension/review.html?fixture=1` renders that same file (HTTP only; the packaged extension does not fetch it).

```bash
node --test extension/*.test.js
server/.venv/bin/python -m unittest server.test_decision_log
```

## Notes

- Reload **0.1.8**. Hosted Dagote is the default service and the default scorer is jev-tiny (0.5B). A local open-weight jev-local is not hosted TypeSafe Jev quality. Extreme force-hide cheats stay off for product retests. A unit test is not a live Chrome pass.
- `node --test extension/*.test.js` includes ranks, cheats-default-off, and legacy Extreme remover tests (debug only). Install linkedom with `npm install` first.  
- Page context is kept small; elements are scored **one call each**. Oversized prefixes are skipped silently for that element.  
- Do not commit `logs/` or `*.zip` builds.

## License

MIT (unless otherwise noted for vendored files).
