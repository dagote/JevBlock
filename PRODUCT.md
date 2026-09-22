# Adgate 0.1.5 — System One page classify + user ranks

## Idea

Feed **page context** and candidate elements into System One, then let the user decide what to hide by **class** and **score**.

1. **What kind of site is this?** (`choice` → `site_type`)
2. **For each candidate:**
   - `noul` — P(ad or unrelated to that site’s purpose)
   - `kind` — one of `main_content | ad | promo | unrelated_inject | donate_ask | tracking_chrome | nav_chrome | other`

Block removals come from **JEV + user ranks**, not Extreme-specific `force_hide_*` selectors (those are opt-in cheats).

## Pipeline

```
page { url, hostname, title, excerpt, headings }
        +
elements { id, tag, role, text, nearbyLabel, href, src, hrefHost, srcHost, discover, hint, … }
        │
        ▼
POST /v1/page-judge  (Service URL, Dagote hosted by default → JEV)
  body.model always set; header x-api-key when an API key is stored
  client: 15‑min timeout, single-flight (abort overlapping judges)
  server: ad-like candidates first; noul+kind per element; 12‑min budget
        │
        ├─ site_type choice
        └─ per element: noul + kind choice (clear ad vs nav_chrome instructions)
        │
        ▼
optional soft_remap_kind (classification only): if model dumps ad slots into nav_chrome
        but Advertisement / ad discover / ad host signals are present → kind=ad
        (kindModel keeps the raw model choice; does not force-hide)
        Budget skips still soft-remap so the HTTP response is complete.
        │
        ▼
client ranks: hide if kind enabled and noul ≥ that class hideMin
        ▼
block on → remove hide nodes, then empty parent shells
decision log for review mode
```

## Element kinds (`kind`)

| kind | Meaning |
|------|---------|
| `main_content` | Primary article/tool content the user came for |
| `ad` | Commercial advertisement / sponsored creative / ad slot |
| `promo` | First-party upsell |
| `unrelated_inject` | Third-party inject unrelated to purpose |
| `donate_ask` | Donation / tip ask |
| `tracking_chrome` | Tracker/beacon/ad script with little UI |
| `nav_chrome` | Site header/footer/menu only — not Advertisement widgets |
| `other` | Unclear |

## User ranks (popup)

Defaults: hide **ad**, **promo**, and **tracking_chrome** at noul ≥ 0.75. **unrelated_inject** and **donate_ask** are off (enable + set threshold to use). Persist in `chrome.storage.sync.ranks`.

Decision reason when a rank fires: `rank_<kind>` (shown in the review UI).

## Extreme force-hide cheats (legacy)

`forceHideCheats` defaults **false**. When on, Block also runs Extreme-specific removers (`force_hide_ad_host_widget`, `force_hide_clb_container`, …). That path is for debugging Extreme markup only — not the product.

## Transparent priors (server)

Labeled floors may still raise a low JEV score (e.g. `aria_ad`, general ad-host `src`/`href`). Extreme Elementor blank/ad_label short-circuits that **skipped** JEV are retired; those nodes are scored by JEV.

## Service link

Popup **Service URL** defaults to `https://www.dagote.ai/api/jev`. Existing installs whose stored URL is empty or still the old LAN default `http://192.168.0.119:8770` migrate to that host (`uiRev` 3). A custom URL is left alone, and typing the LAN URL back in after the upgrade keeps it.

- **API key** — stored in `chrome.storage.sync` (a short string, under the 8KB per-item sync quota). Sent as `x-api-key` on page-judge and log calls when non-empty. Optional for LAN. Never written to console logs.
- **Model** — `GET {Service URL}/models` returns `{ data: [{ id, hf_id, aliases }], default, loaded }`. The popup lists every id. Default selection is `jev-latest`, or the payload `default` when that fetch succeeds before the user has chosen. The page-judge JSON body always includes `model`. Do not rely on the server default alone. A parent `/models` URL is tried only if the first path 404s.
- **LAN fallback (not the default)** — Adgate `http://192.168.0.119:8770`, jev-local `http://192.168.0.119:8765`.
- Local open-weight jev-local is not hosted TypeSafe Jev quality.

System One question types (adgate asks these; the extension does not call `/v1/systemone` itself):

| type | Role |
|------|------|
| `noul` | Probability a yes/no statement is true |
| `choice` | One label from a criteria map |
| `score` | A numeric rating |

Page-judge uses `noul` (ad / unrelated) and `choice` (site type and element kind).

## Versions

Extension **0.1.5**. Server **0.3.2**. The page-judge flight helper is an IIFE (`AdgatePageJudgeFlight`) so the service worker can `importScripts` it without redeclaring `PAGE_JUDGE_TIMEOUT_MS`. Client page-judge timeout 15 minutes + single-flight. Soft remap is classification-only. Force-hide cheats stay off. Service URL defaults to Dagote hosted JEV.
