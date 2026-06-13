/* ============================================================
   engine.scripting.linter.js
   Live as-you-type error detection for the script editor.
   Godot-style: red squiggles, gutter dots, human-readable
   messages, fix suggestions, and runtime error → editor jump.
   ============================================================ */

// ── Full API surface the prelude exposes ─────────────────────
const API_NAMES = new Set([
    "onStart","onUpdate","onStop","onDestroy","onCloneStart",
    "onCollisionEnter","onCollisionStay","onCollisionExit",
    "onOverlapEnter","onOverlapExit","onBecomeVisible","onBecomeHidden",
    "onMouseClick","onMouseEnter","onMouseLeave","onMessage",
    "onDamage","onDeath","onHeal","onLand","onJump",
    "onScreenExit","onScreenEnter","onReload",
    "onStateEnter","onStateExit","onKeyDown","onKeyUp",
    "onSwipe","onTap","onPinch",
    "getX","setX","getY","setY","move","moveTo","moveForward","lookAt","flipX","flipY",
    "walkTo","walkToObject","stopWalking","pursue","flee","wander",
    "canSee","lastKnownPos","inFOV",
    "velocityX","velocityY","vx","vy",
    "setVelocity","stopMovement","bounceX","bounceY","addImpulse",
    "getRotation","setRotation","lockRotation","unlockRotation","setRotationLocked",
    "getScaleX","setScaleX","getScaleY","setScaleY",
    "show","hide","setVisible","getVisible","getAlpha","setAlpha","fadeIn","fadeOut",
    "setTag","getTag","setGroup","getGroup",
    "sendMessage","sendMessageToTag","broadcast","broadcastGroup","broadcastAll","broadcastMessage",
    "find","findWithTag","findAllWithTag","findAllInGroup",
    "overlaps","overlapsTag","overlapsAllWithTag",
    "destroySelf","destroyObject","destroy","destroyAfter",
    "gotoScene","pauseScene","resumeScene","restartScene",
    "currentScene","currentSceneIndex","sceneCount","getSceneName",
    "cameraFollow","cameraUnfollow","cameraMoveTo","getCameraX","getCameraY","cameraShake",
    "playAnimation","stopAnimation","pauseAnimation","currentAnimation","isPlayingAnimation",
    "isKeyDown","isKeyJustDown","isKeyJustUp","axisH","axisV",
    "mouseX","mouseY","screenMouseX","screenMouseY","mouseDown","mouseJustDown",
    "getTouches","touchCount","isTouching","touchJustStarted",
    "makeDraggable","dragObject","stopDrag","isDragging","makeThrowable","throwObject",
    "createJoystick","destroyAllJoysticks",
    "getTime","wait","repeat","cancelRepeat","onceAfter","forever",
    "spawnObject","cloneSelf","cloneObject","cloneInPlace","spawnCopy",
    "isClone","getCloneId",
    "raycast","raycastAll","raycastFromSelf","getObjectsInRadius",
    "setZOrder","getZOrder","screenToWorld","worldToScreen",
    "soundPlay","soundStop","soundStopAll",
    "setHealth","getHealth","setMaxHealth","getMaxHealth",
    "takeDamage","heal","isDead","invincible","isInvincible",
    "setAmmo","getAmmo","setMaxAmmo","getMaxAmmo","reload",
    "setState","getState","triggerJump",
    "applyForce","applyImpulse","setPhysicsVelocity","setAngularVelocity","applyAngularImpulse",
    "getVelX","getVelY","stopPhysics","setImmovable","isOnGround","isOnCeiling","isOnWall",
    "setPhysicsType","setCollision","setSensor","setCollisionCategory","setCollisionMask",
    "setGravityScale",
    "setTint","getTint","clearTint",
    "distanceTo","inRangeOf",
    "lerp","clamp","dist","rand","randInt","pick","chance","sign","toRad","toDeg",
    "mapRange","wrap","sin","cos","tan","abs","sqrt","pow","atan2","floor","ceil","round",
    "max","min","PI","smoothstep","normalize","angleTo",
    "log","warn","error",
    "drawDebugLine","drawDebugCircle",
    "tween","trackTarget","hitFlash","objectShake","boundsClamp","offScreen",
    "sceneVar","globalVar","GameSave","store","opts","sceneSettings","physics","math","input",
    "self","Key","Mouse","Gizmos","isWalking","isStuck",
    "screenToWorld","worldToScreen",
    "say","think","showChat","hideChat","chatSay","chatPlayer","aiChat",
    "drawText","selfName","setPhysicsType",
]);

