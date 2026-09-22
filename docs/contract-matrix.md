# jev-tiny mail contract matrix

Hosted `POST https://www.dagote.ai/api/jev/v1/page-judge`, model `jev-tiny`. `kind` is always null. Full earlier request/response: [`contract-matrix.json`](contract-matrix.json) (request `09f57797d4df`).

## Owner ablation (this session)

These are the numbers to trust. Field tweaks were already tried.

| Case | Host noul | Action | What it means |
|------|-----------|--------|----------------|
| Capital One ad text, including `discover=ad_label` or text `Advertisement` plus a nearby promo | ~0.62–0.68 | review | Copy never reaches hide. Field tweaks do not fix it. |
| iframe `src=https://servedby.doubleclick.net/ad` | 0.90 | hide | Ad-host signal works once the src is a known ad network. |
| iframe `src=https://gpt.mail.aol.com/f/gam/gptIframe…` | 0.27 | allow | First-party AOL GAM host is invisible to the host priors. |
| Empty spacer | noisy | 0.82 hide earlier; sticky 0.44 allow; non-sticky 0.56 review | Do not trust noul alone. |

A follow-up call with the slim blob (`discover: ad_host_asset`, hint `first-party mail GAM iframe`, `srcHost: gpt.mail.aol.com`) still returned noul **0.3775 allow** and `kind: null`. The client decision on that row is hide via `prior_mail_gam`, with the host noul left at 0.3775.

## Pass bar on pure JEV noul

**Fail.** Promoting src is necessary and is enough for `doubleclick.net`. It is not enough for Capital One text or for `gpt.mail.aol.com`.

The client does not rewrite Capital One’s noul and does not add a prior for ad-label copy. That case needs the host to return `kind`, or a text prior inside page-judge. Until then it stays in the review band.

## What the client does instead

`gpt.mail.aol.com`, `/f/gam/`, and `gptIframe` are collected as `discover: ad_host_asset` with hint `first-party mail GAM iframe`. When the host noul is below the ad rank (the 0.27 case), Block applies **`prior_mail_gam`**. A `data_ad_row` with a weak noul gets **`prior_data_ad_row`**. The review row still shows the host noul and `kind_missing_host`. These are priors, not Extreme `force_hide_*` cheats. Turning the ad rank off turns the prior off.

Empty spacers are not candidates. A noisy 0.82 must not delete them, and a noisy 0.44 must not be treated as proof they are safe to score.

## Smallest API change

Return `kind` on each element. The LAN Adgate server already does, and it can floor `gpt.mail.aol.com` as `s1_plus_mail_gam_prior`. Hosted jev-tiny noul alone cannot pass Capital One or first-party AOL GAM.
