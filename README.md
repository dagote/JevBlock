# JevBlock (Adgate)

Chrome extension + intranet service that uses a **System One / Jev-compatible** judge to score page elements as ads (or unrelated chrome) given whole-page context.

Extension version is `extension/manifest.json` (**0.0.4**). Server version is **0.2.2**.

## How it works

1. Extension extracts a short page summary + candidate DOM elements (iframes, ad-ish nodes, fixed/sticky overlays)
2. Service worker POSTs to intranet **adgate** `POST /v1/page-judge` (avoids HTTPS mixed-content)
3. Adgate asks **jev-local** (or compatible System One API) at `ADGATE_JEV_URL` (default `http://127.0.0.1:8765`):
   - **site_type** (`choice`) — what kind of site is this?
   - per element **noul** — P(ad or unrelated to that purpose)
4. **Review mode (default):** no on-page `%` chips. Open the review page to inspect scores, reasons, and removals.
5. **Block:** when enabled, `hide` elements are removed, then empty parent shells are removed. Each removal is written to a decision log.

### Scores

| noul | Action | Block on |
|------|--------|----------|
| ≥ `hideMin` (default **0.75**) | `hide` | Element is removed, then empty parents collapse |
| **0.45** ≤ noul < `hideMin` | `review` | Kept. Shown in the review band for tuning |
| < 0.45 | `allow` | Kept |

Empty-parent collapse stops at `html`, `body`, `main`, `header`, `nav`, and `footer` (and the landmark roles `main`, `banner`, `navigation`, `contentinfo`). It also stops at full-page shells (`h-full` + `w-full`, or about 40% of the viewport) and common app roots (`root`, `app`, `__next`, `__nuxt`). A parent is empty when it has no real text, media, or controls left. A lone “Advertisement” label does not count. `aside` / `div` shells can collapse; 1×1 tracking pixels do not keep a shell alive.

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
3. Server URL default: `http://<lan-ip>:8770` (the popup default is an example LAN host — change it)
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
  "hideMin": 0.75
}
```

Response includes `site_type`, probabilities, per-element `noul` / `action`, plus `hideMin` and `reviewMin`.

The extension builds a decision log (`schema: adgate.decision_log.v1`) after it applies removals. Each element has `id`, `tag`, `src`, `classes`, `rect`, `noul`, `action`, `reason`, `removed`, and `cascadeParents` (`reason: empty_parent`). That object is stored in `chrome.storage.local`, shipped through `POST /v1/log` as a `decision_run` entry, and written to the run files above. The review page can export JSON and JSONL, or load a file (including `fixtures/decision-log.sample.json`).

`GET /v1/runs/latest` and `GET /v1/runs/{requestId}` return a saved run.

## Extreme Test review loop

Target: https://canyoublockit.com/extreme-test/

This page is a stress catalog (pop-unders, interstitials, push prompts, in-page push, banners, ad hosts). It is not a claim that every cell is blocked.

1. Start jev-local and adgate (above). Confirm `GET /health` shows `jev_ok` if the scorer is up.
2. Load unpacked `extension/` and confirm the card says **0.0.4**.
3. Set the server URL. Enable **Block — remove ads and empty parents**. Leave hide minimum at **0.75** unless you are tuning.
4. Open the Extreme Test page and click **Judge this tab**. Review mode opens a list of removals with scores and reasons. The page itself should not grow `%` chips.
5. Check empty parents in the “After” column (`reason: empty_parent`). Export JSON/JSONL or reload the latest run from the review page.
6. Optional **Advanced → Extreme early defenses**, then reload the test tab. That registers `early.js` at `document_start` in the page world (pop-under gate + notification deny + known-host node strip). **Block** also enables `rules.json` through `declarativeNetRequest` for known ad hosts. With Block off, those network rules stay disabled so the judge can still see the requests.
7. Nodes that early defenses or DNR remove before the judge never appear in the decision log. The log is the DOM judge’s record.

To inspect the dry fixture without a scorer: **Open review → Load JSON** and choose `fixtures/decision-log.sample.json`. From a static server rooted at this repo, `extension/review.html?fixture=1` renders that same file (HTTP only; the packaged extension does not fetch it).

```bash
node --test extension/*.test.js
server/.venv/bin/python -m unittest server.test_decision_log
```

## Notes

- Local open-weight scorers (e.g. Qwen 1.5B via jev-local) are weaker than hosted Jev; server may apply **labeled priors** (see `PRODUCT.md`). Extreme Test pass 1 (hide 12 / allow 12, no overblocks) missed ad-host links, `ad.com`, overlays, push-permission prompts, and `role=advertisement`. Those now floor or short-circuit with reasons `s1_plus_adhost_prior`, `s1_plus_overlay_prior`, `s1_plus_push_permission_prior`, and `aria_ad`. Restart adgate to pick them up; the extension does not need a reload for the prior change.  
- Page context is kept small; elements are scored **one call each**. Oversized prefixes are skipped silently for that element.  
- Do not commit `logs/` or `*.zip` builds.

## License

MIT (unless otherwise noted for vendored files).