// Known JS globals we should NOT flag as unknown
const JS_GLOBALS = new Set([
    "var","let","const","function","return","if","else","for","while","do",
    "break","continue","switch","case","default","new","typeof","instanceof",
    "true","false","null","undefined","NaN","Infinity","void","delete","in","of",
    "try","catch","finally","throw","class","extends","super","import","export",
    "async","await","yield","this","arguments","with","debugger","get","set","static",
    "Math","Number","String","Boolean","Array","Object","JSON","Promise","Date","RegExp",
    "Error","Map","Set","WeakMap","WeakSet","Symbol","Proxy","Reflect","console",
    "setTimeout","clearTimeout","setInterval","clearInterval","requestAnimationFrame",
    "parseInt","parseFloat","isNaN","isFinite","encodeURI","decodeURI",
    "encodeURIComponent","decodeURIComponent","structuredClone",
    "window","document","location","navigator","history","screen",
    "performance","crypto","URL","URLSearchParams","fetch","XMLHttpRequest",
    "Event","CustomEvent","EventTarget","AbortController","AbortSignal",
    "HTMLElement","Element","Node","NodeList","DocumentFragment",
    "alert","confirm","prompt","open","close","print",
    "dt", "other", "amount", "source", "data", "newState", "prevState",
    "oldState", "nextState", "scale", "dir", "id", "name", "tag", "src",
    "score","speed","health","damage","lives","level","timer","count",
    "joy","c","e","i","j","k","x","y","z","t","n","v","s","r","a","b",
    "obj","go","hit","key","val","msg","cb","fn","result","target","proxy",
    "input","output","value","index","length","size","width","height",
]);

// API functions with their expected argument count ranges [min, max]
const API_SIGNATURES = {
    "move":           [2, 2],
    "moveTo":         [2, 2],
    "setX":           [1, 1],
    "setY":           [1, 1],
    "setVelocity":    [2, 2],
    "setRotation":    [1, 1],
    "setScaleX":      [1, 1],
    "setScaleY":      [1, 1],
    "setAlpha":       [1, 1],
    "setVisible":     [1, 1],
    "setTag":         [1, 1],
    "setGroup":       [1, 1],
    "lookAt":         [2, 2],
    "distanceTo":     [1, 2],
    "lerp":           [3, 3],
    "clamp":          [3, 3],
    "dist":           [4, 4],
    "wait":           [2, 2],
    "repeat":         [2, 2],
    "find":           [1, 1],
    "findWithTag":    [1, 1],
    "gotoScene":      [1, 2],
    "soundPlay":      [1, 2],
    "soundStop":      [1, 1],
    "cameraFollow":   [1, 2],
    "cameraShake":    [2, 2],
    "sendMessage":    [2, 3],
    "walkTo":         [2, 3],
    "setState":       [1, 1],
    "getState":       [0, 0],
    "takeDamage":     [1, 2],
    "setHealth":      [1, 1],
    "setMaxHealth":   [1, 1],
    "setAmmo":        [1, 1],
    "setMaxAmmo":     [1, 1],
    "inRangeOf":      [2, 2],
    "inFOV":          [2, 3],
    "applyForce":     [2, 2],
    "applyImpulse":   [2, 2],
    "setPhysicsVelocity": [2, 2],
    "setAngularVelocity": [1, 1],
    "spawnObject":    [3, 4],
    "cloneSelf":      [2, 3],
    "cloneObject":    [3, 4],
    "rand":           [2, 2],
    "randInt":        [2, 2],
    "moveForward":    [1, 1],
    "cameraMoveTo":   [2, 2],
    "hitFlash":       [0, 2],
    "objectShake":    [0, 2],
    "screenToWorld":  [2, 2],
    "worldToScreen":  [2, 2],
    "raycast":        [4, 5],
    "raycastAll":     [4, 5],
    "raycastFromSelf":[2, 3],
    "setPhysicsType": [1, 1],
    "setCollision":   [1, 1],
    "tween":          [2, 4],
    "setTint":        [1, 1],
    "onStart":        [1, 1],
    "onUpdate":       [1, 1],
    "onStop":         [1, 1],
    "onDestroy":      [1, 1],
    "onCloneStart":   [1, 1],
    "onCollisionEnter":[1, 1],
    "onCollisionStay":[1, 1],
    "onCollisionExit":[1, 1],
    "onOverlapEnter": [1, 1],
    "onOverlapExit":  [1, 1],
    "onMouseClick":   [1, 1],
    "onMouseEnter":   [1, 1],
    "onMouseLeave":   [1, 1],
    "onMessage":      [2, 2],
    "onDamage":       [1, 1],
    "onDeath":        [1, 1],
    "onHeal":         [1, 1],
    "onLand":         [1, 1],
    "onJump":         [1, 1],
    "onScreenExit":   [1, 1],
    "onScreenEnter":  [1, 1],
    "onReload":       [1, 1],
    "onStateEnter":   [2, 2],
    "onStateExit":    [2, 2],
    "onKeyDown":      [2, 2],
    "onKeyUp":        [2, 2],
    "onSwipe":        [2, 2],
    "onTap":          [1, 1],
    "onPinch":        [1, 1],
    "forever":        [1, 1],
};

