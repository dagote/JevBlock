# Reference: canyoublockit Extreme Test

Source: https://canyoublockit.com/extreme-test/

## What Extreme exercises

1. **Pop-under ads** — click anywhere opens a new tab/window  
2. **Interstitial ads** — full-page overlay before/during load  
3. **Push notification requests** — `Notification.requestPermission` spam  
4. **In-page push ads** — floating widgets injected by third-party JS  
5. **Pre-roll video ads** — before player content  
6. **Banner / native banner / direct-link ads**  
7. **Third-party ad networks** — DNS/network blockable (Pi-hole territory)

## Hosts observed on Extreme (sample)

- `12ezo5v60.com` — Clickadu in-page push + push notification snippets + VAST `vastTag`
- `ybs2ffs7v.com` — banner loaders (`/lv/esnk/<id>/code.js`, class `__clb-<id>`)
- `fvcwqkkqmuv.com` — ad loaders
- `cdn.bncloudfl.com` — image creatives (png or gif) injected inside same-origin `__clb-*_container` iframes (the yellow CAUTION look is the image, not a text node)
- `adsco.re`, `antiadblocksystems.com`, `coosync.com`, `displayendpointstarring.com` — injected after JS
- direct `href="ad.com"` — Direct Link Ads cell

Plus common networks: DoubleClick / Google Syndication, etc.

Live Chrome (2026-09-22, after JS) does not match the static snippet. With ad-host URLs blocked, the only iframes left are `src="javascript:false"` and `.iubenda-ibadge`. The banner slots stay as Elementor html widgets: a hidden `script[src*="ybs2ffs7v.com"]` plus a `<center>` whose text is `Advertisement`. When the script runs, it inserts `iframe#__clb-<id>_1_container` (300×250 or 300×100) whose document loads the bncloudfl GIF.

## Mapping to Adgate

| Vector | Adgate layer |
|--------|----------------|
| Network hosts | `rules.json` via `declarativeNetRequest`, enabled only while Block is on |
| Pop-under | `early.js` `window.open` gate, MAIN world, only if Extreme early defenses is on |
| Push permission | `early.js` deny `requestPermission`, same opt-in |
| Interstitial / in-page push DOM | System One `noul` + block removes the node and empty parents |
| Elementor html widgets, `code-block` script src, `href="ad.com"`, VAST `vastTag` or `.vast_video_loading` / `.fluid_video_wrapper`, empty html widgets, visible `Advertisement` labels, `__clb-` iframes, IAB-sized iframes, `role=advertisement` | `extension/candidates.js`, then the same judge. `discover` on each decision says why the node was kept. Block on force-hides those slot reasons even if the model allows them. `javascript:` frames and the iubenda badge are not candidates |
| Fixed/sticky dialogs, overlay/push copy, iframes, known ad hosts | Same collector. Decorative `elementor-background-overlay` is not a candidate |
| Late injection | While Block is on: scans around 1s, 4s, 8s, and 14s, plus up to four MutationObserver rescans (1s debounce) |

`early.js` is not in the manifest content_scripts list. The service worker registers it when the popup toggle is on. Reload the tab after toggling.

Extreme is a **stress catalog**, not a claim we fully pass every cell. Use the review page and decision log to see what was removed and why. See the Extreme Test loop in `README.md`.
