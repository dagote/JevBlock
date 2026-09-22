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

- `12ezo5v60.com` — Clickadu in-page push + push notification snippets  
- `ybs2ffs7v.com` — ad loaders  
- `fvcwqkkqmuv.com` — ad loaders  

Plus common networks: DoubleClick / Google Syndication, etc.

## Mapping to Adgate

| Vector | Adgate layer |
|--------|----------------|
| Network hosts | `rules.json` via `declarativeNetRequest`, enabled only while Block is on |
| Pop-under | `early.js` `window.open` gate, MAIN world, only if Extreme early defenses is on |
| Push permission | `early.js` deny `requestPermission`, same opt-in |
| Interstitial / in-page push DOM | System One `noul` + block removes the node and empty parents |
| Fixed/sticky overlays, iframes, known ad hosts | Candidate collection, then the same judge |
| Late injection | Up to two debounced rescans while Block is on |

`early.js` is not in the manifest content_scripts list. The service worker registers it when the popup toggle is on. Reload the tab after toggling.

Extreme is a **stress catalog**, not a claim we fully pass every cell. Use the review page and decision log to see what was removed and why. See the Extreme Test loop in `README.md`.
