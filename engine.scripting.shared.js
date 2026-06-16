/* ============================================================
   engine.scripting.shared.js
   Shared mutable state and utilities referenced across all
   scripting sub-modules. Import from here to avoid circular
   dependencies between the scripting split files.
   ============================================================ */

import { state } from './engine.state.js';
export { state };

// ── Scene / global variable stores ───────────────────────────
export const _sceneVars  = {};
export const _globalVars = {};

// ── Tag / group registries ────────────────────────────────────
export const _tagRegistry   = new Map();
export const _groupRegistry = new Map();

// ── Active script instances (populated at runtime) ────────────
export const _instances = [];

// ── Debug draw state ──────────────────────────────────────────
export let _debugGfx   = null;
export const _debugLines = [];
export function _setDebugGfx(v) { _debugGfx = v; }

// ── Internal console logger ───────────────────────────────────
export function _logConsole(msg, color = '#e0e0e0') {
    import('./engine.console.js').then(m => m.engineLog(msg,
        color === '#f87171' ? 'error' :
        color === '#facc15' ? 'warn'  :
        color === '#4ade80' ? 'system': 'log'));
}

// ── Repeat ID counter (used by sandbox timers) ────────────────
export let _repeatIdCounter = 0;
export function _nextRepeatId() { return ++_repeatIdCounter; }

// ── Script compile cache ──────────────────────────────────────
export const _scriptFnCache = new Map();

// ── AABB overlap helper (used by sandbox + runtime) ───────────
export function _getAABB(obj) {
    const hw = (obj.spriteGraphic?.width  ?? obj._bounds?.width  ?? 100) / 2;
    const hh = (obj.spriteGraphic?.height ?? obj._bounds?.height ?? 100) / 2;
    const sx  = Math.abs(obj.scale?.x ?? 1);
    const sy  = Math.abs(obj.scale?.y ?? 1);
    return {
        left:   obj.x - hw * sx,
        right:  obj.x + hw * sx,
        top:    obj.y - hh * sy,
        bottom: obj.y + hh * sy,
    };
}

export function _isOverlapping(objA, objB) {
    if (!objA || !objB) return false;
    const ba = _getAABB(objA);
    const bb = _getAABB(objB);
    return ba.right > bb.left && ba.left < bb.right &&
           ba.bottom > bb.top && ba.top  < bb.bottom;
}

// ── Script safety scanner + error formatter ───────────────────
// Placed here (shared) to break the circular dep between
// engine.scripting.sandbox.js and engine.scripting.runtime.js.

