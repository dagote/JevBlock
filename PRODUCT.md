# Adgate 0.1.2 — System One page classify + user ranks

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
POST /v1/page-judge  (adgate → jev-local)
        │
        ├─ site_type choice
        └─ per element: noul + kind choice (clear ad vs nav_chrome instructions)
        │
        ▼
optional soft_remap_kind (classification only): if model dumps ad slots into nav_chrome
        but Advertisement / ad discover / ad host signals are present → kind=ad
        (kindModel keeps the raw model choice; does not force-hide)
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

## Versions

Extension **0.1.2**. Server **0.3.1**. Kind choice instructions distinguish ad vs nav_chrome; element blobs include discover/hosts/hints. Soft remap is classification-only (logs `kindModel`). Candidate discovery feeds JEV even when force-hide cheats are off; a judge timeout still records collected candidates (`reason: judge_error`).
