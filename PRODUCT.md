# Adgate 0.1.8 — System One page classify + user ranks

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
elements { id, tag, role, text, nearbyLabel, href, src, hrefHost, srcHost, rect, fixedOrSticky, discover, hint }
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
        ▼
one neighborhood re-classify of sibling/same-wrapper candidates
  (same JEV ranks and model, no force-hide; single follow-up pass)
        ▼
decision log for review mode
```

## Judge element contract (hosted page-judge)

Hosted `POST /v1/page-judge` scores an element from a short blob. These are the only fields the client sends:

| Field | Role |
|-------|------|
| `id` | Match the judgment back to the node |
| `tag` | Element tag |
| `role` | ARIA role when set (`presentation` marks a spacer) |
| `text` | Visible text, capped at 180 characters |
| `nearbyLabel` | Short previous-sibling or parent label (for example `Advertisement`) |
| `href` / `src` | Own URL, or the first meaningful child `a[href]` / `iframe[src]` |
| `hrefHost` / `srcHost` | Host of those URLs when present |
| `rect` | `{w,h,x,y}` |
| `fixedOrSticky` | Fixed, sticky, or absolute |
| `discover` | Why the node was kept: `iframe`, `ad_host_asset`, `data_ad_row`, or an older slot name |
| `hint` | Optional short phrase (≤140). Facts only, not an HTML dump |

`classes`, `idAttr`, `ariaLabel`, `testId`, `outerHTML`, and `innerText` are debug fields for the review log. They are not posted. Pick Score / the decision log may still show them.

When a wrapper is serialized, the first real child `iframe[src]` is copied onto `src` (and `srcHost`). The first real child `a[href]` is copied onto `href` only if the node has no href of its own. `javascript:`, `about:blank`, and empty URLs are not meaningful.

`discover` is set from signals, not from a class substring:

- `data_ad_row` — `data-ad*`, GPT slot id, or adsbygoogle
- `ad_host_asset` — GAM / ad-network / `/mail-us/` src or href
- `iframe` — a real iframe that is not an ad-network asset

### Candidate selector

Precision over coverage. At most 24 candidates per page.

Included: GAM/GPT iframes, `data-ad` rows, fixed overlays whose text is ad-like (`sponsored`, `special offer`), and the existing high-precision ad-host / Elementor slot signals.

Excluded: empty presentation spacers (`role=presentation`, spacer/gap classes, short empty bars), and primary mail chrome (toolbar, compose, folder list, message-list rows) unless the node itself is an ad signal.

### Kind gap (hosted response)

Live Dagote jev-tiny returns each element as `{id, noul, action, reason}` and **omits `kind`**. The client does not invent a host kind.

Rank policy when `kind` is missing and (`action` is `hide` or `noul` ≥ hideMin, default 0.75):

- Apply the **ad** rank (enabled flag and that rank’s hideMin) for the hide decision only.
- Record `kind: kind_missing_host`, `kindPolicy: ad`, `hostKind: null`, `reason: kind_missing_host`.
- A missing kind below the ad threshold is not hidden, even if the host action string is `hide`.

If the host does send `kind`, that value is used and `kind_missing_host` is not applied.

Live jev-tiny does **not** pass on noul alone. See `docs/contract-matrix.md`.

- `servedby.doubleclick.net` scores about **0.90 hide**. Promoting that src is enough.
- `gpt.mail.aol.com/f/gam/gptIframe` scores about **0.27 allow**. The host’s ad-host prior does not see a first-party mail GAM host. The client sends `discover: ad_host_asset` and hint `first-party mail GAM iframe`, then applies **`prior_mail_gam`** when noul is below the ad rank. The stored noul stays the host value. This is a prior, not an Extreme force-hide cheat.
- A `data_ad_row` with a weak noul gets **`prior_data_ad_row`** the same way.
- Capital One–style ad text stays about **0.62–0.68 review** even with `discover: ad_label` and an Advertisement label. There is no client prior for that copy. Field tweaks do not make it a hide. Passing it needs the host to return `kind` (or a real text prior on the API).
- Empty spacers are noisy (about 0.44 allow, 0.56 review, or 0.82 hide). Do not trust noul alone. The selector does not send them.
- `kind` is still always null. `kind_missing_host` only labels that gap. It does not invent a host class.

### Call budget

One in-flight page-judge (background abort on overlap). Content coalesces boot/mutation storms. An unchanged fingerprint skips `boot2` / `boot3` / mutation repeats for 30 seconds. A manual judge always runs.

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

Decision reason when a rank fires: `rank_<kind>` (shown in the review UI). When the host omits kind, the review label is `kind_missing_host` instead of a pretend host class.

## Extreme force-hide cheats (legacy)

`forceHideCheats` defaults **false**. When on, Block also runs Extreme-specific removers (`force_hide_ad_host_widget`, `force_hide_clb_container`, …). That path is for debugging Extreme markup only — not the product.

## Transparent priors (server)

Labeled floors may still raise a low JEV score (e.g. `aria_ad`, general ad-host `src`/`href`). Extreme Elementor blank/ad_label short-circuits that **skipped** JEV are retired; those nodes are scored by JEV.

## Service link

Popup **Service URL** defaults to `https://www.dagote.ai/api/jev`. Existing installs whose stored URL is empty or still the old LAN default `http://192.168.0.119:8770` migrate to that host (`uiRev` 3). A custom URL is left alone, and typing the LAN URL back in after the upgrade keeps it.

- **API key** — stored in `chrome.storage.sync` (a short string, under the 8KB per-item sync quota). Sent as `x-api-key` on page-judge and log calls when non-empty. Optional for LAN. Never written to console logs.
- **Model** — `GET {Service URL}/models` returns `{ data: [{ id, hf_id, aliases }], default, loaded }`. The popup lists every id. The default scorer is `jev-tiny` (0.5B) on Dagote. `jev-latest` and `jev-3b` stay on that list for the user to pick. A stored model is kept, including an existing `jev-latest` choice; only an empty or missing model is filled with `jev-tiny`. The page-judge JSON body always includes `model`. Do not rely on the server default alone. A parent `/models` URL is tried only if the first path 404s. A Dagote `429` or `busy` body (“Already generating a reply”) is retried with `retryAfter` (seconds). The API key is not written to those logs. Boot judges stay enabled.
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

Extension **0.1.8**. Server **0.3.2**. The judge POST uses the slim element contract (child iframe/href promoted; no HTML dumps). Hosted Dagote may omit `kind`; the client then applies the ad rank under the label `kind_missing_host`. After a rank hide, one neighborhood re-classify pass sends still-visible siblings in that wrapper through the same page-judge and ranks (no Extreme force-hide). The page-judge flight helper is an IIFE (`AdgatePageJudgeFlight`) so the service worker can `importScripts` it without redeclaring `PAGE_JUDGE_TIMEOUT_MS`. Client page-judge timeout 15 minutes + single-flight. Repeat fingerprints skip extra boot judges for 30 seconds. Soft remap is classification-only. Force-hide cheats stay off. Service URL defaults to Dagote hosted JEV. Default scorer is jev-tiny (0.5B).
