/* ============================================================
   Zengine — engine.transitions.js
   Scene transition visual effects for gotoScene() calls.

   Supported transition names:
     "fade"        — fade to black, switch scene, fade from black
     "fadewhite"   — fade to white, switch scene, fade from white
     "slide-left"  — wipe left using a colour panel
     "slide-right" — wipe right using a colour panel
     "zoom"        — zoom-blur punch into black, switch, expand out
     "circle"      — iris-close (circle shrinks to black), iris-open

   Usage in scripts:
     gotoScene("Level2")                  — instant switch
     gotoScene("Level2", "fade")          — fade (0.5 s default)
     gotoScene("Level2", "fade", 1.2)     — fade, 1.2 s total
     gotoScene("Level2", "slide-left")
     gotoScene("Level2", "slide-right")
     gotoScene("Level2", "zoom")
     gotoScene("Level2", "circle")
   ============================================================ */

import { state } from './engine.state.js';

let _overlay    = null;
let _canvas     = null;          // used by circle transition
let _animHandle = null;

// ── Overlay element (shared, reused) ──────────────────────────
function _ensureOverlay(color = '#000') {
    if (_overlay && _overlay.isConnected) {
        _overlay.style.cssText = [
            'position:fixed','inset:0','z-index:99998',
            'pointer-events:none',`background:${color}`,
            'will-change:opacity,transform','opacity:0',
            'transform:none',
        ].join(';');
        return _overlay;
    }
    _overlay = document.createElement('div');
    _overlay.id = 'zen-transition-overlay';
    _overlay.style.cssText = [
        'position:fixed','inset:0','z-index:99998',
        'pointer-events:none','opacity:0',
        `background:${color}`,'will-change:opacity,transform',
    ].join(';');
    document.body.appendChild(_overlay);
    return _overlay;
}

function _stopAnim() {
    if (_animHandle) { cancelAnimationFrame(_animHandle); _animHandle = null; }
}

// ── rAF-based eased animation ─────────────────────────────────
function _animValue(from, to, duration, applyFn, easeFn) {
    _stopAnim();
    return new Promise(resolve => {
        const start = performance.now();
        const ease  = easeFn ?? (t => t < 0.5 ? 2*t*t : 1 - 2*(1-t)**2);
        function tick() {
            const raw = Math.min((performance.now() - start) / (duration * 1000), 1);
            applyFn(from + (to - from) * ease(raw), raw);
            if (raw < 1) {
                _animHandle = requestAnimationFrame(tick);
            } else {
                _animHandle = null;
                resolve();
            }
        }
        _animHandle = requestAnimationFrame(tick);
    });
}

// ── Individual animation helpers ──────────────────────────────

/** Fade overlay opacity from→to */
function _animOpacity(from, to, dur, color = '#000') {
    const ov = _ensureOverlay(color);
    ov.style.opacity = String(from);
    ov.style.transform = 'none';
    return _animValue(from, to, dur, v => { ov.style.opacity = String(v); });
}

/** Slide the overlay panel in/out (translateX) */
function _animSlideOverlay(fromX, toX, dur, color = '#000') {
    const ov = _ensureOverlay(color);
    ov.style.opacity  = '1';
    ov.style.transform = `translateX(${fromX}px)`;
    return _animValue(fromX, toX, dur, v => {
        ov.style.transform = `translateX(${v}px)`;
    });
}

/** Zoom overlay opacity + scaleContainer */
function _animZoom(fromScale, toScale, fromAlpha, toAlpha, dur) {
    const ov  = _ensureOverlay('#000');
    const sc  = state.sceneContainer;
    // snapshot the current base scale once
    const bsX = sc?.scale.x ?? 1;
    const bsY = sc?.scale.y ?? 1;
    ov.style.opacity  = String(fromAlpha);
    ov.style.transform = 'none';
    return _animValue(0, 1, dur, (_, t) => {
        const ease  = t < 0.5 ? 2*t*t : 1-2*(1-t)**2;
        ov.style.opacity = String(fromAlpha + (toAlpha - fromAlpha) * ease);
        if (sc) {
            const s = fromScale + (toScale - fromScale) * ease;
            sc.scale.set(bsX * s, bsY * s);
        }
    });
}