// Human-readable fix messages
const FIX_HINTS = {
    "move":       "move() needs 2 arguments: move(dx, dy) — e.g. move(3 * dt, 0)",
    "moveTo":     "moveTo() needs 2 arguments: moveTo(x, y)",
    "setVelocity":"setVelocity() needs 2 arguments: setVelocity(vx, vy)",
    "lerp":       "lerp() needs 3 arguments: lerp(a, b, t) — e.g. lerp(x, targetX, 0.1)",
    "clamp":      "clamp() needs 3 arguments: clamp(value, min, max)",
    "dist":       "dist() needs 4 arguments: dist(x1, y1, x2, y2)",
    "wait":       "wait() needs 2 arguments: wait(seconds, () => { ... })",
    "repeat":     "repeat() needs 2 arguments: repeat(intervalSeconds, () => { ... })",
    "find":       "find() needs a name string: find(\"PlayerName\")",
    "sendMessage":"sendMessage() needs at least 2 args: sendMessage(\"tag\", \"message\") or sendMessage(\"tag\", \"message\", data)",
    "walkTo":     "walkTo() needs x and y: walkTo(5, 3) or walkTo(5, 3, { speed: 4 })",
    "takeDamage": "takeDamage() needs an amount: takeDamage(10)",
    "spawnObject":"spawnObject() needs name, x, y: spawnObject(\"Bullet\", x, y)",
    "cloneSelf":  "cloneSelf() needs x, y: cloneSelf(getX(), getY())",
    "rand":       "rand() needs min and max: rand(0, 10)",
    "raycast":    "raycast() needs 4 points: raycast(x1, y1, x2, y2)",
    "tween":      "tween() needs a properties object and duration: tween({ alpha: 0 }, 0.5)",
    "onMessage":  "onMessage() needs a message name and callback: onMessage(\"takeDamage\", (amount) => { })",
    "onStateEnter":"onStateEnter() needs a state name and callback: onStateEnter(\"idle\", () => { })",
    "onStateExit":"onStateExit() needs a state name and callback: onStateExit(\"idle\", () => { })",
    "onKeyDown":  "onKeyDown() needs a key and callback: onKeyDown(\"Space\", () => { })",
    "onKeyUp":    "onKeyUp() needs a key and callback: onKeyUp(\"Space\", () => { })",
    "onSwipe":    "onSwipe() needs a direction and callback: onSwipe(\"left\", () => { })",
    "inFOV":      "inFOV() needs target, degrees, range: inFOV(\"player\", 90, 6)",
    "cameraShake":"cameraShake() needs amplitude and duration: cameraShake(0.3, 0.5)",
};

