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
| Network hosts | `rules.json` DNR |
| Pop-under | `early.js` `window.open` gate |
| Push permission | `early.js` deny `requestPermission` |
| Interstitial / in-page push DOM | System One + `blockScope=viewport/container` |
| Late injection | `MutationObserver` rescan |

Extreme is a **stress catalog**, not a claim we fully pass every cell. Use it to grow rules + heuristics; keep System One for ambiguous shells.