/** Canvas-based iris circle (circle shrinks/grows) */
function _ensureCircleCanvas() {
    if (_canvas && _canvas.isConnected) return _canvas;
    _canvas = document.createElement('canvas');
    _canvas.id = 'zen-transition-circle';
    _canvas.style.cssText = 'position:fixed;inset:0;z-index:99998;pointer-events:none;';
    document.body.appendChild(_canvas);
    return _canvas;
}

function _animCircle(fromR, toR, dur) {
    const cv  = _ensureCircleCanvas();
    const W   = window.innerWidth;
    const H   = window.innerHeight;
    cv.width  = W;
    cv.height = H;
    const cx  = W / 2;
    const cy  = H / 2;
    const maxR = Math.hypot(cx, cy) * 1.05; // just enough to cover corners

    return _animValue(fromR, toR, dur, v => {
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        const r = v * maxR;
        // Fill everything black, then punch a transparent circle
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2, true); // cut-out (counter-clockwise)
        ctx.fill('evenodd');
    });
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Play the EXIT half of a transition (current scene disappears into colour).
 * @param {string} type      Transition name
 * @param {number} duration  Total transition duration (seconds). Half is used here.
 */
export async function transitionOut(type = 'fade', duration = 0.5) {
    const half = duration / 2;
    switch (type) {
        case 'fadewhite':
            return _animOpacity(0, 1, half, '#fff');
        case 'slide-left':
            // Panel enters from the right, sweeps LEFT to cover the screen
            return _animSlideOverlay(window.innerWidth, 0, half);
        case 'slide-right':
            // Panel enters from the left, sweeps RIGHT to cover the screen
            return _animSlideOverlay(-window.innerWidth, 0, half);
        case 'zoom':
            return _animZoom(1, 1.15, 0, 1, half);
        case 'circle':
            return _animCircle(1, 0, half);  // iris closes (radius 1→0)
        case 'fade':
        default:
            return _animOpacity(0, 1, half, '#000');
    }
}

/**
 * Play the ENTRANCE half of a transition (new scene reveals from colour).
 * @param {string} type      Transition name (same as transitionOut)
 * @param {number} duration  Total transition duration (seconds). Half is used here.
 */
export async function transitionIn(type = 'fade', duration = 0.5) {
    const half = duration / 2;
    switch (type) {
        case 'fadewhite':
            return _animOpacity(1, 0, half, '#fff').then(cleanupTransitions);
        case 'slide-left':
            // Panel slides OFF to the LEFT, revealing new scene
            return _animSlideOverlay(0, -window.innerWidth, half).then(cleanupTransitions);
        case 'slide-right':
            // Panel slides OFF to the RIGHT, revealing new scene
            return _animSlideOverlay(0, window.innerWidth, half).then(cleanupTransitions);
        case 'zoom': {
            // Restore scale first (it may have been left at 1.15× from the out-half)
            const sc  = state.sceneContainer;
            const bsX = sc?.scale.x ?? 1;
            const bsY = sc?.scale.y ?? 1;
            if (sc) sc.scale.set(bsX * 0.85, bsY * 0.85);
            return _animZoom(0.85, 1, 1, 0, half).then(cleanupTransitions);
        }
        case 'circle':
            return _animCircle(0, 1, half).then(cleanupTransitions); // iris opens (0→1)
        case 'fade':
        default:
            return _animOpacity(1, 0, half, '#000').then(cleanupTransitions);
    }
}

/**
 * Remove ALL transition graphics and stop any running animation.
 * Called automatically after transition-in, and on stopPlayMode.
 */
export function cleanupTransitions() {
    _stopAnim();
    if (_overlay) { _overlay.remove(); _overlay = null; }
    if (_canvas)  { _canvas.remove();  _canvas  = null; }
    // Restore sceneContainer scale if zoom left it modified
    const sc = state.sceneContainer;
    if (sc) {
        const bsX = sc.scale.x;
        const bsY = sc.scale.y;
        // If scale differs from an integer multiple of a clean base, snap it back
        // by importing playmode and calling its resize handler
        import('./engine.playmode.js').then(m => m.updateSceneMask?.());
    }
}