// Common misspellings / wrong names → suggestions
const TYPO_MAP = {
    "onstart":"onStart","onupdate":"onUpdate","onstop":"onStop",
    "ondestroy":"onDestroy","onclonestart":"onCloneStart",
    "oncollision":"onCollisionEnter","oncollisionenter":"onCollisionEnter",
    "oncollisionstay":"onCollisionStay","oncollisionexit":"onCollisionExit",
    "onoverlap":"onOverlapEnter","onoverlapenter":"onOverlapEnter",
    "onoverlapleave":"onOverlapExit","onoverlaplexit":"onOverlapExit",
    "onclick":"onMouseClick","onmouseclick":"onMouseClick",
    "onmouseenter":"onMouseEnter","onmouseleave":"onMouseLeave",
    "onmessage":"onMessage","onmsg":"onMessage",
    "ondamage":"onDamage","ondeath":"onDeath","onheal":"onHeal",
    "onland":"onLand","onjump":"onJump",
    "onscreenexit":"onScreenExit","onscreenenter":"onScreenEnter",
    "onreload":"onReload",
    "onstateenter":"onStateEnter","onstateexit":"onStateExit",
    "onkeydown":"onKeyDown","onkeyup":"onKeyUp",
    "getx":"getX","gety":"getY","setx":"setX","sety":"setY",
    "moveto":"moveTo","moveforward":"moveForward","lookat":"lookAt",
    "flipx":"flipX","flipy":"flipY",
    "velocityx":"velocityX","velocityy":"velocityY",
    "setvelocity":"setVelocity","stopmovement":"stopMovement",
    "bouncex":"bounceX","bouncey":"bounceY","addimpulse":"addImpulse",
    "getrotation":"getRotation","setrotation":"setRotation",
    "getscalex":"getScaleX","setscalex":"setScaleX",
    "getscaley":"getScaleY","setscaley":"setScaleY",
    "setalpha":"setAlpha","getalpha":"getAlpha","fadein":"fadeIn","fadeout":"fadeOut",
    "settag":"setTag","gettag":"getTag","setgroup":"setGroup","getgroup":"getGroup",
    "sendmessage":"sendMessage","broadcastall":"broadcastAll",
    "findwithtag":"findWithTag","findallwithtag":"findAllWithTag",
    "destroyself":"destroySelf","destroyobject":"destroyObject",
    "gotoscene":"gotoScene","pausescene":"pauseScene","resumescene":"resumeScene",
    "restartscene":"restartScene","currentscene":"currentScene",
    "camerafollow":"cameraFollow","cameraunfollow":"cameraUnfollow",
    "cameramoveto":"cameraMoveTo","getcamerax":"getCameraX","getcameray":"getCameraY",
    "camerashake":"cameraShake","playanimation":"playAnimation",
    "stopanimation":"stopAnimation","pauseanimation":"pauseAnimation",
    "currentanimation":"currentAnimation",
    "iskeydown":"isKeyDown","iskeyjustdown":"isKeyJustDown","iskeyjustup":"isKeyJustUp",
    "axish":"axisH","axisv":"axisV","mousex":"mouseX","mousey":"mouseY",
    "mousedown":"mouseDown","mousejustdown":"mouseJustDown",
    "soundplay":"soundPlay","soundstop":"soundStop","soundstopall":"soundStopAll",
    "setphysicstype":"setPhysicsType","setcollision":"setCollision","setsensor":"setSensor",
    "applyforce":"applyForce","applyimpulse":"applyImpulse",
    "isonground":"isOnGround","isonceiling":"isOnCeiling","isonwall":"isOnWall",
    "settint":"setTint","gettint":"getTint","cleartint":"clearTint",
    "distanceto":"distanceTo","inrangeof":"inRangeOf",
    "setstate":"setState","getstate":"getState","triggerJump":"triggerJump",
    "sethealth":"setHealth","gethealth":"getHealth","takedamage":"takeDamage",
    "setammo":"setAmmo","getammo":"getAmmo","reload":"reload",
    "spawnobject":"spawnObject","cloneself":"cloneSelf","cloneobject":"cloneObject",
    "raycast":"raycast","raycastall":"raycastAll","raycastfromself":"raycastFromSelf",
    "screentpworld":"screenToWorld","worldtoscreen":"worldToScreen",
    "camerafollow":"cameraFollow",
    "iswalking":"isWalking","isstuck":"isStuck",
    "scenevar":"sceneVar","globalvar":"globalVar","gamesave":"GameSave",
};

// ── Levenshtein distance (for typo suggestions) ──────────────
function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n; if (n === 0) return m;
    const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
}

function _closestApiMatch(word) {
    const lower = word.toLowerCase();
    // Exact case-insensitive match first
    if (TYPO_MAP[lower]) return TYPO_MAP[lower];
    // Levenshtein closest within distance 2
    let best = null, bestDist = 3;
    for (const api of API_NAMES) {
        const d = _levenshtein(lower, api.toLowerCase());
        if (d < bestDist) { bestDist = d; best = api; }
    }
    return best;
}

