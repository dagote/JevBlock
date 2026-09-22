# Adgate 0.0.0 — System One page judge

## Idea

Feed **page context** (not just one node) into System One, then ask:

1. **What kind of site is this?** (`choice` → `site_type`)
2. **For each candidate element:** P(it is an **ad or unrelated** to that site’s purpose) (`noul`)

## Pipeline

```
page excerpt + headings + url
        +
candidate elements (iframes, rails, ad-ish nodes)
        │
        ▼
POST /v1/page-judge  (adgate → jev-local)
        │
        ├─ Step 1: site_type choice
        └─ Step 2: per-element noul (with site_type in state)
        │
        ▼
action: hide if P ≥ hideMin (default 0.75)
        review if 0.45 ≤ P < hideMin
        allow otherwise
        ▼
block on → remove hide nodes, then empty parent shells
decision log (JSON + JSONL) for review mode
```

## Honest limits (local jev-local 1.5B)

The open-weight stand-in often mis-labels mail as `docs_app` and under-scores AOL `mail-us` iframes.  
Server applies **transparent priors** (logged in `reason`):

- hostname `mail.aol.com` / `mail.yahoo.com` → force `site_type=mail` when model misses
- `canyoublockit.com` `/extreme-test` labeled `docs_app` → `marketing` if that probability is at least `other`, otherwise `other` (`reason` on the site-type log: `extreme_test_path`)
- `mail-us` iframe on a mail site → `s1_plus_mail_us_prior`, floor 0.9
- known ad-host `src` or `href` (including `ad.com`, not lookalikes like `head.com`) → `s1_plus_adhost_prior`, floor 0.9
- `role=advertisement` or an ad-like `aria-label` → skip the model, `aria_ad` at 0.95
- fixed/sticky plus dialog role or interstitial / special-offer / “click here” copy → `s1_plus_overlay_prior`, floor 0.9
- `notification-permission` or “wants to … notifications” → `s1_plus_push_permission_prior`, floor 0.9

Real hosted Jev should make those priors unnecessary; keep them labeled so we can turn them off.

## Install

`http://192.168.0.119:8080/adgate-extension/adgate-v0.0.0.zip`  
Chrome card must show **Adgate / 0.0.0**. Remove all older Adgate builds first.
