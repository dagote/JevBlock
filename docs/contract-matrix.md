# jev-tiny mail contract matrix

Live `POST https://www.dagote.ai/api/jev/v1/page-judge`, model `jev-tiny`, AOL mail page context. No API key was in the environment. The host accepted the call and set `authenticated` to false. Full request and response: [`contract-matrix.json`](contract-matrix.json). Request id `09f57797d4df`.

The selector does **not** send the spacer or the inbox row (empty presentation chrome and primary mail chrome are excluded). They are in this request only to measure the host. `capone` and `gam` are the slim blobs `serializeCandidate` + `toJudgeElement` emit (child GAM iframe `src` promoted, hosts set, no HTML dump).

## Result

| Case | Pass bar | Host result | Pass |
|------|----------|-------------|------|
| Capital One ad text (`capone`) | action hide or noul ≥ 0.75 | noul **0.4378**, action **allow** | no |
| GAM promoted src (`gam`) | action hide or noul ≥ 0.75 | noul **0.9948**, action **hide** | yes |
| Empty presentation spacer (`spacer`) | action allow or noul < 0.45 | noul **0.6225**, action **review** | no |
| Real inbox row (`inbox`) | action allow or noul < 0.45 | noul **0.8176**, action **hide** | no |

Each element came back as `{id, noul, action, reason}`. **`kind` was omitted.**

## The host cannot meet the bar on noul alone

Promoted GAM `src` + `srcHost` + `discover: data_ad_row` is stable: several calls in this session scored it hide at noul 0.92–0.99.

Text is not. The same Capital One blob also scored **0.6792 review** earlier in the session, and an inbox row scored **0.5622 review**. An empty `role=presentation` box scored anywhere from **0.50 review** to **0.85 hide** depending on hint text. Adding “not an advertisement” hints made the spacer look more like an ad, not less. jev-tiny’s noul on mail text does not separate a sponsored line from a message, and it does not stay under 0.45 for a blank spacer.

This is not a client pass. The extension does not rewrite those scores.

## Smallest API change

Return `kind` on each element (`ad`, `main_content`, `nav_chrome`, `other`, …), the way the LAN Adgate server already does. Ranks already key off kind. With kind present, a high noul on a mail row stays `main_content` and is not removed, and an ad with a middling noul can still be ranked as `ad` only when its rank says so.

Until that field exists, the client policy is explicit and labeled: missing kind and (host action `hide` or noul ≥ hideMin) uses the **ad** rank for the hide decision only, and the review row says `kind_missing_host`. The selector keeps empty spacers and inbox chrome out of the request so a flaky high noul cannot delete them.