// ── Strip comments and strings (preserving line count) ───────
function _stripCommentsAndStrings(code) {
    let out = '';
    let i = 0, len = code.length;
    while (i < len) {
        // Single-line comment
        if (code[i] === '/' && code[i+1] === '/') {
            while (i < len && code[i] !== '\n') { out += ' '; i++; }
        }
        // Multi-line comment
        else if (code[i] === '/' && code[i+1] === '*') {
            i += 2;
            while (i < len) {
                if (code[i] === '*' && code[i+1] === '/') { out += '  '; i += 2; break; }
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
        }
        // Template literal
        else if (code[i] === '`') {
            out += ' '; i++;
            while (i < len && code[i] !== '`') {
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
            if (i < len) { out += ' '; i++; }
        }
        // String literal
        else if (code[i] === '"' || code[i] === "'") {
            const q = code[i];
            out += ' '; i++;
            while (i < len && code[i] !== q && code[i] !== '\n') {
                if (code[i] === '\\') { out += '  '; i += 2; }
                else { out += ' '; i++; }
            }
            if (i < len && code[i] === q) { out += ' '; i++; }
        }
        else { out += code[i]; i++; }
    }
    return out;
}

// ── Main lint function ────────────────────────────────────────
/**
 * Lint user script code and return array of diagnostics:
 * [{ line, col, message, severity, fix }]
 * severity: 'error' | 'warning' | 'info'
 */
export function lintScript(code) {
    const diagnostics = [];
    const stripped = _stripCommentsAndStrings(code);
    const lines = stripped.split('\n');
    const rawLines = code.split('\n');

    // ── Declared identifiers (var/let/const/function/param names) ──
    const declared = new Set(JS_GLOBALS);
    // Collect all declared names from stripped code
    const declRe = /\b(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    const fnRe   = /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    const arrowParamRe = /\(([a-zA-Z_$][a-zA-Z0-9_$]*(?:\s*,\s*[a-zA-Z_$][a-zA-Z0-9_$]*)*)\)\s*=>/g;
    const simpleParamRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/g;

    let m;
    while ((m = declRe.exec(stripped)) !== null)       declared.add(m[1]);
    while ((m = fnRe.exec(stripped)) !== null)         declared.add(m[1]);
    while ((m = arrowParamRe.exec(stripped)) !== null)
        m[1].split(',').forEach(p => declared.add(p.trim()));
    while ((m = simpleParamRe.exec(stripped)) !== null) declared.add(m[1]);

    // Also add for-loop variables: for (var i ...) or for (let k of ...)
    const forVarRe = /\bfor\s*\(\s*(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    while ((m = forVarRe.exec(stripped)) !== null) declared.add(m[1]);

    // ── Per-line checks ───────────────────────────────────────
    for (let li = 0; li < lines.length; li++) {
        const line   = lines[li];
        const rawLine = rawLines[li] || '';
        const lineNo  = li + 1;

        // 1. Detect dangerous globals that crash the engine
        const dangerous = [
            { re: /\bdocument\s*\.\s*body\b/,              msg: 'document.body is not available in scripts — it would destroy the editor. Use log() to print, or drawText() for on-screen text.' },
            { re: /\bdocument\s*\.\s*getElementById\b/,    msg: 'document.getElementById() is blocked. Use find("Name") to get game objects.' },
            { re: /\bdocument\s*\.\s*querySelector\b/,     msg: 'document.querySelector() is blocked. Use find("Name") to get game objects.' },
            { re: /\bdocument\s*\.\s*write\b/,             msg: 'document.write() destroys the engine canvas. Use log() instead.' },
            { re: /\blocation\s*\.\s*href\b/,              msg: 'location.href would navigate away from the engine. Use gotoScene("Level2") to change scenes.' },
            { re: /\blocalStorage\b/,                       msg: 'localStorage is blocked in the sandbox. Use store.set("key", value) and store.get("key") to save data.' },
            { re: /\balert\s*\(/,                           msg: 'alert() freezes the entire browser tab. Use log() to print messages in the engine console.' },
            { re: /\bconfirm\s*\(/,                         msg: 'confirm() freezes the browser tab. Use a game UI element instead.' },
            { re: /\bwindow\s*\.\s*open\b/,                msg: 'window.open() is blocked. Use gotoScene() or UI to navigate.' },
            { re: /\bconsole\s*\.\s*log\b/,                msg: 'console.log() goes to browser devtools — use log() instead to see output in the engine console.' },
            { re: /\beval\s*\(/,                            msg: 'eval() is unsafe and blocked. Write your logic directly in the script.' },
            { re: /\bsetInterval\s*\(/,                     msg: 'setInterval() persists after Play stops — use repeat(seconds, fn) instead.' },
            { re: /\bsetTimeout\s*\(/,                      msg: 'setTimeout() may fire after Play stops — use wait(seconds, fn) instead.' },
        ];
        for (const { re, msg } of dangerous) {
            if (re.test(line)) {
                const col = line.search(re);
                diagnostics.push({ line: lineNo, col, message: msg, severity: 'error' });
            }
        }

        // 2. Infinite loop detection
        if (/\bwhile\s*\(\s*true\s*\)/.test(line) && !/break/.test(line)) {
            diagnostics.push({ line: lineNo, col: line.search(/\bwhile/), severity: 'error',
                message: 'while(true) without a break will freeze the engine. Put repeating logic inside onUpdate(dt) instead.' });
        }
        if (/\bfor\s*\(\s*;\s*;\s*\)/.test(line)) {
            diagnostics.push({ line: lineNo, col: line.search(/\bfor/), severity: 'error',
                message: 'for(;;) is an infinite loop. Put repeating logic inside onUpdate(dt) instead.' });
        }

        // 3. Wrong patterns
        if (/\bonUpdate\s*\(\s*\)/.test(line)) {
            diagnostics.push({ line: lineNo, col: line.search(/\bonUpdate/), severity: 'warning',
                message: 'onUpdate() is missing the dt argument. Write onUpdate((dt) => { }) to get delta time for smooth movement.' });
        }
        if (/\bdt\s*\*/.test(line) && !/onUpdate/.test(line) && !/function/.test(line) && !/=>\s*\{/.test(rawLines[li > 0 ? li-1 : 0] || '')) {
            // dt used but not inside onUpdate — just info
        }

        // 4. API call argument count check
        const callRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g;
        let cm;
        while ((cm = callRe.exec(line)) !== null) {
            const fn = cm[1];
            if (!API_SIGNATURES[fn]) continue;
            const [minArgs, maxArgs] = API_SIGNATURES[fn];
            // Count args (rough: count commas, but skip empty args)
            const argsStr = cm[2].trim();
            const argCount = argsStr === '' ? 0 : argsStr.split(',').length;
            if (argCount < minArgs || argCount > maxArgs) {
                const hint = FIX_HINTS[fn] || null;
                const expected = minArgs === maxArgs ? `${minArgs}` : `${minArgs}–${maxArgs}`;
                diagnostics.push({
                    line: lineNo,
                    col: line.indexOf(cm[0]),
                    severity: 'error',
                    message: `${fn}() expects ${expected} argument${minArgs !== 1 ? 's' : ''} but got ${argCount}.${hint ? '\n💡 ' + hint : ''}`,
                });
            }
        }

        // 5. Unknown identifiers (conservative — only flag clear cases)
        const identRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
        let im;
        while ((im = identRe.exec(line)) !== null) {
            const word = im[1];
            // Skip if it's declared, a JS global, or a known API
            if (declared.has(word) || API_NAMES.has(word) || JS_GLOBALS.has(word)) continue;
            // Skip if it looks like a method call (preceded by .)
            const before = line.slice(0, im.index);
            if (before.endsWith('.')) continue;
            // Only flag if it's clearly not declared anywhere in code
            if (stripped.includes(`function ${word}`) || stripped.includes(`var ${word}`) ||
                stripped.includes(`let ${word}`) || stripped.includes(`const ${word}`)) continue;
            const suggestion = _closestApiMatch(word);
            const fix = suggestion ? ` Did you mean "${suggestion}"?` : '';
            diagnostics.push({
                line: lineNo,
                col: im.index,
                severity: 'warning',
                message: `"${word}" is not a known function.${fix}`,
                suggestion,
            });
        }

        // 6. Common pattern mistakes
        if (/velocityX\s*\+\+|velocityX\s*--/.test(line)) {
            diagnostics.push({ line: lineNo, col: line.search(/velocityX/), severity: 'warning',
                message: 'velocityX++ changes by 1 unit per frame — this is frame-rate dependent. Inside onUpdate use velocityX += speed * dt for consistent movement.' });
        }
        if (/velocityY\s*\+\+|velocityY\s*--/.test(line)) {
            diagnostics.push({ line: lineNo, col: line.search(/velocityY/), severity: 'warning',
                message: 'velocityY++ changes by 1 unit per frame — this is frame-rate dependent. Inside onUpdate use velocityY += speed * dt for consistent movement.' });
        }
        if (/move\s*\([^,)]+,\s*[^)]+\)/.test(line) && !/dt/.test(line) && /onUpdate/.test(rawLines[Math.max(0,li-3)] + rawLines[Math.max(0,li-2)] + rawLines[Math.max(0,li-1)])) {
            // move() inside onUpdate without dt — info only
        }

        // 7. Missing semicolons on common statements (just info, not blocking)
        // (skipped — too many false positives)
    }

    // ── Global checks (whole file) ────────────────────────────
    const hasOnUpdate = /\bonUpdate\s*\(/.test(stripped);
    const hasWhileTrue = /\bwhile\s*\(\s*true\s*\)/.test(stripped);
    if (hasWhileTrue && !hasOnUpdate) {
        // Already flagged per-line above
    }

    // Deduplicate diagnostics on same line+col
    const seen = new Set();
    return diagnostics.filter(d => {
        const key = `${d.line}:${d.col}:${d.message.slice(0,40)}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}

// ── Ace integration ───────────────────────────────────────────
/**
 * Attach live linting to an Ace editor instance.
 * Call once after editor is initialized.
 * Returns a cleanup function.
 */
export function attachLinter(editor, aceEl) {
    let _lintTimer = null;
    let _markers = [];
    let _panel = null;

    // Create the error panel below the editor
    _panel = _createErrorPanel(aceEl);

    function _clearMarkers() {
        for (const id of _markers) editor.session.removeMarker(id);
        _markers = [];
        editor.session.clearAnnotations();
    }

    function _runLint() {
        _clearMarkers();
        const code = editor.getValue();
        if (!code.trim()) { _updatePanel([], _panel); return; }

        const diags = lintScript(code);
        _updatePanel(diags, _panel);

        if (!diags.length) return;

        // Set Ace gutter annotations
        const annotations = diags.map(d => ({
            row: d.line - 1,
            column: d.col || 0,
            text: d.message.replace(/\n💡 /g, '\n→ '),
            type: d.severity === 'error' ? 'error' : 'warning',
        }));
        editor.session.setAnnotations(annotations);

        // Add inline markers (underline the problem area)
        const Range = ace.require('ace/range').Range;
        for (const d of diags) {
            const row = d.line - 1;
            const line = editor.session.getLine(row) || '';
            const col  = d.col || 0;
            // Find end of the problem token
            let end = col;
            while (end < line.length && /\w/.test(line[end])) end++;
            if (end === col) end = Math.min(col + 8, line.length);
            const cls = d.severity === 'error'
                ? 'ze-lint-error-marker'
                : 'ze-lint-warn-marker';
            const id = editor.session.addMarker(new Range(row, col, row, end), cls, 'text', false);
            _markers.push(id);
        }
    }

    // Debounced lint on change
    const _onChange = () => {
        clearTimeout(_lintTimer);
        _lintTimer = setTimeout(_runLint, 600);
    };
    editor.on('change', _onChange);

    // Also run on cursor line change to update panel focus
    editor.selection.on('changeCursor', () => {
        if (_panel) {
            const curLine = editor.getCursorPosition().row + 1;
            _highlightPanelLine(_panel, curLine);
        }
    });

    // Run immediately
    setTimeout(_runLint, 200);

    // Inject marker CSS once
    _injectLintCSS();

    return () => {
        editor.off('change', _onChange);
        clearTimeout(_lintTimer);
        _clearMarkers();
        if (_panel) _panel.remove();
    };
}

// ── Jump to error from runtime ─────────────────────────────────
/**
 * Call this when a runtime error occurs to jump the editor to the
 * correct line and show a runtime error badge.
 * @param {number} lineNum  - 1-based line number in the user's script
 * @param {string} message  - Human-readable error message
 */
export function jumpEditorToError(lineNum, message) {
    const editor = window._seAceEditor;
    if (!editor || editor.destroyed) return;
    // Jump to the line
    editor.gotoLine(lineNum, 0, true);
    editor.scrollToLine(lineNum - 1, true, true);
    // Add a runtime error annotation
    const existing = editor.session.getAnnotations() || [];
    editor.session.setAnnotations([
        ...existing,
        { row: lineNum - 1, column: 0, text: '⚡ Runtime error: ' + message, type: 'error' },
    ]);
    // Flash the gutter line
    const Range = ace.require('ace/range').Range;
    const id = editor.session.addMarker(
        new Range(lineNum - 1, 0, lineNum - 1, Infinity),
        'ze-lint-runtime-line', 'fullLine', false
    );
    setTimeout(() => editor.session.removeMarker(id), 3000);
}

// ── Error panel UI ────────────────────────────────────────────
function _createErrorPanel(aceEl) {
    // Find the editor overlay
    const overlay = aceEl?.closest('#zengine-script-editor');
    if (!overlay) return null;

    const panel = document.createElement('div');
    panel.id = 'ze-lint-panel';
    panel.style.cssText = [
        'flex-shrink:0',
        'background:#1a1014',
        'border-top:1px solid #3a1a1a',
        'max-height:140px',
        'overflow-y:auto',
        'font-family:"Fira Code","Consolas",monospace',
        'font-size:11px',
        'display:none',
    ].join(';');

    // Insert between editor area and bottom of the overlay
    const editorArea = overlay.querySelector('div[style*="flex:1"]');
    if (editorArea) {
        editorArea.parentNode.insertBefore(panel, editorArea.nextSibling);
    } else {
        overlay.appendChild(panel);
    }
    return panel;
}

function _updatePanel(diags, panel) {
    if (!panel) return;
    if (!diags.length) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }
    panel.style.display = 'block';

    const errors   = diags.filter(d => d.severity === 'error');
    const warnings = diags.filter(d => d.severity === 'warning');

    const header = `<div style="padding:3px 10px;background:#1e1014;border-bottom:1px solid #3a1a1a;display:flex;gap:12px;align-items:center;position:sticky;top:0;z-index:1;">
        ${errors.length   ? `<span style="color:#f87171;">⛔ ${errors.length} error${errors.length>1?'s':''}</span>` : ''}
        ${warnings.length ? `<span style="color:#facc15;">⚠ ${warnings.length} warning${warnings.length>1?'s':''}</span>` : ''}
        <span style="color:#404050;font-size:10px;margin-left:auto;">click a line to jump there</span>
    </div>`;

    const rows = diags.map(d => {
        const icon  = d.severity === 'error' ? '⛔' : '⚠';
        const color = d.severity === 'error' ? '#f87171' : '#facc15';
        // Split message at newline (fix hint)
        const parts = d.message.split('\n💡 ');
        const main  = parts[0];
        const hint  = parts[1] || null;
        return `<div class="ze-lint-row" data-line="${d.line}" style="
            padding:3px 10px;
            display:flex;
            align-items:flex-start;
            gap:8px;
            cursor:pointer;
            border-bottom:1px solid #2a1a1a;
        " onmouseenter="this.style.background='#2a1a20'" onmouseleave="this.style.background=''" onclick="window._zeLintJump(${d.line})">
            <span style="color:${color};flex-shrink:0;margin-top:1px;">${icon}</span>
            <span style="color:#6a6a8a;flex-shrink:0;width:50px;">Line ${d.line}</span>
            <div>
                <div style="color:#d4d4d4;">${main}</div>
                ${hint ? `<div style="color:#4ec9b0;margin-top:2px;">💡 ${hint}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    panel.innerHTML = header + rows;

    // Wire the jump function
    window._zeLintJump = (lineNum) => {
        const editor = window._seAceEditor;
        if (editor && !editor.destroyed) {
            editor.gotoLine(lineNum, 0, true);
            editor.focus();
        }
    };
}

function _highlightPanelLine(panel, curLine) {
    if (!panel) return;
    panel.querySelectorAll('.ze-lint-row').forEach(row => {
        const l = parseInt(row.dataset.line, 10);
        row.style.background = l === curLine ? '#2a1a28' : '';
    });
}

// ── CSS injection ─────────────────────────────────────────────
function _injectLintCSS() {
    if (document.getElementById('ze-lint-css')) return;
    const style = document.createElement('style');
    style.id = 'ze-lint-css';
    style.textContent = `
/* Red wavy underline for errors */
.ze-lint-error-marker {
    position: absolute;
    border-bottom: 2px solid #f87171;
    text-decoration: underline wavy #f87171;
}
/* Yellow wavy underline for warnings */
.ze-lint-warn-marker {
    position: absolute;
    border-bottom: 2px solid #facc15;
    text-decoration: underline wavy #facc15;
}
/* Runtime error — whole line highlight */
.ze-lint-runtime-line {
    position: absolute;
    background: rgba(248, 113, 113, 0.15);
    left: 0; right: 0;
}
/* Ace gutter dots */
.ace_error   .ace_gutter-cell { color: #f87171 !important; }
.ace_warning .ace_gutter-cell { color: #facc15 !important; }
/* Ace tooltip */
.ace_editor .ace_tooltip {
    background: #1e1e1e !important;
    border: 1px solid #3a3a3a !important;
    color: #d4d4d4 !important;
    font-family: "Fira Code","Consolas",monospace !important;
    font-size: 12px !important;
    max-width: 480px !important;
    white-space: pre-wrap !important;
    padding: 6px 10px !important;
    border-radius: 4px !important;
    line-height: 1.6 !important;
}
`;
    document.head.appendChild(style);
}
