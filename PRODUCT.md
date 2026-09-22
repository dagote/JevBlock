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
hide if P ≥ hideMin (default 0.75)
popup shows site type + table of P / action
```

## Honest limits (local jev-local 1.5B)

The open-weight stand-in often mis-labels mail as `docs_app` and under-scores AOL `mail-us` iframes.  
Server applies **transparent priors** (logged in `reason`):

- hostname `mail.aol.com` / `mail.yahoo.com` → force `site_type=mail` when model misses
- `mail-us` iframe on a mail site / known ad-host src → floor P at 0.9 if S1 is low

Real hosted Jev should make those priors unnecessary; keep them labeled so we can turn them off.

## Install

`http://192.168.0.119:8080/adgate-extension/adgate-v0.0.0.zip`  
Chrome card must show **Adgate / 0.0.0**. Remove all older Adgate builds first.
