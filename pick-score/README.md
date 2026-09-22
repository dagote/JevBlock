# JEV Pick Score

Unpacked Chrome extension (Manifest V3, **0.1.0**) that lets you click one DOM element and score it with Dagote JEV. It is separate from Adgate in `extension/`. It only classifies. It does not hide elements and it does not run Extreme force-hide cheats.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and choose this `pick-score/` folder (the folder that contains `manifest.json`).
4. Confirm the card says **JEV Pick Score** and version **0.1.0**, not Adgate.

## Use

1. Open the toolbar popup.
2. Service URL defaults to `https://www.dagote.ai/api/jev`. Paste your Dagote API key (password field). It is stored in `chrome.storage.sync` and sent only as the `x-api-key` header. It is not written to extension logs.
3. Model defaults to `jev-tiny`. **Refresh models** calls `GET /models` and fills the list.
4. **Save**.
5. **Pick mode ON**. On an `http` or `https` page, hover to outline an element, then click it. The click does not follow links. **Esc** (or the on-page badge) turns pick mode off.
6. A panel on the page shows `kind`, `noul`, `action` / `reason` when present, `site_type`, `requestId`, and `ms`. Expand the raw request element and the response JSON. A failed call shows the error text with the API key redacted.

The background service worker POSTs one element to `{Service URL}/v1/page-judge` with `model`, `page`, `elements: [e0]`, and `hideMin` 0.75. The element uses Adgate’s page-judge fields (`id`, `tag`, `role`, `text`, `nearbyLabel`, `href`, `src`, `rect`, `fixedOrSticky`, `discover`, …) plus a capped subtree (`innerText`, descendant tags, link hrefs, image srcs, truncated `outerHTML`).

This does not prove a live Extreme block. It only shows the score for the element you clicked.

## Verify manually

1. Load unpacked `pick-score/` and confirm the name **JEV Pick Score** / version **0.1.0**.
2. Save a Service URL and API key. In the service worker console, trigger a score and confirm the key string never appears. Logs may include `hasApiKey: true`.
3. Pick mode ON, hover a link, click it. The browser stays on the page. The panel shows **Scoring with JEV…**, then kind / noul / site_type / requestId / ms, or an error.
4. Esc removes the outline and the badge. The result panel stays until you close it.
5. `npm test` includes `pick-score/*.test.js` (request shape matches Adgate’s `buildPageJudgeRequest`, element caps, manifest permissions).

Optional browser smoke (fake local judge, no Dagote key):

```bash
node pick-score/smoke.mjs
```