export function _scanScriptForDangers(code, scriptName, objLabel) {
    const prefix  = `[Script "${scriptName}" on "${objLabel}"]`;
    const messages = [];
    let fatal = false;

    const stripped = code
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    const fatalPatterns = [
        { re: /\bdocument\.write\s*\(/,        msg: 'document.write() destroys the engine canvas — use log() to print values instead.' },
        { re: /\bdocument\.body\s*=\s*/,       msg: 'Assigning to document.body will break the engine UI.' },
        { re: /\blocation\s*\.\s*(?:href|replace|assign)\s*=/,
                                                msg: 'Redirecting location.href will leave the engine — use gotoScene() to change scenes.' },
        { re: /\blocation\s*=\s*/,             msg: 'Assigning to location will navigate away from the engine.' },
        { re: /\bdocument\.open\s*\(/,         msg: 'document.open() clears the page — use log() to print output.' },
        { re: /\bwindow\s*\.\s*onload\s*=/,    msg: 'Overwriting window.onload will break engine startup.' },
        { re: /\bwhile\s*\(\s*true\s*\)\s*\{(?!\s*\/\/.*break)/,
                                                msg: 'while(true){} without a break will freeze the engine. Use onUpdate(fn) for repeating logic.' },
        { re: /\bfor\s*\(\s*;;\s*\)\s*\{/,    msg: 'for(;;){} infinite loop will freeze the engine. Use onUpdate(fn) for repeating logic.' },
        { re: /\bdocument\.getElementById\s*\([^)]+\)\s*\.innerHTML\s*=/,
                                                msg: 'Writing innerHTML to engine DOM elements can destroy the UI. Use the engine API instead.' },
        // Constructor/prototype escape attempts
        { re: /\.constructor\s*\.\s*constructor/,
                                                msg: 'constructor.constructor escape attempt detected — this bypasses the sandbox.' },
        { re: /\b__proto__\s*\.\s*constructor/,
                                                msg: '__proto__.constructor escape attempt detected.' },
        { re: /\bglobalThis\b/,               msg: 'globalThis is not available in scripts — use the engine API instead.' },
        // Obfuscated infinite loops that bypass while(true) check
        { re: /while\s*\([^)]*Date\.now[^)]*\)\s*\{/,
                                                msg: 'Timing-based busy loop will freeze the engine. Use wait() or onUpdate() instead.' },
        // IDB/storage wipe attempts — caught by iframe but block as defense-in-depth
        { re: /\bindexedDB\s*\.\s*deleteDatabase\s*\(/,
                                                msg: 'Deleting IndexedDB databases will destroy saved projects.' },
        { re: /\blocalStorage\s*\.\s*clear\s*\(/,
                                                msg: 'localStorage.clear() is not available in scripts.' },
        // UI panel destruction
        { re: /\.innerHTML\s*=\s*['"]{2}|outerHTML\s*=\s*['"]{2}/,
                                                msg: 'Clearing innerHTML/outerHTML on engine panels will destroy the UI.' },
        { re: /\.remove\s*\(\s*\)(?!\s*;?\s*\/\/.*sprite|obj|clone|drawText)/,
                                                msg: 'Calling .remove() on DOM elements may destroy the engine UI. Only use destroySelf() on game objects.' },
        { re: /document\s*\.\s*(?:head|documentElement)\s*\.\s*innerHTML/,
                                                msg: 'Clearing document.head or documentElement will break the engine completely.' },
        // Style/class manipulation on engine elements  
        { re: /document\s*\.\s*getElementById\s*\([^)]+\)\s*\.\s*style\s*\.\s*display\s*=\s*['"]none['"]/,
                                                msg: 'Hiding engine UI elements by ID can break the layout. Use the engine API instead.' },
        // window global clobber
        { re: /\bwindow\s*\.\s*(?:PIXI|planck|state|markDirty|startEngine)\s*=/,
                                                msg: 'Overwriting engine globals (PIXI, planck, state) will crash the engine.' },
        // Recursive cloneSelf without limit
        { re: /function\s+\w+[^}]*cloneSelf[^}]*\w+\s*\([^)]*\)[^}]*}/,
                                                msg: 'Recursive functions that call cloneSelf can hit the clone limit. Add a depth/count guard.' },
    ];

    for (const { re, msg } of fatalPatterns) {
        if (re.test(stripped)) { messages.push(`${prefix} 🚫 BLOCKED — ${msg}`); fatal = true; }
    }

    const warnPatterns = [
        { re: /\bdocument\.querySelector\s*\(/, msg: `Accessing DOM elements directly may interfere with the engine UI. Consider using the engine API instead.` },
        { re: /\bsetInterval\s*\(/,             msg: `setInterval() persists after Play stops. Use repeat(fn, seconds) instead.` },
        { re: /\bsetTimeout\s*\(/,              msg: `setTimeout() may fire after Play stops. Use wait(seconds, fn) instead.` },
        { re: /\bXMLHttpRequest\b|\bfetch\s*\(/, msg: `Network calls may not resolve and can slow play mode. Cache data before pressing Play.` },
        { re: /\bawait\b/,                      msg: `await works inside async functions, but onUpdate(fn) must stay synchronous.` },
        { re: /\bconsole\s*\.\s*log\s*\(/,      msg: `console.log() goes to browser devtools, not the engine console. Use log() instead.` },
        { re: /\balert\s*\(/,                   msg: `alert() pauses the whole browser tab. Use log() to print messages instead.` },
        { re: /\beval\s*\(/,                    msg: `eval() is unsafe and may throw CSP errors. Build logic directly in the script.` },
        { re: /new\s+Function\s*\(/,            msg: `new Function() may be blocked by CSP. Build logic directly in the script.` },
        // Prototype/object manipulation that could corrupt engine state
        { re: /Object\s*\.\s*(?:defineProperty|setPrototypeOf|assign)\s*\([^,]*prototype/,
                                              msg: `Modifying Object prototypes can corrupt engine internals. Only modify your own objects.` },
        { re: /\b__proto__\b/,               msg: `__proto__ access is restricted in scripts — use standard property assignment instead.` },
        // Clone bomb detection
        { re: /for\s*\([^)]*\)\s*\{[^}]*clone(?:Self|Object|InPlace)\s*\(/,
                                              msg: `Spawning clones in a for-loop can hit the 128-clone limit instantly. Use onUpdate + a counter instead.` },
        // Import dynamic module access
        { re: /\bimport\s*\(\s*['\`"][./]/,  msg: `import() of engine modules from scripts is restricted — use the engine API instead.` },
    ];

    for (const { re, msg } of warnPatterns) {
        if (re.test(stripped)) messages.push(`${prefix} ⚠ ${msg}`);
    }

    return { fatal, messages };
}

export function _friendlyScriptError(err, code, scriptName, objLabel, phase) {
    const prefix = `[Script "${scriptName}" on "${objLabel}"] ✖ ${phase} error`;
    const msg    = err?.message ?? String(err);
    const lines  = [`${prefix}: ${msg}`];

    let lineNum = null;
    if (err?.lineNumber) {
        lineNum = err.lineNumber;
    } else if (err?.stack) {
        const m = err.stack.match(/<anonymous>:(\d+)|\bFunction\b[^:]*:(\d+)|\bat eval[^:]*:(\d+)/);
        if (m) lineNum = parseInt(m[1] ?? m[2] ?? m[3], 10);
    }

    const PRELUDE_LINES = 1130;
    if (lineNum != null && lineNum > PRELUDE_LINES) {
        const userLine = lineNum - PRELUDE_LINES;
        lines[0] += ` (your script line ~${userLine})`;
        if (code) {
            const codeLines = code.split('\n');
            if (userLine >= 1 && userLine <= codeLines.length) {
                const srcLine = codeLines[userLine - 1]?.trim();
                if (srcLine) lines.push(`  → ${srcLine}`);
            }
        }
    }

    const hint = _getErrorHint(msg, err?.stack ?? '');
    if (hint) lines.push(`  💡 ${hint}`);
    return lines;
}

function _getErrorHint(msg, stack) {
    const m = msg.toLowerCase();
    if (m.includes('is not defined')) {
        const name = msg.match(/(\w+) is not defined/i)?.[1];
        if (name) {
            const apiNames = ['log','warn','error','gotoScene','spawnObject','destroy','setPos','getPos','walkTo','walkToObject','stopWalking','isWalking',
                'velocityX','velocityY','onStart','onUpdate','onStop','onCollisionEnter','isKeyDown',
                'isKeyJustDown','mouseX','mouseY','sceneVar','globalVar','soundPlay','wait','repeat'];
            const similar = apiNames.find(a => _levenshtein(a.toLowerCase(), name.toLowerCase()) <= 2 && a !== name);
            if (similar) return `Did you mean "${similar}"? Check the API reference (? button in the toolbar).`;
            return `"${name}" hasn't been declared. Check for typos, or declare it with: var ${name} = ...`;
        }
    }
    if (m.includes('cannot read propert') || m.includes("cannot read properties of")) {
        const prop = msg.match(/reading '(\w+)'/i)?.[1];
        if (prop) return `A variable you're reading "${prop}" from is null or undefined. Add a null check: if (obj) obj.${prop}`;
        return 'A variable is null or undefined. Add a null check before accessing its properties.';
    }
    if (m.includes('is not a function')) {
        const name = msg.match(/(\S+) is not a function/i)?.[1];
        if (name) return `"${name}" is not callable. Check the spelling and make sure it's a function, not a variable.`;
    }
    if (m.includes('stack overflow') || m.includes('maximum call stack'))
        return 'A function is calling itself forever (infinite recursion). Make sure recursive calls have an exit condition.';
    if (m.includes('rangeerror') || m.includes('invalid array length'))
        return 'An array or number is out of valid range. Check loops and array indices.';
    if (m.includes('unexpected reserved word') || (m.includes('await') && m.includes('only valid')))
        return 'You used "await" outside an async function. Wrap your code in: async function run() { ... } run();';
    if (m.includes('syntaxerror') || m.includes('unexpected token') || m.includes('unexpected end'))
        return 'The script has a syntax error. Check for missing brackets }, parentheses ), or semicolons.';
    if (m.includes('typeerror') && m.includes('assignment'))
        return 'You tried to assign to a read-only or const value. Use "var" or "let" for your own variables.';
    return null;
}

function _levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

// ── Debug GFX helpers ─────────────────────────────────────────
// (Kept here so both core and runtime can call them without circular imports)

export function _ensureDebugGfx() {
    if (_debugGfx && state.sceneContainer?.children?.includes(_debugGfx)) return _debugGfx;
    if (!window.PIXI || !state.sceneContainer) return null;
    _debugGfx = new window.PIXI.Graphics();
    _debugGfx.zIndex = 9999;
    state.sceneContainer.addChild(_debugGfx);
    _setDebugGfx(_debugGfx);
    return _debugGfx;
}

export function _tickDebugLines(dt) {
    if (_debugLines.length === 0 && !_debugGfx && !window._zeGizmos?.collision) return;
    for (let i = _debugLines.length - 1; i >= 0; i--) {
        _debugLines[i].remaining -= dt;
        if (_debugLines[i].remaining <= 0) _debugLines.splice(i, 1);
    }
    const gfx = _ensureDebugGfx();
    if (!gfx) return;
    gfx.clear();
    for (const l of _debugLines) {
        const c = typeof l.color === 'string' ? parseInt(l.color.replace('#',''), 16) : (l.color ?? 0xffffff);
        gfx.lineStyle(l.width ?? 2, c, l.alpha ?? 0.85);
        gfx.moveTo(l.x1 * 100, -l.y1 * 100);
        gfx.lineTo(l.x2 * 100, -l.y2 * 100);
        if (l.circle) {
            const cx = l.x1 * 100, cy = -l.y1 * 100;
            const r  = l.circle * 100;
            gfx.lineStyle(l.width ?? 2, c, l.alpha ?? 0.85);
            gfx.drawCircle(cx, cy, r);
        }
    }

    if (window._zeGizmos?.collision && state.gameObjects) {
        const colHex = parseInt((window._zeGizmos.collisionColor ?? '#00ffcc').replace('#', ''), 16);
        for (const obj of state.gameObjects) {
            if (!obj || obj.physicsBody === 'none' || !obj.physicsBody) continue;
            const sx = Math.abs(obj.scale?.x ?? 1) || 1;
            const sy = Math.abs(obj.scale?.y ?? 1) || 1;
            const px = obj.x ?? 0;
            const py = obj.y ?? 0;
            const polyMap = obj.physicsPolygons || {};
            const frameId = obj._runtimePhysicsFrameId;
            let poly = null;
            if (frameId && Array.isArray(polyMap[frameId]) && polyMap[frameId].length >= 3) {
                poly = polyMap[frameId];
            } else if (Array.isArray(polyMap.shared) && polyMap.shared.length >= 3) {
                poly = polyMap.shared;
            } else if (Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3) {
                poly = obj.physicsPolygon;
            }
            gfx.lineStyle(1.5, colHex, 0.9);
            if (poly) {
                const rot  = obj.rotation || 0;
                const cosR = Math.cos(rot);
                const sinR = Math.sin(rot);
                const pts = poly.map(p => ({
                    x: px + (p.x * sx) * cosR - (p.y * sy) * sinR,
                    y: py + (p.x * sx) * sinR + (p.y * sy) * cosR,
                }));
                gfx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
                for (const pt of pts) gfx.lineTo(pt.x, pt.y);
            } else {
                import('./engine.collision-overlay.js').then(m => {
                    const g     = m.collisionGeom(obj);
                    const ox    = (g.ox || 0) * sx;
                    const oy    = (g.oy || 0) * sy;
                    const w     = (g.w || 32) * sx;
                    const h     = (g.h || 32) * sy;
                    const shape = obj.physicsShape ?? 'box';
                    const cx    = px + ox;
                    const cy    = py + oy;
                    gfx.lineStyle(1.5, colHex, 0.9);
                    if (shape === 'circle') {
                        gfx.drawCircle(cx, cy, (g.r || Math.min(w, h) / 2) * Math.max(sx, sy));
                    } else {
                        gfx.drawRect(cx - w / 2, cy - h / 2, w, h);
                    }
                }).catch(() => {});
            }
        }
    }
}

export function _clearDebugGfx() {
    _debugLines.length = 0;
    if (_debugGfx) { try { _debugGfx.destroy(); } catch(_) {} _debugGfx = null; _setDebugGfx(null); }
}

// ── clearSceneVars / clearGlobalVars (public exports) ─────────
export function clearSceneVars()  { for (const k in _sceneVars)  delete _sceneVars[k]; }
export function clearGlobalVars() { for (const k in _globalVars) delete _globalVars[k]; }

// ── Registry helpers ──────────────────────────────────────────
export function _registerInstance(inst) {
    const tag   = inst.obj._scriptTag;
    const group = inst.obj._scriptGroup;
    if (tag) {
        if (!_tagRegistry.has(tag))   _tagRegistry.set(tag, new Set());
        _tagRegistry.get(tag).add(inst);
    }
    if (group) {
        if (!_groupRegistry.has(group)) _groupRegistry.set(group, new Set());
        _groupRegistry.get(group).add(inst);
    }
}
export function _clearRegistries() { _tagRegistry.clear(); _groupRegistry.clear(); }

// ── Message bus ───────────────────────────────────────────────
function _deliverMsg(inst, msg, data) {
    const handler = inst._messageHandlers?.get(msg);
    if (!handler) return;
    try { handler(data); }
    catch (e) {
        const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', `onMessage("${msg}")`);
        for (const line of friendly) _logConsole(line, '#f87171');
        import('./engine.console.js').then(m => m.recordPlayError());
    }
}
export function _sendMessageToTag(tag, msg, data)   { const s = _tagRegistry.get(tag);   if (s && s.size) { const [f] = s; _deliverMsg(f, msg, data); } }
export function _broadcastToTag(tag, msg, data)     { const s = _tagRegistry.get(tag);   if (s) for (const i of s) _deliverMsg(i, msg, data); }
export function _broadcastToGroup(grp, msg, data)   { const s = _groupRegistry.get(grp); if (s) for (const i of s) _deliverMsg(i, msg, data); }
export function _broadcastGlobal(msg, data)         { for (const i of _instances) _deliverMsg(i, msg, data); }

// ── Script timer system ───────────────────────────────────────
const _timers = [];
export function _scheduleTimer(seconds, fn, scriptName, objLabel) {
    if (typeof seconds !== 'number' || seconds < 0) seconds = 0;
    _timers.push({ remaining: seconds, fn, scriptName: scriptName ?? 'wait()', objLabel: objLabel ?? '?' });
}
export function _tickTimers(dt) {
    for (let i = _timers.length - 1; i >= 0; i--) {
        _timers[i].remaining -= dt;
        if (_timers[i].remaining <= 0) {
            try { _timers[i].fn(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, _timers[i].scriptName ?? 'wait()', _timers[i].objLabel ?? '?', 'wait timer');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
            _timers.splice(i, 1);
        }
    }
}
export function _clearTimers() { _timers.length = 0; }

// ── Tween easing ──────────────────────────────────────────────
export function _easing(t, name) {
    switch (name) {
        case 'easeIn':       return t * t;
        case 'easeOut':      return 1 - (1 - t) ** 2;
        case 'easeInOut':    return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
        case 'easeInCubic':  return t ** 3;
        case 'easeOutCubic': return 1 - (1 - t) ** 3;
        case 'elastic': {
            if (t === 0 || t === 1) return t;
            return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / 3);
        }
        case 'elasticOut': {
            if (t === 0 || t === 1) return t;
            return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1;
        }
        case 'bounce': {
            const n1 = 7.5625, d1 = 2.75;
            if (t < 1 / d1)       return n1 * t * t;
            if (t < 2 / d1)       { t -= 1.5  / d1; return n1 * t * t + 0.75; }
            if (t < 2.5 / d1)     { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
            t -= 2.625 / d1;      return n1 * t * t + 0.984375;
        }
        case 'steps2':  return Math.round(t * 2) / 2;
        case 'steps4':  return Math.round(t * 4) / 4;
        case 'linear':
        default:        return t;
    }
}
export function _applyTweenProp(api, key, v) {
    switch (key) {
        case 'x':        api.x        = v; break;
        case 'y':        api.y        = v; break;
        case 'alpha':    api.alpha    = v; break;
        case 'scaleX':   api.scaleX   = v; break;
        case 'scaleY':   api.scaleY   = v; break;
        case 'rotation': api.rotation = v; break;
        case 'scale':    api.scaleX   = v; api.scaleY = v; break;
    }
}

// ── Camera ────────────────────────────────────────────────────
const _cameraShake = { amplitude: 0, duration: 0, elapsed: 0 };
export const _camera = {
    _followTarget: null,
    _smoothing:    6,
    follow(target, smoothing = 6) { this._followTarget = target; this._smoothing = smoothing; },
    unfollow() { this._followTarget = null; },
    moveTo(wx, wy) {
        this._followTarget = null;
        if (!state.sceneContainer) return;
        const sc    = state.sceneContainer;
        const scale = sc.scale.x;
        sc.x = window.innerWidth  / 2 - wx * 100 * scale;
        sc.y = window.innerHeight / 2 + wy * 100 * scale;
    },
    get x() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (window.innerWidth / 2 - sc.x) / (sc.scale.x * 100);
    },
    get y() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (sc.y - window.innerHeight / 2) / (sc.scale.y * 100);
    },
    shake(amplitude = 0.2, duration = 0.3) {
        _cameraShake.amplitude = amplitude;
        _cameraShake.duration  = duration;
        _cameraShake.elapsed   = 0;
    },
    /**
     * Camera FOV — simulated via zoom (scale).
     * A smaller FOV zooms IN (narrower view, objects appear larger).
     * A larger FOV zooms OUT (wider view, objects appear smaller).
     * Default FOV is 90 degrees (matches the default 1280×720 view).
     *
     *   camera.fov = 60    // zoom in (telephoto feel)
     *   camera.fov = 120   // zoom out (wide angle feel)
     *   camera.fov         // get current FOV
     */
    get fov() {
        if (!state.sceneContainer) return 90;
        // Base scale = fit scale for the current game dimensions
        const sw = window.innerWidth;
        const sh = window.innerHeight;
        const gw = state.sceneSettings?.gameWidth  ?? 1280;
        const gh = state.sceneSettings?.gameHeight ?? 720;
        const baseScale = Math.min(sw / gw, sh / gh);
        const curScale  = state.sceneContainer.scale.x;
        // FOV 90 = base scale; scaling relationship: fov ∝ 1/scale
        return 90 * (baseScale / curScale);
    },
    set fov(degrees) {
        if (!state.sceneContainer) return;
        const fov = Math.max(10, Math.min(170, degrees));
        const sw = window.innerWidth;
        const sh = window.innerHeight;
        const gw = state.sceneSettings?.gameWidth  ?? 1280;
        const gh = state.sceneSettings?.gameHeight ?? 720;
        const baseScale = Math.min(sw / gw, sh / gh);
        // newScale = baseScale * (90 / fov)
        const newScale = baseScale * (90 / fov);
        state.sceneContainer.scale.set(newScale);
        import('./engine.playmode.js').then(m => m.updateSceneMask?.());
    },
    /**
     * Smoothly tween the camera FOV over time.
     *   camera.zoomTo(60, 1.0)   // zoom to FOV 60 over 1 second
     *   camera.zoomTo(90, 0.5)   // restore default over 0.5 seconds
     */
    zoomTo(targetFov, duration = 0.5) {
        const startFov  = this.fov;
        const startTime = performance.now() / 1000;
        const cam = this;
        const tick = () => {
            if (!state.isPlaying) return;
            const t = Math.min(1, (performance.now() / 1000 - startTime) / Math.max(0.001, duration));
            const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
            cam.fov = startFov + (targetFov - startFov) * eased;
            if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    },
};
export function _updateCamera(dt) {
    if (!state.sceneContainer || !state.isPlaying) return;
    const sc    = state.sceneContainer;
    const scale = sc.scale.x;
    if (_camera._followTarget) {
        const t  = _camera._followTarget;
        const tx = window.innerWidth  / 2 - (t._ref ? t._ref.x : t.x * 100) * scale;
        const ty = window.innerHeight / 2 - (t._ref ? t._ref.y : t.y * -100) * scale;
        const sm = Math.max(0, Math.min(1, _camera._smoothing * dt));
        sc.x += (tx - sc.x) * sm;
        sc.y += (ty - sc.y) * sm;
    }
    if (_cameraShake.elapsed < _cameraShake.duration) {
        _cameraShake.elapsed += dt;
        const t   = _cameraShake.elapsed / _cameraShake.duration;
        const amp = _cameraShake.amplitude * (1 - t) * 100 * scale;
        sc.x += (Math.random() - 0.5) * amp;
        sc.y += (Math.random() - 0.5) * amp;
    }
}

// ── ScriptInstance factory (registered by engine.scripting.runtime.js) ──
// Breaks the circular dependency: sandbox.js needs to construct
// ScriptInstance objects (for spawnObject/cloneSelf/cloneObject
// auto-start), but ScriptInstance itself lives in runtime.js, which
// imports sandbox.js. runtime.js calls _registerScriptInstanceClass()
// once at module load; sandbox.js calls _newScriptInstance() lazily.
let _ScriptInstanceClass = null;
export function _registerScriptInstanceClass(cls) { _ScriptInstanceClass = cls; }
export function _newScriptInstance(obj, name, code) {
    if (!_ScriptInstanceClass) throw new Error('ScriptInstance class not registered yet');
    return new _ScriptInstanceClass(obj, name, code);
}

// ── Script CRUD core (moved here so runtime.js/sandbox.js can call
//    getScript()/saveScript() without a circular import on
//    engine.scripting.js, which re-exports these for the public API
//    and UI panel). ─────────────────────────────────────────────
export function getScript(name) {
    return state.scripts.find(s => s.name === name) ?? null;
}

export function saveScript(name, code) {
    const existing = state.scripts.find(s => s.name === name);
    if (existing) {
        existing.code      = code;
        existing.updatedAt = Date.now();
    } else {
        state.scripts.push({
            id: 'script_' + Date.now() + '_' + Math.random().toString(36).slice(2),
            name, code, updatedAt: Date.now(),
        });
    }
    // Refresh the script panel UI if it's mounted (avoids importing
    // engine.scripting.js from here, which would be circular).
    import('./engine.scripting.js').then(m => m.refreshScriptPanel()).catch(() => {});
    import('./engine.persist.js').then(m => m.markDirty()).catch(() => {});
}
