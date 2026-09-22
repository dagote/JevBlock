/**
 * Single-flight helpers for page-judge fetches.
 *
 * Service worker: importScripts('page-judge-flight.js')
 * Node tests: require('./page-judge-flight.js')
 *
 * Chrome MV3 evaluates importScripts in the same global lexical scope as the
 * service worker. Top-level const/function here would collide with background.js
 * (SyntaxError: Identifier already been declared) and would throw again if the
 * worker re-imports the script. Keep every binding inside the factory.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AdgatePageJudgeFlight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PAGE_JUDGE_TIMEOUT_MS = 900000; // 15 minutes — CPU JEV can take minutes for ~24 elements

  function createPageJudgeFlight(timeoutMs = PAGE_JUDGE_TIMEOUT_MS) {
    let gen = 0;
    let controller = null;
    let activeTimer = null;

    return {
      timeoutMs,
      /** True while a fetch started by begin() has not yet called done(). */
      get inFlight() {
        return controller != null;
      },
      get generation() {
        return gen;
      },
      /**
       * Start a new flight. Aborts any previous in-flight fetch so Extreme
       * boot/mutation storms cannot run parallel /v1/page-judge requests.
       */
      begin() {
        gen += 1;
        if (activeTimer != null) {
          clearTimeout(activeTimer);
          activeTimer = null;
        }
        if (controller) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }
        const myController = new AbortController();
        controller = myController;
        const myGen = gen;
        activeTimer = setTimeout(() => {
          try {
            myController.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs);
        const timer = activeTimer;
        return {
          gen: myGen,
          signal: myController.signal,
          isCurrent() {
            return gen === myGen;
          },
          done() {
            if (activeTimer === timer) {
              clearTimeout(activeTimer);
              activeTimer = null;
            }
            if (controller === myController) controller = null;
          },
        };
      },
    };
  }

  return { PAGE_JUDGE_TIMEOUT_MS, createPageJudgeFlight };
});
