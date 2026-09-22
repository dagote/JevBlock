# JevBlock (Adgate)

Chrome extension + intranet service that uses a **System One / Jev-compatible** judge to score page elements as ads (or unrelated chrome) given whole-page context.

## How it works

1. Extension extracts a short page summary + candidate DOM elements  
2. Service worker POSTs to intranet **adgate** `POST /v1/page-judge` (avoids HTTPS mixed-content)  
3. Adgate asks **jev-local** (or compatible System One API):
   - **site_type** (`choice`) — what kind of site is this?
   - per element **noul** — P(ad or unrelated to that purpose)
4. **Annotate mode (default):** show `%` chips + data panel / popup — **do not remove**  
5. Optional: enable blocking when scores look right

## Repo layout

| Path | Role |
|------|------|
| `extension/` | Chrome MV3 unpacked extension |
| `server/` | FastAPI adgate (`/v1/page-judge`, `/v1/log`, `/health`) |
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
3. Server URL default: `http://<lan-ip>:8770`  
4. **Judge this tab** — read site type + per-element `%` in popup / on-page panel  

**Block (actually remove)** stays off until you enable it in the popup.

## API sketch

`POST /v1/page-judge`

```json
{
  "page": { "url": "...", "hostname": "...", "title": "...", "excerpt": "...", "headings": [] },
  "elements": [{ "id": "e0", "tag": "iframe", "src": "...", "classes": [], "rect": {} }],
  "hideMin": 0.75
}
```

Response includes `site_type`, probabilities, and per-element `noul` / suggested `action`.

## Notes

- Local open-weight scorers (e.g. Qwen 1.5B via jev-local) are weaker than hosted Jev; server may apply **labeled priors** (see `PRODUCT.md`).  
- Page context is kept small; elements are scored **one call each**. Oversized prefixes are skipped silently for that element.  
- Do not commit `logs/` or `*.zip` builds.

## License

MIT (unless otherwise noted for vendored files).
