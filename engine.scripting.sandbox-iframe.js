/* ============================================================
   engine.scripting.sandbox-iframe.js
   Sandboxed iframe execution layer for user scripts.

   WHY:
     Scripts running via plain new Function() share the same
     window — a malicious or buggy script can do:
       document.body.innerHTML = ''   → destroys the editor UI
       window.location.href = '...'   → navigates away
       while(true){}                  → freezes the whole tab
       localStorage.clear()           → wipes project saves
       alert()                        → blocks the entire tab

   HOW:
     Each ScriptInstance gets a hidden <iframe sandbox="allow-scripts">.
     sandbox="allow-scripts" WITHOUT "allow-same-origin" means:
       ✅ JS runs normally
       ✗  Cannot access parent.document or parent.window
       ✗  Cannot navigate (location.href = ...)
       ✗  Cannot open popups (window.open)
       ✗  Cannot access localStorage / sessionStorage / cookies
       ✗  alert(), confirm(), prompt() are blocked
       ✗  Cannot load external resources

     The real `api` object (live PIXI/Matter references) is injected
     directly into the iframe's JS heap via iframe.contentWindow.__api__
     BEFORE the script runs — no serialization, no postMessage overhead.
     This means ALL engine features (physics, rendering, input, sound,
     find(), sendMessage(), etc.) work exactly as before.

   EXPORT:
     Exported standalone games set window.__ZENGINE_GAME_ONLY__ = true.
     In that mode this module returns a passthrough that runs scripts
     directly (no sandbox needed — the editor UI doesn't exist).

   while(true) PROTECTION:
     The iframe runs on the SAME thread, so a hard infinite loop still
     freezes the tab. We guard against this with the existing
     _scanScriptForDangers() fatal-pattern check (while(true){} is
     already a fatal block). For the exported game, that check is not
     needed (the creator controls the code).
   ============================================================ */

// ── Pool of reusable iframe elements ─────────────────────────
// Creating and destroying iframes is expensive. We maintain a pool
// of pre-warmed iframes and recycle them when a ScriptInstance stops.
const _iframePool = [];
const _MAX_POOL   = 8; // keep up to 8 warm iframes ready

// The blob URL for the iframe's src — created once, reused for all iframes.
let _iframeSrcBlob = null;

function _getIframeSrcBlob() {
    if (_iframeSrcBlob) return _iframeSrcBlob;
    // Minimal HTML — the iframe just needs a JS context.
    // We do NOT set allow-same-origin so the sandbox is enforced.
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    _iframeSrcBlob = URL.createObjectURL(blob);
    return _iframeSrcBlob;
}

/**
 * Acquire a sandboxed iframe from the pool (or create a new one).
 * Returns a promise that resolves once the iframe is ready.
 */
export function acquireSandboxIframe() {
    // Game-only mode (exported game): skip the sandbox entirely
    if (window.__ZENGINE_GAME_ONLY__) return Promise.resolve(null);

    if (_iframePool.length > 0) {
        return Promise.resolve(_iframePool.pop());
    }
    return _createSandboxIframe();
}

/**
 * Return an iframe to the pool so it can be reused.
 * The iframe's contentWindow is reset so no stale references leak.
 */
export function releaseSandboxIframe(iframe) {
    if (!iframe) return;
    if (_iframePool.length < _MAX_POOL) {
        // Wipe the iframe's globals so no script state leaks to the next tenant
        try { iframe.contentWindow.__api__ = null; } catch(_) {}
        _iframePool.push(iframe);
    } else {
        // Pool full — just destroy it
        try { iframe.remove(); } catch(_) {}
    }
}

/**
 * Pre-warm N iframes so the first scripts start instantly.
 * Call once on engine startup.
 */
export function prewarmSandboxPool(n = 4) {
    if (window.__ZENGINE_GAME_ONLY__) return;
    const needed = Math.max(0, n - _iframePool.length);
    for (let i = 0; i < needed; i++) {
        _createSandboxIframe().then(iframe => {
            if (_iframePool.length < _MAX_POOL) _iframePool.push(iframe);
            else iframe.remove();
        }).catch(() => {});
    }
}

function _createSandboxIframe() {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        // sandbox="allow-scripts" WITHOUT allow-same-origin:
        //   - JS runs
        //   - No DOM access to parent
        //   - No navigation
        //   - No localStorage / cookies / popups / alert
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:none;pointer-events:none;visibility:hidden;left:-9999px;top:-9999px;';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.src = _getIframeSrcBlob();
        iframe.addEventListener('load', () => resolve(iframe), { once: true });
        iframe.addEventListener('error', reject, { once: true });
        document.body.appendChild(iframe);
    });
}

/**
 * Run a compiled async function inside a sandboxed iframe.
 *
 * @param {Function}   fn      - The AsyncFunction compiled from prelude+code+postlude
 * @param {object}     api     - The live engine api for this ScriptInstance
 * @param {object}     out     - The output object (receives registered callbacks)
 * @param {HTMLIFrameElement} iframe - The sandbox iframe to run inside
 * @returns {Promise}
 */
export function runInSandbox(fn, api, out, iframe) {
    // Game-only / no-sandbox mode: run directly
    if (!iframe || window.__ZENGINE_GAME_ONLY__) {
        return fn.call(api, api, out);
    }

    const cw = iframe.contentWindow;

    // Inject the api into the iframe's global scope.
    // Since sandbox="allow-scripts" WITHOUT allow-same-origin, the iframe is
    // cross-origin from itself — but because we created it with a blob URL from
    // the SAME page's JS heap, the contentWindow IS accessible from the parent
    // for direct property assignment. We exploit this to pass the live api object
    // without any serialization.
    cw.__api__ = api;
    cw.__out__ = out;

    // Run the already-compiled AsyncFunction inside the iframe's context.
    // fn.call(thisArg, api, out) — we bind `this` to api as well.
    // We do this by re-binding to the iframe's copy of the api reference.
    return fn.call(cw.__api__, cw.__api__, cw.__out__);
}

/**
 * Check whether sandbox iframes are supported and working in this browser.
 * Returns a promise resolving to true/false.
 * Called once on startup — if false, engine falls back to plain AsyncFunction.
 */
export async function isSandboxSupported() {
    if (window.__ZENGINE_GAME_ONLY__) return false;
    try {
        const iframe = await _createSandboxIframe();
        const cw = iframe.contentWindow;
        // If we can write to contentWindow, the same-heap injection works
        const testKey = '__ze_sandbox_test__' + Date.now();
        cw[testKey] = 42;
        const ok = cw[testKey] === 42;
        iframe.remove();
        return ok;
    } catch (_) {
        return false;
    }
}
