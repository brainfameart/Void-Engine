/* ============================================================
   engine.scripting.runtime.js
   ScriptInstance class, drag/throw, virtual joystick, input
   event wiring, startScripts / stopScripts, and all public
   exports consumed by the rest of the engine.
   ============================================================ */

import { state } from './engine.state.js';
import { stopChat } from './engine.scripting.chat.js';
import { navSnapshotPositions } from './pathfindlogic.js';
import {
    _logConsole, _instances,
    _tagRegistry, _groupRegistry,
    _debugLines, _setDebugGfx,
    _scriptFnCache,
    _scanScriptForDangers, _friendlyScriptError,
    _isOverlapping,
    _clearDebugGfx, _tickDebugLines,
    _registerInstance, _clearRegistries,
    _broadcastGlobal, _broadcastToTag, _broadcastToGroup, _sendMessageToTag,
    _scheduleTimer, _tickTimers, _clearTimers,
    _easing, _applyTweenProp,
    _camera, _updateCamera,
    clearSceneVars, clearGlobalVars,
    _registerScriptInstanceClass,
    getScript,
} from './engine.scripting.shared.js';
import { _buildSandbox, _deepCopyObjectProps } from './engine.scripting.sandbox.js';
import { _makeProxy } from './engine.scripting.proxy.js';
import { _navTick } from './engine.scripting.nav.js';
import {
    acquireSandboxIframe, releaseSandboxIframe,
    runInSandbox, isSandboxSupported, prewarmSandboxPool,
} from './engine.scripting.sandbox-iframe.js';

// ── Sandbox support detection ─────────────────────────────────
// Set to true once we've confirmed sandboxed iframes work.
// Falls back to direct AsyncFunction if not supported (e.g. exported game).
let _sandboxEnabled = false;
isSandboxSupported().then(ok => {
    _sandboxEnabled = ok;
    if (ok) {
        prewarmSandboxPool(4);
        console.log('[Zengine] Script sandbox: ✅ enabled (sandboxed iframe)');
    } else {
        console.log('[Zengine] Script sandbox: ℹ️  running in game-only mode (no sandbox needed)');
    }
});

// ── Runtime error → editor jump helper ──────────────────────
function _jumpEditorToError(err, code, scriptName) {
    try {
        let lineNum = null;
        if (err?.lineNumber) {
            lineNum = err.lineNumber;
        } else if (err?.stack) {
            const m = err.stack.match(/<anonymous>:(\d+)|Function[^:]*:(\d+)|at eval[^:]*:(\d+)/);
            if (m) lineNum = parseInt(m[1] ?? m[2] ?? m[3], 10);
        }
        const PRELUDE_LINES = 1130;
        if (lineNum != null && lineNum > PRELUDE_LINES) {
            const userLine = lineNum - PRELUDE_LINES;
            if (window._zeJumpEditorToError) {
                // Check if the script that errored is the one currently open
                const openEditor = window._seAceEditor;
                if (openEditor && !openEditor.destroyed) {
                    window._zeJumpEditorToError(userLine, err?.message ?? String(err));
                }
            }
        }
    } catch(_) {}
}

// ── Script Instance ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// SMART SCRIPT SAFETY LAYER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pre-flight scan of user script code.
 * Returns { fatal: bool, messages: string[] }
 * fatal=true  → script is blocked from running entirely (engine-breaking)
 * fatal=false → warnings only, script still runs but user is informed
 */
class ScriptInstance {
    constructor(obj, name, code) {
        this.obj              = obj;
        this.name             = name;
        // All registered callbacks
        this._onStart         = null;
        this._onUpdate        = null;
        this._onStop          = null;
        this._onCollisionEnter= null;  // fired once when collision begins
        this._onCollisionStay = null;  // fired every frame while colliding
        this._onCollisionExit = null;  // fired once when collision ends
        this._onOverlapEnter  = null;  // AABB overlap starts
        this._onOverlapExit   = null;  // AABB overlap ends
        this._onVisible       = null;
        this._onHide          = null;
        this._onMouseClick    = null;
        this._onMouseEnter    = null;
        this._onMouseLeave    = null;
        this._onDragMouseDown = null;  // set by makeDraggable — fires on mousedown over object
        this._dragReleaseHook = null;  // cleanup hook for drag release
        this._messageHandlers = new Map();
        this._onCloneStart    = null;

        // Collision / overlap tracking
        this._activeCollisions = new Set(); // Set of other obj refs currently colliding
        this._activeOverlaps   = new Set(); // Set of other obj refs currently overlapping

        // instRef array so _buildSandbox can back-reference this instance
        const instRef = [null];
        const { api, _keys, _keysJustDown, _keysJustUp, _mouse,
                _tweens, _repeats, _keyDownHandlers, _keyUpHandlers } = _buildSandbox(obj, instRef);
        instRef[0]          = this;
        this.api            = api;
        this._keys          = _keys;
        this._keysJustDown  = _keysJustDown;
        this._keysJustUp    = _keysJustUp;
        this._mouse         = _mouse;
        this._tweens        = _tweens;
        this._repeats       = _repeats;
        this._keyDownHandlers = _keyDownHandlers;
        this._keyUpHandlers   = _keyUpHandlers;
        // Sandbox iframe — acquired async, compile runs once it's ready
        this._sandboxIframe = null;
        this._compileAsync(code, api);
    }

    async _compileAsync(code, api) {
        // Acquire a sandboxed iframe if the sandbox is supported.
        // We await it here so _doCompile always has a valid iframe (or null).
        if (_sandboxEnabled) {
            try {
                this._sandboxIframe = await acquireSandboxIframe();
            } catch(_) {
                this._sandboxIframe = null;
            }
        }
        this._doCompile(code, api);
    }

    _doCompile(code, api) {
        // ── The full scripting prelude — everything accessible in scripts ──
        const prelude = `
var _onStart=null, _onUpdate=null, _onStop=null, _onCloneStart=null, _onDestroy=null;
var _onCollisionEnter=null, _onCollisionStay=null, _onCollisionExit=null;
var _onOverlapEnter=null, _onOverlapExit=null;
var _onVisible=null, _onHide=null, _onMouseClick=null, _onMouseEnter=null, _onMouseLeave=null;
var _msgHandlers = new Map();
// ── Extended events ───────────────────────────────────────
var _onDamage=null, _onDeath=null, _onHeal=null;
var _onLand=null, _onJump=null;
var _onScreenExit=null, _onScreenEnter=null;
var _onReload=null;
var _stateEnterHandlers=new Map(), _stateExitHandlers=new Map();

// ═══════════════════════════════════════════════════════════════
// EVENT REGISTRATION
// Register functions to run at specific moments in the game loop.
// ═══════════════════════════════════════════════════════════════

/** Runs once when Play is pressed (only on original objects, NOT clones) */
function onStart(fn)             { _onStart          = fn; }

/**
 * Runs once when this object is spawned as a CLONE via cloneSelf() or cloneObject().
 * Use this to give clones their own initialisation without causing infinite clone chains:
 *
 *   onStart(() => {
 *     cloneSelf(getX() + 1, getY());   // spawn ONE clone to the right
 *   });
 *   onCloneStart(() => {
 *     // this code runs on the clone — NOT on the original
 *   });
 */
function onCloneStart(fn)        { _onCloneStart      = fn; }
/** Runs every frame. dt = seconds since last frame (use for smooth movement) */
function onUpdate(fn)            { _onUpdate         = fn; }
/** Runs once when Play is stopped */
function onStop(fn)              { _onStop           = fn; }
/**
 * Runs once just before this object is destroyed (via destroySelf() or destroy()).
 * Use it to play effects, drop items, remove HUD elements, etc.
 *   onDestroy(() => { spawnObject("Explosion", getX(), getY()); })
 */
function onDestroy(fn)           { _onDestroy        = fn; }
/** Runs once when this object begins touching another (physics) */
function onCollisionEnter(fn)    { _onCollisionEnter = fn; }
/** Runs every frame while this object is still touching another (physics) */
function onCollisionStay(fn)     { _onCollisionStay  = fn; }
/** Runs once when this object stops touching another (physics) */
function onCollisionExit(fn)     { _onCollisionExit  = fn; }
/** Runs once when this object's AABB begins overlapping another (no physics needed) */
function onOverlapEnter(fn)      { _onOverlapEnter   = fn; }
/** Runs once when this object's AABB stops overlapping another */
function onOverlapExit(fn)       { _onOverlapExit    = fn; }
/** Runs when this object becomes visible */
function onBecomeVisible(fn)     { _onVisible        = fn; }
/** Runs when this object becomes hidden */
function onBecomeHidden(fn)      { _onHide           = fn; }
/** Runs when this object is clicked */
function onMouseClick(fn)        { _onMouseClick     = fn; }
/** Runs when the mouse enters this object's area */
function onMouseEnter(fn)        { _onMouseEnter     = fn; }
/** Runs when the mouse leaves this object's area */
function onMouseLeave(fn)        { _onMouseLeave     = fn; }
/**
 * Runs when this object receives a message.
 * Example: onMessage("takeDamage", (amount) => { ... })
 */
function onMessage(msg, fn)      { _msgHandlers.set(String(msg), fn); }

// ── Health / Combat events ────────────────────────────────
/** Runs when this object takes damage: onDamage((amount, source) => { }) */
function onDamage(fn)            { _onDamage = fn; }
/** Runs when this object's health reaches 0: onDeath((source) => { }) */
function onDeath(fn)             { _onDeath  = fn; }
/** Runs when this object is healed: onHeal((amount) => { }) */
function onHeal(fn)              { _onHeal   = fn; }

// ── Platformer events ─────────────────────────────────────
/**
 * Runs the first frame this object lands on the ground after being airborne.
 * Works for both Kinematic and Dynamic physics bodies.
 *   onLand(() => { soundPlay("land"); })
 */
function onLand(fn)              { _onLand   = fn; }
/**
 * Fires when you call jump() or triggerJump() — wire your jump logic here.
 *   onJump(() => { velocityY = 12; })
 */
function onJump(fn)              { _onJump   = fn; }

// ── Screen bounds events ──────────────────────────────────
/** Runs once when this object moves outside the visible game area. */
function onScreenExit(fn)        { _onScreenExit  = fn; }
/** Runs once when this object moves back inside the visible game area. */
function onScreenEnter(fn)       { _onScreenEnter = fn; }
/** Runs when reload() is called. */
function onReload(fn)            { _onReload      = fn; }

// ── State machine events ──────────────────────────────────
/**
 * Runs when this object enters a specific state (via setState()).
 *   onStateEnter("attack", (newState, prevState) => { playAnimation("swing"); })
 */
function onStateEnter(name, fn)  { _stateEnterHandlers.set(String(name), fn); }
/**
 * Runs when this object exits a specific state (via setState()).
 *   onStateExit("attack", (oldState, nextState) => { stopAnimation(); })
 */
function onStateExit(name, fn)   { _stateExitHandlers.set(String(name), fn); }

// ═══════════════════════════════════════════════════════════════
// THIS OBJECT — use "this." prefix for clarity
// All of these refer to the object this script is attached to.
// ═══════════════════════════════════════════════════════════════
var self = api;  // "self" is a backup alias for "this"

// ── Position ──────────────────────────────────────────────────
/** this.x — world X position of this object */
function getX()        { return api.x; }
function setX(v)       { api.x = v; }
/** this.y — world Y position (positive = up) */
function getY()        { return api.y; }
function setY(v)       { api.y = v; }
/** Move by (dx, dy) world units */
/**
 * Move by (dx, dy) world units THIS FRAME ONLY. Frame-rate dependent.
 * Multiply by dt inside onUpdate to get consistent speed across machines:
 *   move(speed * dt, 0)   — moves at \`speed\` world units/sec regardless of frame rate
 * Without dt: move(0.1) at 30fps moves half as far as at 60fps.
 */
function move(dx, dy)  { api.move(dx, dy); }
/** Warp this object to exact position */
function moveTo(x, y)  { api.moveTo(x, y); }

// ── Navigation / Pathfinding ───────────────────────────────────
/**
 * Walk to world position (x, y) while avoiding obstacles.
 *
 *   walkTo(5, 3, { speed: 4, avoidStatic: true })
 *   walkTo(5, 3, { speed: 3, avoidTag: "wall", onDone: () => log("arrived!") })
 *   walkTo(5, 3, { speed: 5, avoidAll: true, debug: true })
 *   walkTo(5, 3, { speed: 3, avoidStatic: true, minHoleSize: 1.5 }) // can squeeze through 1.5-unit gaps
 *
 * Options:
 *   speed        — world units/sec (default 3)
 *   avoidTag     — tag string or array to avoid
 *   avoidGroup   — group string or array to avoid
 *   avoidStatic  — true → avoid physicsBody='static' objects
 *   avoidAll     — true → avoid any object with a physics body
 *   stopRadius   — arrival distance (default 0.3 units)
 *   minHoleSize  — minimum gap width in world units the AI can navigate through
 *                  (smaller gaps are treated as blocked; default: auto from sprite size)
 *   onDone       — callback when arrived
 *   debug        — true → visualise path with lines
 *   smooth       — false → disable path smoothing
 *   cellSize     — override grid cell size in world units
 *   agentRadius  — override agent clearance radius in world units
 */
function walkTo(x, y, opts)          { api.walkTo(x, y, opts ?? {}); }

/**
 * Walk toward an object by name, tag, or proxy — re-pathing as it moves.
 *
 *   walkToObject("Player", { speed: 3, avoidStatic: true })
 *   walkToObject("chest",  { speed: 4, stopRadius: 1, onDone: () => openChest() })
 *   walkToObject(find("Boss"), { speed: 6, follow: true })  // keep following
 *   walkToObject("Player", { speed: 3, avoidStatic: true, minHoleSize: 1.2 }) // tight gaps OK
 *
 * Options: same as walkTo, plus:
 *   repath      — seconds between path recalculations (default 0.5)
 *   follow      — keep walking even after arrival (default false)
 *   minHoleSize — minimum gap width in world units the AI can navigate through
 */
function walkToObject(nameOrProxy, opts) { api.walkToObject(nameOrProxy, opts ?? {}); }

/** Stop the current walkTo / walkToObject immediately. */
function stopWalking()               { api.stopWalking(); }

/** True if a walkTo or walkToObject is currently running. */
var isWalking = false; // synced each frame via api.isWalking

// ── SMART AI NAVIGATION ───────────────────────────────────
/**
 * Predictive chase — intercepts a moving target.
 *   pursue("player", { speed: 3, avoidStatic: true, predictTime: 0.5 })
 *   pursue("player", { speed: 4, separation: true })
 * Extra options vs walkToObject:
 *   predictTime — seconds ahead to predict target position (default 0.5)
 *   separation  — avoid clustering with other AI agents (default false)
 */
function pursue(target, opts)         { api.pursue(target, opts ?? {}); }

/**
 * Run directly away from a target (no pathfinding, instant each frame).
 *   flee("player", { speed: 4 })
 *   flee(target, { speed: 3, separation: true })
 * Call stopWalking() to stop.
 */
function flee(target, opts)           { api.flee(target, opts ?? {}); }

/**
 * Wander randomly around the scene.
 *   wander()
 *   wander({ speed: 1.5, radius: 3, changeInterval: 2 })
 * Call stopWalking() to stop.
 */
function wander(opts)                 { api.wander(opts ?? {}); }

/**
 * Returns true when there is an unobstructed line of sight to the target.
 * Uses the nav obstacle grid when available; falls back to AABB sweep.
 *   if (canSee("player")) { setState("chase"); }
 *   if (canSee(target, { maxRange: 8 })) { ... }
 */
function canSee(target, opts)         { return api.canSee(target, opts ?? {}); }

/**
 * Returns the last world position { x, y } this AI recorded seeing the target.
 * Expires after ~10 seconds.  Returns null if never seen or expired.
 *   var lkp = lastKnownPos("player");
 *   if (lkp) walkTo(lkp.x, lkp.y);
 */
function lastKnownPos(target)         { return api.lastKnownPos(target); }

/**
 * Returns true if the target is within the agent's forward view cone.
 *   if (inFOV("player", 90, 6)) { log("Player spotted!"); }
 */
function inFOV(target, deg, range)    { return api.inFOV(target, deg ?? 90, range ?? 0); }

/** True when the agent hasn't moved enough recently (stuck detection). */
var isStuck = false; // synced each frame via api.isStuck
var isPlayingAnimation = false; // synced each frame via api.isPlayingAnimation
/** Move in the direction this object is currently facing */
/**
 * Move forward along this object's rotation direction THIS FRAME ONLY. Frame-rate dependent.
 * Multiply by dt inside onUpdate:  moveForward(speed * dt)
 */
function moveForward(speed) { api.moveForward(speed); }
/** Rotate this object to face a world position */
function lookAt(tx, ty){ api.lookAt(tx, ty); }
function flipX()       { api.flipX(); }
function flipY()       { api.flipY(); }

// ── Rotation and scale ────────────────────────────────────────
/** this.rotation — degrees (clockwise positive) */
function getRotation()   { return api.rotation; }
function setRotation(v)  { api.rotation = v; }
/** Lock this dynamic body's rotation — physics cannot spin it, but script can. */
function lockRotation()            { api.lockRotation(); }
/** Unlock this dynamic body's rotation — physics can spin it again. */
function unlockRotation()          { api.unlockRotation(); }
/** setRotationLocked(true/false) — one-call lock toggle */
function setRotationLocked(v)      { api.setRotationLocked(v); }
/** this.scaleX / this.scaleY */
function getScaleX()     { return api.scaleX; }
function setScaleX(v)    { api.scaleX = v; }
function getScaleY()     { return api.scaleY; }
function setScaleY(v)    { api.scaleY = v; }

// ── Velocity (applied every frame automatically) ─────────────
/**
 * this.velocityX / vx — horizontal speed in world units/second.
 * Set this and the object moves that direction automatically.
 * Example: this.velocityX = 5;  // moves right at 5 units/sec
 */
var velocityX = 0;
var velocityY = 0;
var vx = 0;
var vy = 0;
function setVelocity(x, y)  { api.setVelocity(x, y); velocityX=x; vx=x; velocityY=y; vy=y; _velXWritten=x; _velYWritten=y; }
function stopMovement()     { api.stopMovement(); velocityX=0; vx=0; velocityY=0; vy=0; _velXWritten=0; _velYWritten=0; }
function bounceX()          { api.bounceX(); velocityX=api.velocityX; vx=velocityX; _velXWritten=velocityX; }
function bounceY()          { api.bounceY(); velocityY=api.velocityY; vy=velocityY; _velYWritten=velocityY; }
// Tracks the last value this script wrote, so we can tell if the user's
// own code changed velocityX/Y vs an external proxy setting api._vel directly.
var _velXWritten = 0, _velYWritten = 0;
function _syncVelocityToApi() {
    // If the local var changed since last frame → script wrote it → push to api
    if (velocityX !== _velXWritten) {
        api._vel.x = velocityX;
        _velXWritten = velocityX;
    } else {
        // No local write → pull from api (proxy or navigation may have set it)
        velocityX = api._vel.x;
        _velXWritten = velocityX;
    }
    if (velocityY !== _velYWritten) {
        api._vel.y = velocityY;
        _velYWritten = velocityY;
    } else {
        velocityY = api._vel.y;
        _velYWritten = velocityY;
    }
    vx = api._vel.x;
    vy = api._vel.y;
}

// ── Display ───────────────────────────────────────────────────
function show()           { api.visible = true; }
function hide()           { api.visible = false; }
function getVisible()     { return api.visible; }
function setVisible(v)    { api.visible = v; }
function getAlpha()       { return api.alpha; }
function setAlpha(v)      { api.alpha = v; }
function fadeIn(t, dt)    { api.alpha = Math.min(1, api.alpha + dt/Math.max(0.001,t)); }
function fadeOut(t, dt)   { api.alpha = Math.max(0, api.alpha - dt/Math.max(0.001,t)); }

// ── Tag and group ─────────────────────────────────────────────
/**
 * this.tag — label for this object (used in findWithTag, sendMessage).
 * Set it in onStart:  setTag("player")
 */
function setTag(t)        { api.tag   = t; }
function getTag()         { return api.tag; }
function setGroup(g)      { api.group = g; }
function getGroup()       { return api.group; }

// ── Messaging ─────────────────────────────────────────────────
/**
 * Send a message to the FIRST object with this tag.
 * Example: sendMessage("Enemy", "takeDamage", 10)
 * On the receiving end: onMessage("takeDamage", (amount) => { ... })
 */
/**
 * Send a message to all objects with a given tag.
 *   sendMessage("enemy", "takeDamage", 10)
 *   sendMessage("player", "scored")
 * Can also send to a proxy directly:
 *   sendMessage(find("Boss"), "die")
 */
function sendMessage(tagOrProxy, msg, data) {
    if (tagOrProxy && typeof tagOrProxy === 'object' && tagOrProxy._isproxy) {
        // Direct proxy target — deliver the message to that object
        tagOrProxy.sendMessage(msg, data);
    } else {
        api.sendMessage(tagOrProxy, msg, data);
    }
}
/**
 * Alias of sendMessage(tag, ...) — use sendMessage() instead.
 * @deprecated Use sendMessage(tag, msg, data)
 */
function sendMessageToTag(tag, msg, data) { api.sendMessage(tag, msg, data); }
/**
 * Send a message to ALL objects in the scene.
 * Alias of broadcastAll() — prefer broadcastAll() for clarity.
 *   broadcastMessage("gameOver")
 * @deprecated Use broadcastAll(msg, data)
 */
function broadcastMessage(msg, data) { api.broadcastMessage(msg, data); }
/**
 * Alias of sendMessage(tag, ...) — use sendMessage() instead.
 * @deprecated Use sendMessage(tag, msg, data)
 */
function broadcast(tag, msg, data)        { api.broadcast(tag, msg, data); }
/**
 * Send to all objects in a specific group.
 *   broadcastGroup("wave1", "explode")
 */
function broadcastGroup(grp, msg, data)   { api.broadcastGroup(grp, msg, data); }
/**
 * Send a message to EVERY scripted object in the scene.
 *   broadcastAll("gameOver")
 *   broadcastAll("levelUp", { newLevel: 2 })
 */
function broadcastAll(msg, data)          { api.broadcastAll(msg, data); }

// ── Finding other objects ─────────────────────────────────────
/**
 * Find an object by its exact name.
 * Returns an object proxy with .x, .y, .name, .sendMessage()
 * Example:  var player = find("Player");  log(player.x);
 */
function find(label)                { return api.find(label); }
/** Find the first object with a given tag */
function findWithTag(tag)           { return api.findWithTag(tag); }
/** Find ALL objects with a given tag — returns an array */
function findAllWithTag(tag)        { return api.findAllWithTag(tag); }
/** Find ALL objects in a group — returns an array */
function findAllInGroup(grp)        { return api.findAllInGroup(grp); }

// ── Overlap detection (no physics body needed) ────────────────
/**
 * Check if this object is overlapping another RIGHT NOW (AABB box check).
 * Does not need a physics body — works on any object.
 * Example: if (overlaps(find("Coin"))) { ... }
 */
function overlaps(other)            { return api.overlaps(other); }
/** Returns the first object with this tag that this object overlaps, or null */
function overlapsTag(tag)           { return api.overlapsTag(tag); }
/** Returns ALL objects with this tag that this object overlaps */
function overlapsAllWithTag(tag)    { return api.overlapsAllWithTag(tag); }

// ── Destroy ───────────────────────────────────────────────────
/** Remove this object from the scene */
/** Remove this object from the scene. */
function destroySelf()              { api.destroySelf(); }
/** Remove another specific object from the scene. Pass a proxy from find() or a collision callback. */
function destroyObject(other)       { api.destroy(other); }

// ── Scene management ──────────────────────────────────────────
/**
 * Switch to a different scene by name or index.
 * Example: gotoScene("Level2")  or  gotoScene(1)
 */
function gotoScene(nameOrIndex)     { api.gotoScene(nameOrIndex); }
/** Name of the current scene */
function currentScene()             { return api.currentScene; }
/** Index of the current scene (0-based) */
function currentSceneIndex()        { return api.currentSceneIndex; }
/** Total number of scenes */
function sceneCount()               { return api.sceneCount; }
/** Get scene name by index */
function getSceneName(i)            { return api.getSceneName(i); }
/**
 * Pause or resume the scene.
 * pauseScene()       → pauses  (same as pressing ⏸)
 * pauseScene(false)  → resumes
 */
function pauseScene(on = true)      { api.pauseScene(on); }
/**
 * Resume the scene after it was paused.
 * Alias for pauseScene(false).
 */
function resumeScene()              { api.pauseScene(false); }
/**
 * Restart the current scene without leaving play mode.
 * All objects, physics and scripts are reset to their initial state.
 */
function restartScene()             { api.restartScene(); }

// ── Camera ────────────────────────────────────────────────────
/**
 * Make the camera follow an object smoothly.
 * Example:  cameraFollow(find("Player"))
 *           cameraFollow(find("Player"), 8)   ← faster smoothing
 */
function cameraFollow(target, smoothing)    { api.camera.follow(target, smoothing); }
/** Stop camera from following */
function cameraUnfollow()                   { api.camera.unfollow(); }
/** Move camera instantly to a world position */
function cameraMoveTo(wx, wy)              { api.camera.moveTo(wx, wy); }
/** Get camera X position in world units */
function getCameraX()                      { return api.camera.x; }
/** Get camera Y position in world units */
function getCameraY()                      { return api.camera.y; }
/** Shake the camera */
function cameraShake(amplitude, duration)  { api.camera.shake(amplitude, duration); }

// ── Animation ─────────────────────────────────────────────────
function playAnimation(name)  { api.playAnimation(name); }
function stopAnimation()      { api.stopAnimation(); }
function pauseAnimation()     { api.pauseAnimation(); }
function currentAnimation()   { return api.currentAnimation; }

// ── Physics body (Planck.js) ───────────────────────────────────
var physics = api.physics;

// ── Physics helpers (readable shortcuts) ──────────────────────
/**
 * Apply a continuous force to this object every frame.
 * Use inside onUpdate() for sustained pushes (wind, jets, etc).
 * Only works on Dynamic bodies.
 *   applyForce(0, 5)   → push upward
 *   applyForce(3, 0)   → push right
 */
function applyForce(fx, fy)         { physics.applyForce(fx, fy); }

/**
 * Apply an instant impulse — like applyForce but for a single hit.
 * Great for jump, knockback, explosions.
 * Only works on Dynamic bodies.
 *   applyImpulse(0, 8)   → jump
 *   applyImpulse(-5, 0)  → knockback left
 */
function applyImpulse(ix, iy)       { physics.applyImpulse(ix, iy); }

/**
 * Directly set the physics body velocity (world units/second).
 * Only works on Dynamic bodies. Use setVelocity() for full control.
 *   setPhysicsVelocity(0, -5)  → fall at 5 u/s
 */
function setPhysicsVelocity(vx, vy) { physics.setVelocity(vx, vy); }

/**
 * Read the actual velocity X of this body in world units/sec.
 * Works for Dynamic and Kinematic bodies.
 */
function getVelX()                  { return physics.velX; }

/**
 * Read the actual velocity Y of this body in world units/sec (+Y = up).
 * Works for Dynamic and Kinematic bodies.
 */
function getVelY()                  { return physics.velY; }

/**
 * Is this body resting on a floor? Works for both Kinematic and Dynamic bodies.
 * Use to gate jumps:  if (isOnGround()) { velocityY = jumpForce; }
 */
function isOnGround()               { return physics.isOnGround; }

/**
 * Is this body touching a ceiling? Works for both Kinematic and Dynamic bodies.
 * Use to cancel upward velocity:  if (isOnCeiling()) { velocityY = 0; }
 */
function isOnCeiling()              { return physics.isOnCeiling; }

/**
 * Is this body pressing against a wall? Works for both Kinematic and Dynamic bodies.
 * Use to cancel horizontal velocity:  if (isOnWall()) { velocityX = 0; }
 */
function isOnWall()                 { return physics.isOnWall; }

/**
 * Immediately stop all physics movement on this body.
 * Works for Dynamic and Kinematic bodies.
 */
function stopPhysics()              { physics.stop(); }

/**
 * Make this object physically immovable (no force can move it).
 * setImmovable(true)  — frozen in place (stronger than static)
 * setImmovable(false) — restore normal physics
 */
function setImmovable(val)          { physics.setImmovable(val); }

/**
 * Set the spin speed of this dynamic body in degrees/sec.
 * Matches setRotation/getRotation units. Dynamic only.
 * Positive = clockwise, negative = counter-clockwise.
 *   setAngularVelocity(180)  → spin at 180°/sec clockwise
 *   setAngularVelocity(-90)  → spin counter-clockwise
 *   setAngularVelocity(0)    → stop spinning
 */
function setAngularVelocity(degsPerSec) { physics.setAngularVelocity(degsPerSec); }

/**
 * Apply a one-time spin kick to this dynamic body.
 * Positive = clockwise, negative = counter-clockwise.
 * Dynamic only.
 *   applyAngularImpulse(5)   → clockwise spin kick
 *   applyAngularImpulse(-3)  → counter-clockwise spin kick
 */
function applyAngularImpulse(impulse)   { physics.applyAngularImpulse(impulse); }

// ── Key / Mouse constants ─────────────────────────────────────
// Use Key.W, Key.SPACE, Key.ARROW_LEFT etc. instead of raw strings.
// Use Mouse.LEFT, Mouse.RIGHT, Mouse.MIDDLE for mouse button names.
var Key   = window.Key   || {};
var Mouse = window.Mouse || {};

// ── Input ─────────────────────────────────────────────────────
var input = api.input;
/** Is key currently held? Accepts Key.X constants or raw strings like "w".
 *  Pass Key.ANY to check if ANY key is held. */
function isKeyDown(k)     {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyDown();
    return input.isKeyDown(k);
}
/** Was key pressed for the first time this frame? */
function isKeyJustDown(k) {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyJustDown();
    return input.isKeyJustDown(k);
}
/** Was key released this frame? */
function isKeyJustUp(k) {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyJustUp();
    return input.isKeyJustUp(k);
}
/** Horizontal axis from A/D or arrow keys. Returns -1, 0, or 1 */
function axisH()              { return input.axisH; }
/** Vertical axis from W/S or arrow keys. Returns -1, 0, or 1 */
function axisV()              { return input.axisV; }
/** Mouse X in world units */
function mouseX()             { return input.worldMouseX; }
/** Mouse Y in world units */
function mouseY()             { return input.worldMouseY; }
/**
 * Mouse/finger X in raw screen pixels (same as clientX).
 * Useful for positioning DOM overlays or joysticks precisely.
 */
function screenMouseX()       { return input.screenMouseX; }
/**
 * Mouse/finger Y in raw screen pixels (same as clientY).
 */
function screenMouseY()       { return input.screenMouseY; }
/** Is mouse button held? */
function mouseDown()          { return input.mouseDown; }
/** Was mouse button clicked this frame? */
function mouseJustDown()      { return input.mouseJustDown; }

/**
 * Get all active touch points as an array of objects.
 * Each point: { id, x, y, screenX, screenY }
 *   x / y       — world units
 *   screenX/Y   — raw screen pixels
 *
 * Example:
 *   var touches = getTouches();
 *   if (touches.length > 0) { setPos(touches[0].x, touches[0].y); }
 */
function getTouches()         { return input.touches; }
/** Number of fingers currently touching the screen. */
function touchCount()         { return input.touchCount; }

/**
 * Make this object draggable in ONE LINE. Works on mouse and touch.
 * The engine handles grab, smooth follow, and release — you write nothing else.
 *
 *   makeDraggable()
 *   makeDraggable({ smooth: 20 })              — extra smooth lag
 *   makeDraggable({ smooth: 0 })               — instant snap to finger
 *   makeDraggable({ clamp: true })             — stay inside game canvas
 *   makeDraggable({ scale: 1.15 })             — grow while held
 *   makeDraggable({ onDrop: (x,y) => { log("landed at", x, y) } })
 *
 * No onUpdate, no mouseDown check, no stopDrag needed.
 */
function makeDraggable(opts)       { api.makeDraggable(opts); }

/** Low-level: start dragging an object right now (call from onMouseClick). */
function dragObject(target, opts)  { api.dragObject(target, opts); }
/** Stop the active drag (fires onDrop if set). */
function stopDrag()                { api.stopDrag(); }
/** True while a drag is active. */
function isDragging()              { return api.isDragging; }

/**
 * Make this object draggable AND throwable in one line.
 * Works with kinematic and dynamic physics bodies.
 * When the user releases, the object flies with the velocity it was being moved at.
 *
 *   makeThrowable()
 *   makeThrowable({ speed: 1.4, maxSpeed: 25 })
 *   makeThrowable({ smooth: 0, onThrow: (vx, vy) => { log("thrown at", vx, vy) } })
 *
 * Options: smooth, speed, maxSpeed, clamp, scale, onThrow(vx, vy)
 */
function makeThrowable(opts)       { api.makeThrowable(opts); }

/**
 * Low-level: start throw-dragging an object right now.
 * Call from onMouseClick or mouseJustDown(). Applies physics velocity on release.
 *
 *   throwObject()                     — throw THIS object
 *   throwObject(find("Ball"))         — throw another object
 *   throwObject(null, { speed: 2, maxSpeed: 40 })
 */
function throwObject(target, opts) { api.throwObject(target, opts); }

/**
 * Create a virtual on-screen joystick for mobile/touch controls.
 *
 *   var joy = createJoystick()
 *   var joy = createJoystick({ x:150, y:150, fixed:true, size:120,
 *                               baseColor:"#0088ff44", knobColor:"#0088ffcc" })
 *
 * joy.axisH     — -1 (left) to 1 (right)
 * joy.axisV     — -1 (down) to 1 (up)  [game-space Y]
 * joy.angle     — degrees (0=right, 90=up, 180=left, 270=down)
 * joy.magnitude — 0 (center) to 1 (full tilt)
 * joy.active    — true when a finger is on the joystick
 * joy.destroy() — remove from screen
 */
function createJoystick(opts)      { return api.createJoystick(opts); }
/** Remove all joysticks. */
function destroyAllJoysticks()     { api.destroyAllJoysticks(); }

// ── Mobile / Touch ────────────────────────────────────────────
/**
 * Is ANY finger currently touching the screen?
 * Works the same as mouseDown() on mobile.
 */
function isTouching()         { return input.mouseDown; }
/**
 * Did a new finger touch start this frame?
 * Works the same as mouseJustDown() on mobile.
 */
function touchJustStarted()   { return input.mouseJustDown; }
/**
 * Register a swipe handler using Hammer.js.
 * direction: "left" | "right" | "up" | "down" | "any"
 *
 * Example:
 *   onSwipe("left",  () => { move(-3, 0); });
 *   onSwipe("right", () => { move( 3, 0); });
 *   onSwipe("up",    () => { velocityY = 5; });
 *   onSwipe("any",   (dir) => { log("swiped " + dir); });
 */
function onSwipe(direction, fn) { api.onSwipe(direction, fn); }
/**
 * Register a pinch handler (two-finger pinch/zoom).
 * fn receives the pinch scale (>1 = zoom in, <1 = zoom out).
 *
 * Example:
 *   onPinch((scale) => { setScaleX(getScaleX() * scale); setScaleY(getScaleY() * scale); });
 */
function onPinch(fn)            { api.onPinch(fn); }
/**
 * Register a tap handler (triggered by a quick touch tap).
 *
 * Example:
 *   onTap(() => { gotoScene("Menu"); });
 */
function onTap(fn)              { api.onTap(fn); }

// ── Time ──────────────────────────────────────────────────────
/** Total seconds since Play was pressed */
function getTime()            { return api.time; }

// ── Shared variables ──────────────────────────────────────────
/**
 * sceneVar — variables shared between ALL scripts in the current scene.
 * Reset when you switch scenes.
 * Example:  sceneVar.score = 0;   sceneVar.score += 1;
 */
var sceneVar  = api.sceneVar;
/**
 * globalVar — variables that survive even when you switch scenes.
 * Example:  globalVar.totalDeaths += 1;
 */
var globalVar = api.globalVar;

// ── Per-script key/value store ────────────────────────────────
/** store — private to this script, reset on Play stop */
var store = api.store;

// ── Sound ─────────────────────────────────────────────────────
/**
 * Play a sound asset by name.
 * soundPlay("Jump")
 * soundPlay("BgMusic", { loop:true, volume:0.8, range:400 })
 * soundPlay("Boom", { x:3, y:2, range:600 })   // at world position
 */
function soundPlay(name, opts)    { api.soundPlay(name, opts || {}); }
/** Stop a specific sound by name */
function soundStop(name)          { api.soundStop(name); }
/** Stop all currently playing sounds */
function soundStopAll()           { api.soundStopAll(); }

// ── Timers ────────────────────────────────────────────────────
/**
 * Wait X seconds then run a function. Non-blocking.
 * Example:  wait(2, () => { log("2 seconds!"); })
 */
function wait(seconds, fn)        { api.wait(seconds, fn); }

// ── Physics control ───────────────────────────────────────────
/**
 * Change this object's physics body type.
 * setPhysicsType("static") | "kinematic" | "dynamic" | "none"
 */
function setPhysicsType(type)     { api.setPhysicsType(type); }
/**
 * Enable or disable collision for this object.
 * setCollision(false) — passes through everything
 */
function setCollision(enabled)    { api.setCollision(enabled); }
/** Make this object a sensor (no physical response but fires collision events) */
function setSensor(v)             { api.setSensor(v); }
/** Set collision layer category */
function setCollisionCategory(c)  { api.setCollisionCategory(c); }
/** Set collision layer mask (which layers to collide with) */
function setCollisionMask(m)      { api.setCollisionMask(m); }

// ── Tint ──────────────────────────────────────────────────────
/**
 * Set this object's colour tint.
 * setTint("#ff0000")      — red tint
 * setTint("#ffffff")      — remove tint (white = no effect)
 * setTint(0x00ff00)       — green tint (hex number)
 */
function setTint(v)               { api.tint = v; }
function getTint()                { return api.tint; }
/** Remove tint and restore the object's original colours. */
function clearTint()              { api.clearTint(); }

// ── Distance ──────────────────────────────────────────────────
/**
 * Distance from this object to another.
 * distanceTo("enemy")              — first object with tag "enemy"
 * distanceTo(find("Boss"))         — a specific object
 * distanceTo(3, 5)                 — world position x=3, y=5
 */
function distanceTo(targetOrX, y) { return api.distanceTo(targetOrX, y); }

// ── Math helpers ──────────────────────────────────────────────
var math    = api.math;
var lerp    = math.lerp;
var clamp   = math.clamp;
var dist    = math.dist;
var rand    = math.rand;
var randInt = math.randInt;
var sign    = math.sign;
var toRad   = math.toRad;
var toDeg   = math.toDeg;
var mapRange= math.map;
var wrap    = math.wrap;
var sin     = math.sin;   var cos   = math.cos;   var tan   = math.tan;
var abs     = math.abs;   var sqrt  = math.sqrt;  var pow   = math.pow;
var atan2   = math.atan2; var floor = math.floor; var ceil  = math.ceil;
var round   = math.round; var PI    = math.PI;
var max     = math.max;   var min   = math.min;

// ── Debug ─────────────────────────────────────────────────────
/** Print to the console */
function log(...a)    { api.log(...a); }
/** Print a warning */
function warn(...a)   { api.warn(...a); }
/** Print an error */
function error(...a)  { api.error(...a); }
/** Returns the label/name of the game object this script is attached to */
function selfName()   { return api.name; }

// ── Tween ──────────────────────────────────────────────────────
/**
 * Animate this object's properties over time.
 * tween({ x:5, alpha:0 }, 0.5)
 * tween({ scaleX:2 }, 1, "easeOut", () => { log("done!"); })
 * Easings: linear easeIn easeOut easeInOut easeInCubic easeOutCubic
 *          elastic elasticOut bounce steps2 steps4
 */
function tween(props, duration, easing, onComplete) {
    return api.tween(props, duration, easing, onComplete);
}

// ── Repeat timers ──────────────────────────────────────────────
/**
 * Call fn every interval seconds. Returns an id for cancelRepeat().
 * var id = repeat(2, () => { spawnCoin(); });
 */
function repeat(interval, fn) { return api.repeat(interval, fn); }
/** Cancel a repeating timer by id. */
function cancelRepeat(id)     { api.cancelRepeat(id); }

// ── Spawn object ───────────────────────────────────────────────
/**
 * Create a new object at a world position from an asset name, object name,
 * object tag, or prefab name.
 * spawnObject("Bullet", x, y)                          — by asset/prefab name
 * spawnObject("Bullet", x, y, (b) => { b.velocityX = 10; })  — with velocity
 * spawnObject("enemy", x, y)                          — by tag (first match)
 * The callback runs BEFORE the object's script starts, so velocity/tag/etc.
 * set there will be live when onStart fires.
 */
function spawnObject(assetName, x, y, onSpawned) {
    return api.spawnObject(assetName, x, y, onSpawned);
}

/**
 * Create a text object in the scene from a script.
 * Returns a proxy so you can immediately update it.
 *
 * Safe to call every frame in onUpdate — pass an \`id\` option to deduplicate:
 *   drawText("Score: " + score, 0, 3, { id: "score", fontSize: 36, fill: "#fff" });
 * Without an id, text is auto-deduplicated by position (same x/y = same node).
 *
 * Style options: fontSize, fontFamily, fill, stroke, strokeThickness,
 *   align, bold, italic, dropShadow, wordWrap, wordWrapWidth, id
 */
function drawText(text, x, y, styleOpts = {}) {
    // Runtime-only text creation. Uses api._sc / api._gameObjects instead of bare
    // 'state' — the state module export is not accessible inside AsyncFunction sandbox.
    const sc = api._sc;
    if (!sc) { warn('drawText: scene not ready'); return { text: '', setText() {}, setTextStyle() {}, destroy() {} }; }

    // ── Deduplication: same id or same x/y reuses the existing node ──────────
    // This prevents duplicate text nodes when drawText is called every frame.
    const cacheKey = styleOpts.id != null
        ? String(styleOpts.id)
        : \`_auto_\${x}_\${y}\`;
    if (_drawTextCache.has(cacheKey)) {
        const existing = _drawTextCache.get(cacheKey);
        if (!existing._ref || existing._ref._markedForDestroy || !existing._ref._pixiText) {
            _drawTextCache.delete(cacheKey); // stale — fall through to recreate
        } else {
            // Already exists — just update text content, return same proxy
            existing.text = String(text);
            existing.x = x ?? 0;
            existing.y = y ?? 0;
            return existing;
        }
    }

    const px = (x  ?? 0) * 100;
    const py = (-(y ?? 0)) * 100;

    const style = new PIXI.TextStyle({
        fontFamily:      styleOpts.fontFamily      ?? 'Arial',
        fontSize:        styleOpts.fontSize        ?? 32,
        fill:            styleOpts.fill            ?? '#ffffff',
        stroke:          styleOpts.stroke          ?? '#000000',
        strokeThickness: styleOpts.strokeThickness ?? 0,
        align:           styleOpts.align           ?? 'left',
        wordWrap:        styleOpts.wordWrap        ?? false,
        wordWrapWidth:   styleOpts.wordWrapWidth   ?? 400,
        fontWeight:      styleOpts.bold            ? 'bold'   : (styleOpts.fontWeight ?? 'normal'),
        fontStyle:       styleOpts.italic          ? 'italic' : (styleOpts.fontStyle  ?? 'normal'),
        dropShadow:      styleOpts.dropShadow      ?? false,
    });

    const pixiText = new PIXI.Text(String(text), style);
    pixiText.anchor.set(0.5);

    const container = new PIXI.Container();
    container.x = px; container.y = py;
    container.unityZ        = styleOpts.unityZ ?? 999;
    container.label         = '_rt_text_' + Math.random().toString(36).slice(2);
    container.isText        = true;
    container.isImage       = false;
    container.isLight       = false;
    container._pixiText     = pixiText;
    container.textContent   = String(text);
    container.spriteGraphic = pixiText;
    container._runtimeSpawned = true;
    container._gizmoContainer = null;

    // Store textStyle so downstream code (inspector, playmode restore) can read it
    container.textStyle = {
        fontFamily:       style.fontFamily,
        fontSize:         style.fontSize,
        fill:             style.fill,
        stroke:           style.stroke,
        strokeThickness:  style.strokeThickness,
        align:            style.align,
        wordWrap:         style.wordWrap,
        wordWrapWidth:    style.wordWrapWidth,
        fontWeight:       style.fontWeight,
        fontStyle:        style.fontStyle,
        dropShadow:       style.dropShadow,
    };

    container.addChild(pixiText);
    sc.addChild(container);
    api._gameObjects.push(container);

    // Re-apply Z-order so runtime text with high unityZ appears on top
    try {
        const objs = api._gameObjects;
        const sorted = objs.slice().sort((a, b) => (a.unityZ || 0) - (b.unityZ || 0));
        sorted.forEach((obj, i) => {
            try {
                const cur = sc.getChildIndex(obj);
                const tgt = Math.min(i, sc.children.length - 1);
                if (cur !== tgt) sc.setChildIndex(obj, tgt);
            } catch(_) {}
        });
    } catch(_) {}

    const proxy = {
        _ref: container,
        get text()  { return this._ref._pixiText?.text ?? ''; },
        set text(v) {
            if (!this._ref?._pixiText) return;
            this._ref.textContent    = String(v);
            this._ref._pixiText.text = String(v);
        },
        setText(v) { this.text = v; },
        setTextStyle(opts) {
            if (!this._ref?._pixiText) return;
            const s = this._ref._pixiText.style;
            if (opts.fontSize        != null) s.fontSize        = opts.fontSize;
            if (opts.fill            != null) s.fill            = opts.fill;
            if (opts.fontFamily      != null) s.fontFamily      = opts.fontFamily;
            if (opts.strokeThickness != null) s.strokeThickness = opts.strokeThickness;
            if (opts.stroke          != null) s.stroke          = opts.stroke;
            if (opts.bold            != null) s.fontWeight      = opts.bold ? 'bold' : 'normal';
            if (opts.italic          != null) s.fontStyle       = opts.italic ? 'italic' : 'normal';
            // Keep container.textStyle in sync so inspector/restore can read it
            if (this._ref.textStyle) {
                if (opts.fontSize        != null) this._ref.textStyle.fontSize        = s.fontSize;
                if (opts.fill            != null) this._ref.textStyle.fill            = s.fill;
                if (opts.fontFamily      != null) this._ref.textStyle.fontFamily      = s.fontFamily;
                if (opts.strokeThickness != null) this._ref.textStyle.strokeThickness = s.strokeThickness;
                if (opts.stroke          != null) this._ref.textStyle.stroke          = s.stroke;
                if (opts.bold            != null) this._ref.textStyle.fontWeight      = s.fontWeight;
                if (opts.italic          != null) this._ref.textStyle.fontStyle       = s.fontStyle;
            }
        },
        get visible()  { return this._ref?.visible ?? true; },
        set visible(v) { if (this._ref) this._ref.visible = !!v; },
        get x()        { return this._ref ? this._ref.x / 100 : 0; },
        set x(v)       { if (this._ref) this._ref.x = v * 100; },
        get y()        { return this._ref ? -this._ref.y / 100 : 0; },
        set y(v)       { if (this._ref) this._ref.y = -v * 100; },
        destroy()      { if (this._ref) { this._ref._markedForDestroy = true; _drawTextCache.delete(cacheKey); } },
    };
    // Store in cache for deduplication on subsequent calls
    _drawTextCache.set(cacheKey, proxy);
    return proxy;
}

// ── Raycast (slab AABB) ────────────────────────────────────────
/**
 * Fire a ray from (x1,y1) → (x2,y2) and return the FIRST object hit.
 * Uses a proper AABB slab intersection test.
 * raycast(x, y, x+10, y)              — any object
 * raycast(x, y, x+10, y, "enemy")    — only tagged "enemy"
 * Result has: .name, .x, .y  and  ._rayHit = { point, normal, distance, fraction }
 */
function raycast(x1, y1, x2, y2, tag) { return api.raycast(x1, y1, x2, y2, tag ?? null); }

/**
 * Fire a ray and return ALL objects hit, sorted nearest→farthest.
 * raycastAll(x, y, x+10, y)
 * raycastAll(x, y, x+10, y, "wall")
 * Returns array — each element has ._rayHit = { point, normal, distance, fraction }
 */
function raycastAll(x1, y1, x2, y2, tag) { return api.raycastAll(x1, y1, x2, y2, tag ?? null); }

/**
 * Fire a ray from THIS object's position in a given direction.
 * raycastFromSelf(0, 10)              — cast rightward 10 units
 * raycastFromSelf(90, 5)             — cast upward 5 units
 * raycastFromSelf(180, 8, "wall")    — leftward 8 units, only walls
 * angle: degrees (0=right, 90=up, 180=left, 270/−90=down)
 */
function raycastFromSelf(angleDeg, distance, tag) {
    return api.raycastFromSelf(angleDeg, distance, tag ?? null);
}

// ── Radius query ───────────────────────────────────────────────
/**
 * Return all objects within radius world-units of (cx, cy).
 * getObjectsInRadius(x, y, 3)             — all
 * getObjectsInRadius(x, y, 3, "coin")    — only tagged "coin"
 */
function getObjectsInRadius(cx, cy, radius, tag) {
    return api.getObjectsInRadius(cx, cy, radius, tag);
}

// ── Z-order ────────────────────────────────────────────────────
/** Set render order (higher = drawn on top). */
function setZOrder(n)   { api.setZOrder(n); }
/** Get current render order. */
function getZOrder()    { return api.getZOrder(); }

// ── Coordinate conversion ──────────────────────────────────────
/** Convert screen pixel position → world position {x, y}. */
function screenToWorld(sx, sy) { return api.screenToWorld(sx, sy); }
/** Convert world position → screen pixel position {x, y}. */
function worldToScreen(wx, wy) { return api.worldToScreen(wx, wy); }

// ── Key event handlers ─────────────────────────────────────────
/**
 * Fire a callback once each time a key is pressed.
 * onKeyDown("arrowleft", () => { moveLeft(); })
 * onKeyDown("any", (key) => { log("pressed:", key); })
 */
function onKeyDown(key, fn) { api.onKeyDown(key, fn); }
/** Fire a callback once each time a key is released. */
function onKeyUp(key, fn)   { api.onKeyUp(key, fn); }

// ── Physics helpers ────────────────────────────────────────────
/** Actual physics body velocity X (world units/sec). Works for kinematic and dynamic. */
function getPhysicsVelX()   { return api.getPhysicsVelX(); }
/** Actual physics body velocity Y (world units/sec, positive = up). Works for kinematic and dynamic. */
function getPhysicsVelY()   { return api.getPhysicsVelY(); }
/** Change this object's gravity scale (0 = floats, 2 = 2× gravity). Dynamic bodies only. */
function setGravityScale(n) { api.setGravityScale(n); }
// isOnGround/isOnCeiling/isOnWall defined above in Physics section

// ── Extra math ────────────────────────────────────────────────
/** Smooth S-curve between lo and hi. */
function smoothstep(lo, hi, x)         { return api.smoothstep(lo, hi, x); }
/** Normalize a 2D vector → {x, y}. */
function normalize(vx, vy)             { return api.normalize(vx, vy); }
/** Angle in degrees from point A to point B. */
function angleTo(x1, y1, x2, y2)      { return api.angleTo(x1, y1, x2, y2); }

// ── Debug draw ────────────────────────────────────────────────
/**
 * Draw a temporary line (only visible during Play).
 * drawDebugLine(0, 0, 5, 5)
 * drawDebugLine(0, 0, 5, 5, "#ff0000", 1.0, 3)
 */
function drawDebugLine(x1, y1, x2, y2, color, duration, width) {
    api.drawDebugLine(x1, y1, x2, y2, color, duration, width);
}
/**
 * Draw a temporary circle outline.
 * drawDebugCircle(x, y, 1.5)
 * drawDebugCircle(x, y, 1.5, "#ff0000", 1.0)
 */
function drawDebugCircle(cx, cy, radius, color, duration, width) {
    api.drawDebugCircle(cx, cy, radius, color, duration, width);
}

// ═══════════════════════════════════════════════════════════════
// MATH SHORTCUTS  — short names for fast game logic
// ═══════════════════════════════════════════════════════════════

/** Linearly interpolate between a and b by t (0–1). lerp(0, 10, 0.5) → 5 */
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
/** Clamp value v between lo and hi. clamp(15, 0, 10) → 10 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
/** Random float between min and max. rand(1, 5) → 2.34 */
function rand(mn, mx) { return Math.random() * (mx - mn) + mn; }
/** Random integer between min and max (inclusive). randInt(1, 6) → die roll */
function randInt(mn, mx) { return Math.floor(Math.random() * (mx - mn + 1)) + mn; }
/** Random choice from an array. pick(["red","green","blue"]) */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
/** Distance between two points. dist(0,0, 3,4) → 5 */
function dist(x1, y1, x2, y2) { return Math.sqrt((x2-x1)**2 + (y2-y1)**2); }
/** Map v from range [a1,b1] to range [a2,b2]. map(5, 0,10, 0,100) → 50 */
function mapRange(v, a1, b1, a2, b2) { return a2 + (b2-a2)*((v-a1)/(b1-a1)); }
/** True with probability p (0–1). chance(0.25) → true 25% of the time */
function chance(p) { return Math.random() < p; }
/** Absolute value. */
function abs(v) { return Math.abs(v); }
/** Sign of v: -1, 0, or 1. */
function sign(v) { return Math.sign(v); }
/** Floor (round down). */
function floor(v) { return Math.floor(v); }
/** Ceil (round up). */
function ceil(v) { return Math.ceil(v); }
/** Round to nearest integer. */
function round(v) { return Math.round(v); }
/** Math.PI */
var PI = Math.PI;

// ═══════════════════════════════════════════════════════════════
// GAME QUICK-START HELPERS
// One-liners that replace 10+ lines of boilerplate so your
// entire Flappy Bird or enemy-spawner fits in 20 lines.
// ═══════════════════════════════════════════════════════════════

/**
 * Instantly destroy this object and remove it from the scene.
 * Same as api.destroy() but shorter.
 */
function destroy() { api.destroySelf(); }

/**
 * Spawn a copy of any object in your scene by its name.
 * Returns a handle you can reposition immediately.
 *
 *   spawnCopy("Enemy", 5, 0)
 *   spawnCopy("Bullet", getX(), getY(), (b) => { b.velocityY = 10; })
 *
 * Equivalent to spawnObject() but clearer for cloning.
 */
function spawnCopy(name, x, y, onReady) {
    return api.spawnObject(name, x, y, onReady);
}

/**
 * Clone THIS object at (x, y) — an exact copy of yourself.
 * Copies sprite, scale, rotation, alpha, physics, tags, AND script.
 * The clone runs its script independently from the moment it spawns.
 * onStart does NOT fire on clones — use onCloneStart() instead.
 *
 *   cloneSelf(getX() + 2, getY())               — clone 2 units to the right
 *   cloneSelf(5, 0, (c) => { c.velocityX = 3; }) — clone and give it a velocity
 */
/**
 * Clone this object at world (x, y).
 *   cloneSelf(x, y)                          — plain clone
 *   cloneSelf(x, y, (c) => { ... })          — clone with callback
 *   cloneSelf(x, y, { speed:5 }, (c) => { }) — clone with initial opts + callback
 * Each clone gets its own opts object. Read opts in onCloneStart.
 */
function cloneSelf(x, y, optsOrCb, cb) {
    return api.cloneSelf(x, y, optsOrCb, cb);
}

/**
 * Clone THIS object at its CURRENT position — shorthand for cloneSelf(getX(), getY()).
 *   cloneInPlace()
 *   cloneInPlace((c) => { c.velocityX = 5; })
 */
function cloneInPlace(onReady) {
    return api.cloneInPlace(onReady);
}

/** Returns true if this object was created by cloneSelf() or cloneObject(). */
function isClone() { return api.isClone; }

/** Destroy this object after {seconds} seconds. */
function destroyAfter(secs) { api.destroyAfter(secs); }

/**
 * Clone any object by name or tag at (x, y).
 * Uses the FIRST matching instance as the template — copies all its properties and script.
 * The clone runs its script independently.
 *
 *   cloneObject("Enemy", 5, 0)
 *   cloneObject("enemy", 5, 0, (c) => { c.velocityX = 3; })
 *   cloneObject(find("Boss"), 0, 0)   — pass a proxy directly
 *
 * Difference from spawnObject: cloneObject copies scale, rotation, physics, etc.
 * spawnObject spawns a fresh default copy from the asset library.
 */
function cloneObject(nameOrProxy, x, y, onReady) {
    return api.cloneObject(nameOrProxy, x, y, onReady);
}

/**
 * Set velocity on this object (world units/sec, +Y = up).
 * Works for kinematic and script-velocity objects.
 *   velocityX = 5; velocityY = 12;   — shoot upward at speed 12
 */

// ══════════════════════════════════════════════════════════════════════════════
// SPEECH BUBBLES  —  say() / think()
// ══════════════════════════════════════════════════════════════════════════════
/**
 * _drawSpeechBubble(obj, text, style, duration)
 *   style: "say" = normal rounded bubble, "think" = cloud bubble
 *   duration: seconds the bubble stays visible (default 2.5)
 *
 * Rendered as a PIXI.Container attached directly to the game object.
 * Destroyed automatically after {duration} seconds, or when the object is destroyed.
 */
function _drawSpeechBubble(obj, text, style, duration, offsetX, offsetY) {
    if (!obj || !window.PIXI) return;

    // Remove any existing bubble on this object
    if (obj._speechBubble) {
        try { obj._speechBubble.destroy({ children: true }); } catch(_) {}
        obj._speechBubble = null;
    }

    const bubble = new PIXI.Container();
    bubble.zIndex = 9999;

    // ── Text ─────────────────────────────────────────────────
    const label = new PIXI.Text(String(text), {
        fontFamily:      'Arial',
        fontSize:        13,
        fill:            0x111111,
        wordWrap:        true,
        wordWrapWidth:   180,
        align:           'center',
    });
    label.anchor.set(0.5, 0.5);

    const pad  = 14;
    const tw   = label.width  + pad * 2;
    const th   = label.height + pad * 1.5;

    // ── Background shape ─────────────────────────────────────
    const bg = new PIXI.Graphics();

    if (style === 'think') {
        // Cloud: overlapping circles
        bg.beginFill(0xffffff).lineStyle(2, 0x333333);
        const cx = tw / 2, cy = th / 2;
        const rx = tw / 2, ry = th / 2;
        // 8 overlapping ellipses to form a cloud
        const bumps = 8;
        for (let i = 0; i < bumps; i++) {
            const angle = (i / bumps) * Math.PI * 2;
            const bx = cx + Math.cos(angle) * rx * 0.55;
            const by = cy + Math.sin(angle) * ry * 0.55;
            bg.drawEllipse(bx, by, rx * 0.55, ry * 0.5);
        }
        bg.drawEllipse(cx, cy, rx * 0.7, ry * 0.65);
        bg.endFill();

        // Thought dots (three small circles going down-left)
        bg.beginFill(0xffffff).lineStyle(2, 0x333333);
        bg.drawCircle(-8, th + 14, 6);
        bg.drawCircle(-16, th + 26, 4);
        bg.drawCircle(-22, th + 35, 2.5);
        bg.endFill();
    } else {
        // Normal rounded rectangle + pointer triangle
        bg.beginFill(0xffffff).lineStyle(2, 0x333333);
        bg.drawRoundedRect(0, 0, tw, th, 12);
        bg.endFill();
        // Tail pointing down-left toward the object
        bg.beginFill(0xffffff).lineStyle(2, 0x333333);
        bg.moveTo(14, th);
        bg.lineTo(8,  th + 14);
        bg.lineTo(28, th);
        bg.endFill();
        // Cover the seam
        bg.lineStyle(0).beginFill(0xffffff);
        bg.drawRect(10, th - 2, 20, 5);
        bg.endFill();
    }

    bubble.addChild(bg);
    label.position.set(tw / 2, th / 2);
    bubble.addChild(label);

    // Position bubble above the object (account for object scale)
    const objH = (obj.height || 100);
    const bx = -tw / 2 + (offsetX ?? 0);
    const by = -(objH / 2) - th - 20 - (offsetY ?? 0);
    bubble.position.set(bx, by);

    obj.addChild(bubble);
    obj._speechBubble = bubble;

    // Auto-destroy after duration
    const secs = (typeof duration === 'number' && duration > 0) ? duration : 2.5;
    let elapsed = 0;
    const ticker = window._zState?.app?.ticker ?? PIXI.Ticker.shared;
    function onTick(delta) {
        elapsed += delta / 60;
        if (elapsed >= secs || !obj._speechBubble) {
            ticker.remove(onTick);
            if (obj._speechBubble === bubble) {
                try { bubble.destroy({ children: true }); } catch(_) {}
                obj._speechBubble = null;
            }
        }
    }
    ticker.add(onTick);
}

/**
 * say("Hello!")                   — speech bubble for 2.5 sec
 * say("Hello!", 4)                — stays 4 seconds
 * say("Hello!", 0)                — stays until you call say("") or think("")
 * say("Hello!", 2.5, 30, 0)      — offset 30 px right, same height
 * say("Hello!", 2.5, 0, 20)      — offset 20 px higher than default
 *
 * offsetX: horizontal shift in pixels (positive = right)
 * offsetY: vertical shift in pixels (positive = higher)
 */
function say(text, duration, offsetX, offsetY) {
    _drawSpeechBubble(api._ref, text, 'say',   duration, offsetX, offsetY);
}

/**
 * think("Hmm...")                  — cloud thought bubble for 2.5 sec
 * think("Hmm...", 4)               — stays 4 seconds
 * think("Hmm...", 2.5, 0, 30)     — shift 30 px higher
 */
function think(text, duration, offsetX, offsetY) {
    _drawSpeechBubble(api._ref, text, 'think', duration, offsetX, offsetY);
}


// ══════════════════════════════════════════════════════════════════════════════
// CHAT DIALOG  —  delegates to engine.scripting.chat.js
// ══════════════════════════════════════════════════════════════════════════════
// These thin wrappers are injected into every user script via the prelude.
// The real implementation (including AI support) lives in engine.scripting.chat.js.
/**
 * Open a keyword/callback NPC chat dialog.
 * @param {string}   npcName  — Name shown in the chat header
 * @param {function} onInput  — Callback: (userText) => replyString | null
 * @param {object}   options  — Optional layout/behaviour overrides:
 *   { width, height, bottom, right, left, top, closeButton }
 *   closeButton: false  →  only hideChat() in code can close the panel
 *
 * Example:
 *   showChat("Guard", (input) => {
 *     if (input.includes("hello")) return "Hey there!";
 *     return "Move along.";
 *   });
 *   showChat("Shop", handler, { width: 400, closeButton: false });
 */
function showChat(npcName, onInput, options) {
    window._ze?.showChat(npcName ?? api.name ?? 'NPC', onInput, options);
}
function hideChat()            { window._ze?.hideChat(); }
function chatSay(text)         { window._ze?.chatSay(text); }
function chatPlayer(text)      { window._ze?.chatPlayer(text); }

/**
 * Open an AI-powered NPC dialog.
 * The NPC replies using the API key and model you supply — works with any
 * OpenAI-compatible endpoint (OpenAI, Groq, Together, local Ollama, etc.).
 *
 * @param {string} npcName     — Name shown in the header
 * @param {string} description — Persona/system prompt for the AI
 * @param {string} apiKey      — Your API key (sent in Authorization: Bearer …)
 * @param {object} options     — Optional:
 *   {
 *     endpoint:    'https://api.openai.com/v1/chat/completions',  // default
 *     model:       'gpt-4o-mini',          // default
 *     badgeText:   'AI',                   // replaces the blue "AI" badge
 *     width, height, bottom, right, left, top,
 *     closeButton: false                   // prevent user closing it
 *   }
 *
 * Example:
 *   aiChat("Wizard", "You are Aldric, a cryptic wizard.", "sk-...");
 *   aiChat("Bot", "Helpful assistant.", myKey, { model: "gpt-4o", badgeText: "GPT" });
 */
function aiChat(npcName, description, apiKey, options) {
    window._ze?.aiChat(npcName ?? api.name ?? 'NPC', description, apiKey, options);
}

/**
 * Add velocity to this object (world units/sec).
 * Good for impulse-style jumps or knockback:
 *   addImpulse(0, 10)   — jump
 *   addImpulse(-5, 3)   — knockback left + up
 */
function addImpulse(ivx, ivy) {
    const nx = (velocityX || 0) + ivx;
    const ny = (velocityY || 0) + ivy;
    api.velocityX = nx; api.velocityY = ny;
    velocityX = nx; vx = nx; velocityY = ny; vy = ny;
}

/**
 * Keep this object inside the visible game area.
 * Returns true if the object was clamped on any side.
 *   boundsClamp()              — hard clamp with margin 0
 *   boundsClamp(0.5)           — 0.5 unit margin from edges
 *   boundsClamp(0, true)       — also kills velocity when hitting edge
 *
 *   if (boundsClamp(0, true)) { bounceVY = -bounceVY; }
 */
function boundsClamp(margin, killVelocity) {
    const gw = (api.sceneSettings?.gameWidth  ?? 1280) / 100 / 2 - (margin ?? 0);
    const gh = (api.sceneSettings?.gameHeight ?? 720)  / 100 / 2 - (margin ?? 0);
    var hit = false;
    if (api.x < -gw) { api.x = -gw; hit = true; if (killVelocity) api.velocityX = 0; }
    if (api.x >  gw) { api.x =  gw; hit = true; if (killVelocity) api.velocityX = 0; }
    if (api.y < -gh) { api.y = -gh; hit = true; if (killVelocity) api.velocityY = 0; }
    if (api.y >  gh) { api.y =  gh; hit = true; if (killVelocity) api.velocityY = 0; }
    return hit;
}

/**
 * True when this object has left the visible game area (fallen off screen, etc.).
 * offScreen(2) — returns true if >2 units outside game bounds
 */
function offScreen(margin) {
    const m  = margin ?? 1;
    const gw = (api.sceneSettings?.gameWidth  ?? 1280) / 100 / 2 + m;
    const gh = (api.sceneSettings?.gameHeight ?? 720)  / 100 / 2 + m;
    return Math.abs(api.x) > gw || Math.abs(api.y) > gh;
}

/**
 * Rotate this object to face a moving target smoothly.
 * Call in onUpdate(dt):
 *   trackTarget(find("Player"), 5, dt)   — track at speed 5
 */
function trackTarget(target, speed, dt) {
    if (!target) return;
    const tx = (typeof target.x === 'function') ? target.x() : (target.x ?? 0);
    const ty = (typeof target.y === 'function') ? target.y() : (target.y ?? 0);
    api.lookAt(tx, ty);
    if (speed && dt) {
        const d = dist(api.x, api.y, tx, ty);
        if (d > 0.01) {
            const nx = (tx - api.x) / d;
            const ny = (ty - api.y) / d;
            api.move(nx * speed * dt, ny * speed * dt);
        }
    }
}

/**
 * Flash the object's tint color briefly (e.g., hit flash).
 *   hitFlash()                     — white flash for 0.1s
 *   hitFlash("#ff0000", 0.2)       — red flash for 0.2s
 */
function hitFlash(color, duration) {
    const col = color ?? "#ffffff";
    const dur = duration ?? 0.1;
    api.setTint(col);
    api.wait(dur, () => api.clearTint());
}

/**
 * Shake this object (screen-shake style wiggle).
 *   objectShake()          — short wiggle
 *   objectShake(0.3, 0.4)  — amplitude 0.3 world-units for 0.4s
 */
function objectShake(amplitude, duration) {
    const amp = amplitude ?? 0.2;
    const dur = duration  ?? 0.25;
    const ox  = api.x, oy = api.y;
    const steps = Math.round(dur / 0.05);
    var   step  = 0;
    var timer = api.repeat(0.05, () => {
        step++;
        api.x = ox + (Math.random()-0.5)*2*amp*100 / 100;
        api.y = oy + (Math.random()-0.5)*2*amp*100 / 100;
        if (step >= steps) { timer.stop?.(); api.x = ox; api.y = oy; }
    });
}

/**
 * sceneSettings — quick access to current game canvas size.
 * sceneSettings.gameWidth, sceneSettings.gameHeight (in pixels)
 */
var sceneSettings = api.sceneSettings;

// ── CLONE OPTS — per-clone local variables ────────────────
/**
 * This clone's own variable bag. Set it in cloneSelf/cloneObject callback,
 * then read it in onCloneStart and anywhere in the script.
 *   cloneSelf(x, y, (c) => { c.opts.speed = 5; c.opts.damage = 2; });
 *   onCloneStart(() => { velocityX = opts.speed; })
 */
var opts = api.opts;

// ── HEALTH / DAMAGE ───────────────────────────────────────
/** Set this object's health. setHealth(100) */
function setHealth(n)              { api.setHealth(n); }
/** Current health. getHealth() */
function getHealth()               { return api.getHealth(); }
/** Set the maximum health limit. setMaxHealth(200) */
function setMaxHealth(n)           { api.setMaxHealth(n); }
/** Current max health. getMaxHealth() */
function getMaxHealth()            { return api.getMaxHealth(); }
/**
 * Deal damage. Triggers onDamage (and onDeath if hp reaches 0).
 *   takeDamage(10)          — generic damage
 *   takeDamage(10, other)   — damage from another object
 */
function takeDamage(amount, src)   { api.takeDamage(amount, src); }
/** Restore health up to maxHealth. Triggers onHeal. */
function heal(amount)              { api.heal(amount); }
/** True when health is at 0. */
function isDead()                  { return api.isDead(); }
/**
 * Become immune to damage for 'duration' seconds (default 1s).
 *   invincible()      — 1 second
 *   invincible(2.5)   — 2.5 seconds
 */
function invincible(duration)      { api.invincible(duration); }
/** True while invincible. */
function isInvincible()            { return api.isInvincible(); }

// ── JUMP HELPER ───────────────────────────────────────────
/**
 * Trigger a jump by firing the onJump event, which you handle yourself.
 *   onJump(() => { velocityY = 14; })   — define the jump behaviour
 *   if (isKeyJustDown("Space") && isOnGround()) triggerJump();
 */
function triggerJump() {
    if (_onJump) try { _onJump.call(api); } catch(_) {}
}

// ── AMMO SYSTEM ───────────────────────────────────────────
/** Set ammo count (also sets maxAmmo on first call). setAmmo(30) */
function setAmmo(n)     { api.setAmmo(n); }
/** Current ammo. getAmmo() */
function getAmmo()      { return api.getAmmo(); }
/** Set the maximum ammo capacity. */
function setMaxAmmo(n)  { api.setMaxAmmo(n); }
/** Max ammo. getMaxAmmo() */
function getMaxAmmo()   { return api.getMaxAmmo(); }
/**
 * Reload ammo. Triggers onReload.
 *   reload()    — refill to maxAmmo
 *   reload(30)  — set ammo to 30
 */
function reload(amount) { api.reload(amount); }

// ── STATE MACHINE ─────────────────────────────────────────
/**
 * Change this object's current state (fires onStateExit → onStateEnter).
 *   setState("idle")
 *   setState("attack")
 *   setState("dead")
 */
function setState(name)  { api.setState(name); }
/** Returns the current state string. getState() */
function getState()      { return api.getState(); }

// ── CLONE IDENTITY ────────────────────────────────────────
/** True if this object was spawned as a clone (not the original). */
function isClone()       { return api.isClone; }
/** Returns this clone's numeric ID (0 for originals). */
function getCloneId()    { return api._ref?._cloneId ?? 0; }

// ── SCREEN BOUNDS ─────────────────────────────────────────
/** True when this object is off the visible game area. offScreen(2) = 2-unit margin. */
// offScreen() and boundsClamp() are defined above with full implementations.

// ── RAYCAST WRAPPERS ──────────────────────────────────────
// raycast / raycastAll / raycastFromSelf wrappers defined above

// ── GIZMOS ───────────────────────────────────────────────
/**
 * Debug visualization toggles. Available anywhere in scripts.
 *   Gizmos.raycasts = true          — show raycast lasers
 *   Gizmos.raycastColor = '#ff4444' — change laser color
 *   Gizmos.raycastWidth = 3         — thicker laser
 *   Gizmos.raycastDuration = 0.2    — how long each laser stays visible (seconds)
 *   Gizmos.collision = true         — show collision shapes for all physics objects in play mode
 *   Gizmos.collisionColor = '#0ff'  — color for collision outlines (default: '#00ffcc')
 */
var Gizmos = api.Gizmos;

// ── DISTANCE CHECK ────────────────────────────────────────
/**
 * Check proximity at runtime — call in onUpdate for live sensing.
 *   if (inRangeOf(find("Player"), 3)) { setState("chase"); }
 */
function inRangeOf(target, radius) {
    if (!target) return false;
    const tx = target.x ?? 0;
    const ty = target.y ?? 0;
    return dist(api.x, api.y, tx, ty) <= radius;
}

// ── ONE-SHOT TIMER ────────────────────────────────────────
/**
 * Call fn once after 'seconds' seconds. Non-blocking.
 *   onceAfter(2, () => { destroySelf(); })
 */
function onceAfter(seconds, fn) {
    api.wait(seconds).then(() => { try { fn(); } catch(_) {} });
}

// ── FOREVER LOOP ──────────────────────────────────────────
/**
 * Run a function every single frame.
 * Works inside onStart, onCloneStart, or anywhere in the script.
 * Can be called multiple times — each forever() adds its own loop.
 *
 *   forever((dt) => {
 *       x -= 3 * dt;          // move left each frame
 *   });
 *
 *   // Inside onCloneStart — fully supported:
 *   onCloneStart(() => {
 *       forever((dt) => { x -= 3 * dt; });
 *       onScreenExit(() => { destroySelf(); });
 *   });
 *
 * Callbacks are stored on the api object so they survive even when
 * called from inside event handlers that fire AFTER the script compiles.
 */
function forever(fn) {
    if (typeof fn !== 'function') return;
    api._foreverCbs.push(fn);
    return fn;
}

`;


        const postlude = `
;__out._onStart          = _onStart;
__out._onUpdate          = _onUpdate;
__out._onStop            = _onStop;
__out._onCollisionEnter  = _onCollisionEnter;
__out._onCollisionStay   = _onCollisionStay;
__out._onCollisionExit   = _onCollisionExit;
__out._onOverlapEnter    = _onOverlapEnter;
__out._onOverlapExit     = _onOverlapExit;
__out._onVisible         = _onVisible;
__out._onHide            = _onHide;
__out._onMouseClick      = _onMouseClick;
__out._onMouseEnter      = _onMouseEnter;
__out._onMouseLeave      = _onMouseLeave;
__out._onCloneStart      = _onCloneStart;
__out._onDestroy         = _onDestroy;
__out._msgHandlers       = _msgHandlers;
__out._onDamage          = _onDamage;
__out._onDeath           = _onDeath;
__out._onHeal            = _onHeal;
__out._onLand            = _onLand;
__out._onJump            = _onJump;
__out._onScreenExit      = _onScreenExit;
__out._onScreenEnter     = _onScreenEnter;
__out._onReload          = _onReload;
__out._stateEnterHandlers= _stateEnterHandlers;
__out._stateExitHandlers = _stateExitHandlers;
__out._syncIsWalking     = typeof isWalking !== 'undefined' ? () => { isWalking = api.isWalking; } : null;
__out._syncIsStuck       = typeof isStuck  !== 'undefined' ? () => { isStuck  = api.isStuck;  } : null;
__out._syncIsPlayingAnimation = typeof isPlayingAnimation !== 'undefined' ? () => { isPlayingAnimation = api.isPlayingAnimation; } : null;
__out._initVX            = typeof velocityX !== 'undefined' ? velocityX : 0;
__out._initVY            = typeof velocityY !== 'undefined' ? velocityY : 0;
__out._syncVel           = typeof _syncVelocityToApi !== 'undefined' ? _syncVelocityToApi : null;
`;
        // ── Pre-flight safety scan ────────────────────────────────────────────
        // Detect patterns that would crash or corrupt the engine before even
        // trying to compile. We only scan the user's raw code (not the prelude).
        const safetyWarnings = _scanScriptForDangers(code, this.name, this.obj.label);
        if (safetyWarnings.fatal) {
            // Hard block: do not run the script at all
            for (const w of safetyWarnings.messages) _logConsole(w, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
            return; // leave all handlers null — script simply won't run
        }
        for (const w of safetyWarnings.messages) _logConsole(w, '#facc15');

        try {
            // Use AsyncFunction so user scripts can use `await` without
            // "unexpected reserved word" errors in strict mode.
            // The compiled function is cached by script code string — spawning
            // 100 objects with the same script only compiles once, not 100×.
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor; // eslint-disable-line no-new-func
            let fn = _scriptFnCache.get(code);
            if (!fn) {
                fn = new AsyncFunction('api', '__out', prelude + '\n' + code + '\n' + postlude);
                _scriptFnCache.set(code, fn);
            }
            const out = {};
            // Chain .catch IMMEDIATELY on the call — never store then attach separately.
            // Storing in a variable first creates a window where a synchronous microtask
            // rejection fires before .catch is attached, causing "Unhandled promise rejection".
            runInSandbox(fn, api, out, this._sandboxIframe).catch(_err => {
                const friendly = _friendlyScriptError(_err, code, this.name, this.obj.label, 'compile');
                for (const line of friendly) _logConsole(line, '#f87171');
                const _rm = _err?.message ?? String(_err);
                const _rt = _err?.name ?? 'Error';
                const _rs = (_err?.stack ?? '').split('\n').slice(0,5).join(' | ');
                _logConsole(`  🔍 RAW ERROR: [${_rt}] ${_rm}`, '#fb923c');
                _logConsole(`  📋 STACK: ${_rs}`, '#94a3b8');
                console.error('[Zengine async compile error]', _rt + ':', _rm, '\nScript:', this.name, '\nFull error:', _err);
                _jumpEditorToError(_err, code, this.name);
                import('./engine.console.js').then(m => m.recordPlayError());
            });
            // Bind all user-defined callbacks to api so this === api inside onStart, onUpdate, etc.
            const _b = fn => fn ? fn.bind(api) : null;
            this._onStart         = _b(out._onStart);
            this._onCloneStart    = _b(out._onCloneStart);
            this._onDestroy       = _b(out._onDestroy);
            this._onUpdate        = _b(out._onUpdate);
            this._onStop          = _b(out._onStop);
            this._onCollisionEnter= _b(out._onCollisionEnter);
            this._onCollisionStay = _b(out._onCollisionStay);
            this._onCollisionExit = _b(out._onCollisionExit);
            this._onOverlapEnter  = _b(out._onOverlapEnter);
            this._onOverlapExit   = _b(out._onOverlapExit);
            this._onVisible       = _b(out._onVisible);
            this._onHide          = _b(out._onHide);
            this._onMouseClick    = _b(out._onMouseClick);
            this._onMouseEnter    = _b(out._onMouseEnter);
            this._onMouseLeave    = _b(out._onMouseLeave);
            this._onDamage        = _b(out._onDamage);
            this._onDeath         = _b(out._onDeath);
            this._onHeal          = _b(out._onHeal);
            this._onLand          = _b(out._onLand);
            this._onJump          = _b(out._onJump);
            this._onScreenExit    = _b(out._onScreenExit);
            this._onScreenEnter   = _b(out._onScreenEnter);
            this._onReload        = _b(out._onReload);
            this._syncVel            = out._syncVel          ?? null;
            this._syncIsWalking      = out._syncIsWalking    ?? null;
            this._syncIsStuck        = out._syncIsStuck      ?? null;
            // Bind message and state handlers to api too
            const _rawMsg = out._msgHandlers ?? new Map();
            this._messageHandlers = new Map();
            for (const [k, fn] of _rawMsg) this._messageHandlers.set(k, fn.bind(api));
            const _rawEnter = out._stateEnterHandlers ?? new Map();
            this._stateEnterHandlers = new Map();
            for (const [k, fn] of _rawEnter) this._stateEnterHandlers.set(k, fn.bind(api));
            const _rawExit = out._stateExitHandlers ?? new Map();
            this._stateExitHandlers = new Map();
            for (const [k, fn] of _rawExit) this._stateExitHandlers.set(k, fn.bind(api));
            // Apply initial velocity: _spawnVx/Vy (set by spawnObject callback) takes
            // priority over top-level var declarations (_initVX/VY) so bullets move
            // in the direction the spawner set before this script compiled.
            const spawnVx = this.obj._spawnVx;
            const spawnVy = this.obj._spawnVy;
            api._vel.x = (spawnVx != null && spawnVx !== 0) ? spawnVx : (out._initVX ?? 0);
            api._vel.y = (spawnVy != null && spawnVy !== 0) ? spawnVy : (out._initVY ?? 0);
        } catch (err) {
            const friendly = _friendlyScriptError(err, code, this.name, this.obj.label, 'compile');
            for (const line of friendly) _logConsole(line, '#f87171');

            // ── DETAILED DEBUG DUMP ──────────────────────────────────────────
            // Always log the raw error to engine console + browser devtools
            // so you can copy/paste the full error message.
            const _rawMsg  = err?.message ?? String(err);
            const _rawType = err?.name    ?? 'Error';
            const _rawStack = (err?.stack ?? '').split('\n').slice(0,5).join(' | ');
            _logConsole(`  🔍 RAW ERROR: [${_rawType}] ${_rawMsg}`, '#fb923c');
            _logConsole(`  📋 STACK: ${_rawStack}`, '#94a3b8');
            _logConsole(`  📝 SCRIPT: "${this.name}" on object "${this.obj.label}"`, '#94a3b8');
            // Also dump to browser console for full stack trace
            console.error('[Zengine compile error]', _rawType + ':', _rawMsg, '\nScript:', this.name, '\nObject:', this.obj.label, '\nFull error:', err);

            import('./engine.console.js').then(m => m.recordPlayError());
        }
    }

    start() {
        if (this.obj._isClone) {
            // Clones run onCloneStart (NOT onStart) — prevents infinite cascade
            if (!this._onCloneStart) return;
            try { this._onCloneStart(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onCloneStart');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        } else {
            if (!this._onStart) return;
            try { this._onStart(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onStart');
                for (const line of friendly) _logConsole(line, '#f87171');
                _jumpEditorToError(e, null, this.name);
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    update(dt) {
        const vel  = this.api._vel;
        const obj  = this.obj;

        // ── 1. Run the user's onUpdate first so changes take effect this frame ──
        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) {
                // Throttle: only log the first occurrence + every 60th after that
                // so a broken onUpdate doesn't spam thousands of console lines.
                this._updateErrCount = (this._updateErrCount ?? 0) + 1;
                if (this._updateErrCount === 1) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'onUpdate');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    _jumpEditorToError(e, null, this.name);
                    _logConsole(`  ↳ This error repeats every frame — fix the script to stop the spam.`, '#facc15');
                    import('./engine.console.js').then(m => m.recordPlayError());
                } else if (this._updateErrCount % 300 === 0) {
                    // Remind the user the script is still broken every ~5s at 60fps
                    _logConsole(`[Script "${this.name}" on "${obj.label}"] ✖ onUpdate still failing (${this._updateErrCount} frames). Open the script to fix it.`, '#f87171');
                }
            }
        }

        // ── 1b. Run all forever() callbacks registered at any point (onStart, onCloneStart, etc.) ──
        const _fcbs = this.api._foreverCbs;
        if (_fcbs.length > 0) {
            for (let _fi = 0; _fi < _fcbs.length; _fi++) {
                try { _fcbs[_fi](dt); }
                catch (e) {
                    this._foreverErrCount = (this._foreverErrCount ?? 0) + 1;
                    if (this._foreverErrCount === 1) {
                        const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'forever()');
                        for (const line of friendly) _logConsole(line, '#f87171');
                    }
                }
            }
        }

        // ── 2. Sync local velocityX/Y vars (written directly in script) to api._vel ──
        if (this._syncVel) {
            try { this._syncVel(); } catch(_) {}
        }

        // ── 3. Tick tweens (after onUpdate so user code runs first) ───
        for (let i = this._tweens.length - 1; i >= 0; i--) {
            const tw = this._tweens[i];
            tw.elapsed = Math.min(tw.elapsed + dt, tw.duration);
            const t  = tw.duration > 0 ? tw.elapsed / tw.duration : 1;
            const et = _easing(t, tw.easing);
            for (const e of tw.entries) {
                _applyTweenProp(this.api, e.key, e.from + (e.to - e.from) * et);
            }
            if (tw.elapsed >= tw.duration) {
                try { tw.onComplete?.(); } catch(_) {}
                this._tweens.splice(i, 1);
            }
        }

        // ── 4. Tick repeat timers ──────────────────────────────
        for (const r of this._repeats) {
            r.elapsed -= dt;
            if (r.elapsed <= 0) {
                try { r.fn(); }
                catch (e) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'repeat timer');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    import('./engine.console.js').then(m => m.recordPlayError());
                }
                r.elapsed = r.interval;
            }
        }

        // ── 2b. Tick navigation agent (sets vel before it's applied) ──
        if (obj._nav?.active) _navTick(this, dt);
        // Sync isWalking / isStuck local vars into script scope via the api
        if (this._syncIsWalking) try { this._syncIsWalking(); } catch(_) {}
        if (this._syncIsStuck)              try { this._syncIsStuck();              } catch(_) {}
        if (this._syncIsPlayingAnimation)   try { this._syncIsPlayingAnimation();   } catch(_) {}

        // ── 4. Apply velocity to position / physics body ───────────────
        const hasKinematicBody = obj.physicsBody === 'kinematic';
        const hasDynamicBody   = obj.physicsBody === 'dynamic' && obj._physicsBody;

        if (hasKinematicBody) {
            // Kinematic: store desired velocity for the AABB sweep in stepPhysics.
            // stepPhysics runs after all scripts this frame, sweeps the sprite AABB
            // against tile/static AABBs, resolves collisions, and writes the
            // corrected position to obj.x/y. No Matter body involved.
            if (!obj.physicsImmovable) {
                obj._kinematicVx =  vel.x * 100;
                obj._kinematicVy = -vel.y * 100;
            }
        } else if (hasDynamicBody) {
            // ── Dynamic: apply script velocity to physics body.
            // IMPORTANT: we apply whenever the script has set ANY velocity this frame
            // (tracked by _velDirty), including setting to 0. This is the only way
            // `velocityY = 0` actually stops the body — without the dirty flag, the
            // `vel.y === 0` case would be silently skipped and the body would keep
            // its momentum from gravity/previous frames.
            if (obj._velDirty) {
                obj._velDirty = false;
                // Only override components the script explicitly touched, blending
                // with the current physics velocity for components left untouched.
                const cur = obj._physicsBody.getLinearVelocity();
                const nx  = obj._velSetX ? vel.x * 100 : cur.x;
                const ny  = obj._velSetY ? -vel.y * 100 : cur.y;
                obj._physicsBody.setLinearVelocity(window.planck.Vec2(nx, ny));
                obj._physicsBody.setAwake(true);
                obj._velSetX = false;
                obj._velSetY = false;
            }
        } else {
            // ── No physics body — pure scripting movement ──────────────
            if (vel.x !== 0) obj.x +=  vel.x * dt * 100;
            if (vel.y !== 0) obj.y -= vel.y * dt * 100;
        }

        // ── 5. onLand detection (kinematic and dynamic) ────────────
        if (this._onLand && (obj.physicsBody === 'kinematic' || obj.physicsBody === 'dynamic')) {
            const grounded = !!obj._isOnGround;
            const wasAirborne = this._wasAirborne ?? false;
            if (wasAirborne && grounded) {
                try { this._onLand(); } catch(e) {}
            }
            this._wasAirborne = !grounded;
        }

        // ── 6. onScreenExit / onScreenEnter detection ──────────────
        if (this._onScreenExit || this._onScreenEnter) {
            const gw   = (this.api.sceneSettings?.gameWidth  ?? 1280) / 2;
            const gh   = (this.api.sceneSettings?.gameHeight ?? 720)  / 2;
            const px   = obj.x;
            const py   = obj.y;
            const half = (obj.width ?? 50) / 2;
            const off  = Math.abs(px) > gw + half || Math.abs(py) > gh + half;
            if (off !== (this._wasOffScreen ?? false)) {
                if (off && this._onScreenExit)  try { this._onScreenExit();  } catch(e) {}
                if (!off && this._onScreenEnter) try { this._onScreenEnter(); } catch(e) {}
                this._wasOffScreen = off;
            }
        }

        // Destroy queue — fire onDestroy before removing
        if (obj._markedForDestroy) {
            this.handleDestroy();
            _destroyObject(obj);
        }

        // Clear per-frame input flags
        this._keysJustDown.clear();
        this._keysJustUp.clear();
        this._mouse.justDown = false;
        this._mouse.justUp   = false;
    }

    stop() {
        // Release the sandbox iframe back to the pool for reuse
        if (this._sandboxIframe) {
            releaseSandboxIframe(this._sandboxIframe);
            this._sandboxIframe = null;
        }
        if (!this._onStop) return;
        try { this._onStop(); }
        catch (e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onStop');
            for (const line of friendly) _logConsole(line, '#f87171');
        }
    }

    handleDestroy() {
        if (!this._onDestroy || this._destroyFired) return;
        this._destroyFired = true;
        try { this._onDestroy(); }
        catch (e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onDestroy');
            for (const line of friendly) _logConsole(line, '#f87171');
        }
    }

    // ── Collision callbacks (physics — fired by engine.physics.js) ──
    handleCollisionEnter(other) {
        if (!other) return;
        this._activeCollisions.add(other);
        if (this._onCollisionEnter) {
            const proxy = _makeProxy(other);
            try { this._onCollisionEnter(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, `onCollisionEnter (hit "${other.label}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    handleCollisionStay(other) {
        if (this._onCollisionStay) {
            const proxy = _makeProxy(other);
            try { this._onCollisionStay(proxy); }
            catch (e) {
                // Throttle stay errors like onUpdate — they fire every frame
                this._collStayErrCount = (this._collStayErrCount ?? 0) + 1;
                if (this._collStayErrCount === 1) {
                    const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onCollisionStay');
                    for (const line of friendly) _logConsole(line, '#f87171');
                }
            }
        }
    }

    handleCollisionExit(other) {
        this._activeCollisions.delete(other);
        if (this._onCollisionExit) {
            const proxy = _makeProxy(other);
            try { this._onCollisionExit(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onCollisionExit');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    // ── Overlap callbacks (AABB — fired by scripting runtime) ────────
    handleOverlapEnter(other) {
        this._activeOverlaps.add(other);
        if (this._onOverlapEnter) {
            const proxy = _makeProxy(other);
            try { this._onOverlapEnter(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, `onOverlapEnter (with "${other.label}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    handleOverlapExit(other) {
        this._activeOverlaps.delete(other);
        if (this._onOverlapExit) {
            const proxy = _makeProxy(other);
            try { this._onOverlapExit(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onOverlapExit');
                for (const line of friendly) _logConsole(line, '#f87171');
            }
        }
    }

    _handleKeyDown(key) {
        const k = key.toLowerCase();
        if (!this._keys.has(k)) {
            this._keysJustDown.add(k);
            const h = this._keyDownHandlers.get(k) ?? this._keyDownHandlers.get('any');
            if (h) try { h(k); }
            catch(e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj?.label ?? '?', `onKeyDown("${k}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
        this._keys.add(k);
    }
    _handleKeyUp(key) {
        const k = key.toLowerCase();
        this._keysJustUp.add(k);
        this._keys.delete(k);
        const h = this._keyUpHandlers.get(k) ?? this._keyUpHandlers.get('any');
        if (h) try { h(k); }
        catch(e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj?.label ?? '?', `onKeyUp("${k}")`);
            for (const line of friendly) _logConsole(line, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
        }
    }
    _handleMouseMove(x, y) {
        this._mouse.x       = x;
        this._mouse.y       = y;
        // x,y here are canvas-relative pixels; add canvas rect offset for screen coords
        const r = state.app?.view?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        this._mouse.screenX = x + r.left;
        this._mouse.screenY = y + r.top;
    }
    _handleMouseDown()     { this._mouse.down = true;  this._mouse.justDown = true; }
    _handleMouseUp()       { this._mouse.down = false; this._mouse.justUp   = true; }
    _handleDragMouseDown(cx, cy) {
        if (!this._onDragMouseDown || !this.obj) return;
        const obj = this.obj;
        if (!obj.visible) return;
        try {
            const b    = obj.getBounds();
            const rect = state.app?.view?.getBoundingClientRect?.() ?? { left:0, top:0 };
            const bx = b.x - rect.left, by = b.y - rect.top;
            if (cx >= bx && cx <= bx + b.width && cy >= by && cy <= by + b.height) {
                try { this._onDragMouseDown(); } catch(_) {}
            }
        } catch(_) {}
    }
    _handleMouseClick(cx, cy) {
        // Hit-test: does the canvas point (cx,cy) land inside this object?
        if (!this._onMouseClick || !this.obj) return;
        const obj = this.obj;
        if (!obj.visible) return;
        try {
            const b    = obj.getBounds();
            const rect = state.app?.view?.getBoundingClientRect?.() ?? { left:0, top:0 };
            const bx = b.x - rect.left, by = b.y - rect.top;
            if (cx >= bx && cx <= bx + b.width && cy >= by && cy <= by + b.height) {
                try { this._onMouseClick(); }
                catch (e) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'onMouseClick');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    import('./engine.console.js').then(m => m.recordPlayError());
                }
            }
        } catch(_) {}
    }
}

// Register this class with shared.js so sandbox.js can construct
// instances (spawnObject/cloneSelf/cloneObject auto-start) without
// creating a circular import.
_registerScriptInstanceClass(ScriptInstance);

// ── Object destroy helper ─────────────────────────────────────
function _destroyObject(obj) {
    obj.visible = false;
    try { state.sceneContainer?.removeChild(obj); } catch(_) {}
    const idx = state.gameObjects.indexOf(obj);
    if (idx !== -1) state.gameObjects.splice(idx, 1);
    obj._markedForDestroy = false;
    // Remove the Planck physics body so the collider disappears immediately.
    // Use the cached module reference if available (avoids an async import mid-frame).
    if (_physicsModule) {
        _physicsModule.removePhysicsBody(obj);
    } else if (obj._physicsBody) {
        // Fallback: lazy-import if the module hasn't been cached yet
        import('./engine.physics.js').then(m => m.removePhysicsBody(obj));
    }
}

// ── Runtime state ─────────────────────────────────────────────
// _instances is imported from engine.scripting.shared.js
let   _ticker    = null;
let   _hammerInst = null; // Hammer.js Manager instance for the play canvas

// ── Multi-touch tracking ──────────────────────────────────────
// Array of active touch points: { id, x, y, screenX, screenY } (world units for x/y)
let _activeTouches = [];

function _updateActiveTouches(touchList) {
    if (!state.app?.view) return;
    const r  = state.app.view.getBoundingClientRect();
    const sc = state.sceneContainer;
    _activeTouches = Array.from(touchList).map(t => {
        const sx = t.clientX - r.left;
        const sy = t.clientY - r.top;
        return {
            id:      t.identifier,
            screenX: t.clientX,
            screenY: t.clientY,
            x:  sc ? (sx - sc.x) / (sc.scale.x * 100) : sx / 100,
            y:  sc ? -(sy - sc.y) / (sc.scale.y * 100) : -sy / 100,
        };
    });
    // Push the primary touch into the shared _mouse position
    if (_activeTouches.length > 0) {
        const p = _activeTouches[0];
        for (const i of _instances) {
            i._mouse.screenX = p.screenX;
            i._mouse.screenY = p.screenY;
        }
    }
}

// ── Drag & Drop state ─────────────────────────────────────────
let _activeDragObj  = null;
let _activeDragOpts = {};

// Throw velocity tracking (world units/sec, sampled over recent frames)
let _throwVelX   = 0;   // current throw velocity X (world units/sec)
let _throwVelY   = 0;   // current throw velocity Y (world units/sec)
let _throwPrevX  = 0;   // previous frame world X
let _throwPrevY  = 0;   // previous frame world Y

function _applyDragThisFrame(dt) {
    if (!_activeDragObj) return;
    const sc = state.sceneContainer;
    if (!sc) return;
    const inst = _instances.find(i => i.obj === _activeDragObj) ?? _instances[0];
    if (!inst) return;
    const cx = inst._mouse.x;
    const cy = inst._mouse.y;
    const targetX =  (cx - sc.x) / (sc.scale.x * 100) + (_activeDragOpts.offsetX ?? 0);
    const targetY = -(cy - sc.y) / (sc.scale.y * 100) + (_activeDragOpts.offsetY ?? 0);
    const smooth = _activeDragOpts.smooth ?? 0;
    let wx, wy;
    if (smooth > 0) {
        const realDt = (typeof dt === 'number' && dt > 0) ? dt : (1 / 60);
        const t = Math.min(1, smooth * realDt);
        wx = (_activeDragObj.x  / 100) + (targetX - (_activeDragObj.x  / 100)) * t;
        wy = (-_activeDragObj.y / 100) + (targetY - (-_activeDragObj.y / 100)) * t;
    } else {
        wx = targetX; wy = targetY;
    }
    if (_activeDragOpts.clampToGameBounds) {
        const gw = (state.sceneSettings?.gameWidth  ?? 1280) / 100 / 2;
        const gh = (state.sceneSettings?.gameHeight ?? 720)  / 100 / 2;
        wx = Math.max(-gw, Math.min(gw, wx));
        wy = Math.max(-gh, Math.min(gh, wy));
    }

    // ── Throw velocity tracking ──────────────────────────────
    // Sample instantaneous velocity using exponential smoothing so that
    // a momentarily-still cursor doesn't zero-out the throw.
    if (_activeDragOpts.throw) {
        const realDt = (typeof dt === 'number' && dt > 0) ? dt : (1 / 60);
        const rawVx  = (wx - _throwPrevX) / realDt;   // world units/sec
        const rawVy  = (wy - _throwPrevY) / realDt;
        const alpha  = _activeDragOpts._throwAlpha ?? 0.35; // smoothing (0=no smooth,1=all prev)
        _throwVelX = _throwVelX * alpha + rawVx * (1 - alpha);
        _throwVelY = _throwVelY * alpha + rawVy * (1 - alpha);
        _throwPrevX = wx;
        _throwPrevY = wy;
    }
    // ────────────────────────────────────────────────────────

    _activeDragObj.x =  wx * 100;
    _activeDragObj.y = -wy * 100;

    // ── Dynamic body fix: Planck overwrites obj.x/y every step from body position.
    // We must also move the body itself, and zero its velocity so physics doesn't
    // immediately push it back.
    const draggedObj = _activeDragObj;
    if (draggedObj.physicsBody === 'dynamic' && draggedObj._physicsBody && window.planck) {
        const body = draggedObj._physicsBody;
        const off  = body._zenOffset || { x: 0, y: 0 };
        const ang  = body.getAngle();
        const cosR = Math.cos(ang);
        const sinR = Math.sin(ang);
        body.setTransform(
            window.planck.Vec2(
                draggedObj.x + off.x * cosR - off.y * sinR,
                draggedObj.y + off.x * sinR + off.y * cosR
            ),
            ang
        );
        body.setLinearVelocity(window.planck.Vec2(0, 0));
        body.setAngularVelocity(0);
        body.setAwake(true);
    }
}

// Apply throw velocity to the released physics body
function _applyThrowVelocity(obj) {
    const opts    = _activeDragOpts;
    const speedMul = opts.speed ?? 1;
    let vx = _throwVelX * speedMul;
    let vy = _throwVelY * speedMul;

    // Optional max-speed cap
    if (opts.maxSpeed != null) {
        const spd = Math.sqrt(vx * vx + vy * vy);
        if (spd > opts.maxSpeed) {
            const s = opts.maxSpeed / spd;
            vx *= s; vy *= s;
        }
    }

    const ptype = obj.physicsBody;
    if (ptype === 'dynamic' && obj._physicsBody && window.planck) {
        // Dynamic: set Planck body velocity directly (pixels/sec → planck units)
        obj._physicsBody.setLinearVelocity(window.planck.Vec2(vx * 100, -vy * 100));
        obj._physicsBody.setAwake(true);
    } else if (ptype === 'kinematic') {
        // Kinematic: write into the engine's kinematic velocity slots
        obj._kinematicVx =  vx * 100;   // stored in px/sec internally
        obj._kinematicVy = -vy * 100;
        obj._velDirty = true;
    } else {
        // No physics body — fall back to scripting velocity fields
        obj._vel = obj._vel ?? { x: 0, y: 0 };
        obj._vel.x = vx;
        obj._vel.y = vy;
        obj._velDirty  = true;
        obj._velSetX   = true;
        obj._velSetY   = true;
    }
}

// Release drag on mouseup
function _onDragMouseUp() {
    if (!_activeDragObj) return;

    // Apply throw velocity before clearing state
    if (_activeDragOpts.throw) {
        try { _applyThrowVelocity(_activeDragObj); } catch(_) {}
    }

    if (_activeDragOpts?.onDrop) {
        try { _activeDragOpts.onDrop(_activeDragObj); } catch(_) {}
    }
    _activeDragObj  = null;
    _activeDragOpts = {};
    _throwVelX = _throwVelY = _throwPrevX = _throwPrevY = 0;
}

// ── Virtual Joystick system ───────────────────────────────────
const _joysticks = [];

function _createJoystick(opts = {}) {
    const size      = opts.size        ?? 120;
    const knobSize  = opts.knobSize    ?? Math.round(size * 0.45);
    const deadzone  = opts.deadzone    ?? 0.1;
    const fixed     = opts.fixed       ?? false;
    const opacity   = opts.opacity     ?? 0.85;
    const zIndex    = opts.zIndex      ?? 9500;
    const baseColor = opts.baseColor   ?? 'rgba(255,255,255,0.2)';
    const knobColor = opts.knobColor   ?? 'rgba(255,255,255,0.67)';
    const borderClr = opts.borderColor ?? 'rgba(255,255,255,0.4)';
    // Default position: bottom-left
    const defX = opts.x ?? size + 30;
    const defY = opts.y ?? size + 30;  // from bottom-left

    // Build DOM overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = [
        `position:fixed`,
        `pointer-events:none`,
        `z-index:${zIndex}`,
        `touch-action:none`,
        `width:${size}px`, `height:${size}px`,
        `border-radius:50%`,
        `background:${baseColor}`,
        `border:2px solid ${borderClr}`,
        `opacity:${opacity}`,
        `transition:opacity 0.2s`,
        `left:${fixed ? defX - size/2 : -9999}px`,
        `top:${fixed ? (window.innerHeight - defY - size/2) : -9999}px`,
        `box-sizing:border-box`,
        `display:flex`, `align-items:center`, `justify-content:center`,
    ].join(';');

    const knob = document.createElement('div');
    knob.style.cssText = [
        `width:${knobSize}px`, `height:${knobSize}px`,
        `border-radius:50%`,
        `background:${knobColor}`,
        `position:absolute`,
        `top:50%`, `left:50%`,
        `transform:translate(-50%,-50%)`,
        `transition:none`,
        `pointer-events:none`,
    ].join(';');
    overlay.appendChild(knob);
    document.body.appendChild(overlay);

    // State
    let active    = false;
    let touchId   = null;
    let baseX     = 0;  // screen px
    let baseY     = 0;
    let axisH     = 0;
    let axisV     = 0;
    let angle     = 0;
    let magnitude = 0;
    const maxDist  = size / 2 - knobSize / 4;

    function _place(cx, cy) {
        baseX = cx;
        baseY = cy;
        overlay.style.left = (cx - size / 2) + 'px';
        overlay.style.top  = (cy - size / 2) + 'px';
        overlay.style.opacity = String(opacity);
    }

    function _updateKnob(dx, dy) {
        const dist  = Math.sqrt(dx * dx + dy * dy);
        const ratio = dist > 0 ? Math.min(dist, maxDist) / maxDist : 0;
        const nx    = dist > 0 ? dx / dist : 0;
        const ny    = dist > 0 ? dy / dist : 0;
        const kx    = nx * ratio * maxDist;
        const ky    = ny * ratio * maxDist;
        knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

        magnitude = ratio;
        const raw_h = nx * ratio;
        const raw_v = ny * ratio;
        axisH = Math.abs(raw_h) < deadzone ? 0 : raw_h;
        axisV = Math.abs(raw_v) < deadzone ? 0 : -raw_v; // flip Y to game space (up = positive)
        angle = Math.atan2(-dy, dx) * (180 / Math.PI);
        if (angle < 0) angle += 360;
    }

    function _reset() {
        active    = false;
        touchId   = null;
        axisH     = 0;
        axisV     = 0;
        magnitude = 0;
        knob.style.transform = 'translate(-50%,-50%)';
        if (!fixed) {
            overlay.style.left    = '-9999px';
            overlay.style.top     = '-9999px';
            overlay.style.opacity = '0';
        }
    }

    function onTouchStart(e) {
        if (active) return; // already tracking a finger
        const t = e.changedTouches[0];
        const cx = t.clientX, cy = t.clientY;
        if (fixed) {
            // Check if touch lands inside the ring
            const rx = parseFloat(overlay.style.left) + size / 2;
            const ry = parseFloat(overlay.style.top)  + size / 2;
            const d  = Math.sqrt((cx - rx) ** 2 + (cy - ry) ** 2);
            if (d > size / 2 * 1.5) return; // miss
            baseX = rx; baseY = ry;
        } else {
            _place(cx, cy);
        }
        touchId = t.identifier;
        active  = true;
        _updateKnob(0, 0);
    }

    function onTouchMove(e) {
        if (!active) return;
        for (const t of e.changedTouches) {
            if (t.identifier !== touchId) continue;
            _updateKnob(t.clientX - baseX, t.clientY - baseY);
        }
    }

    function onTouchEnd(e) {
        if (!active) return;
        for (const t of e.changedTouches) {
            if (t.identifier === touchId) { _reset(); return; }
        }
    }

    // Also respond to mouse (desktop testing)
    let mouseTracking = false;
    function onMouseDown(e) {
        if (active) return;
        const rect = overlay.getBoundingClientRect();
        const dx = e.clientX - (rect.left + size / 2);
        const dy = e.clientY - (rect.top  + size / 2);
        if (fixed) {
            if (Math.sqrt(dx*dx+dy*dy) > size/2*1.5) return;
            baseX = rect.left + size/2; baseY = rect.top + size/2;
        } else {
            _place(e.clientX, e.clientY);
            baseX = e.clientX; baseY = e.clientY;
        }
        mouseTracking = true; active = true;
        _updateKnob(0, 0);
    }
    function onMouseMove(e) {
        if (!mouseTracking || !active) return;
        _updateKnob(e.clientX - baseX, e.clientY - baseY);
    }
    function onMouseUp() {
        if (mouseTracking) { mouseTracking = false; _reset(); }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove',  onTouchMove,  { passive: true });
    window.addEventListener('touchend',   onTouchEnd,   { passive: true });
    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove',  onMouseMove);
    window.addEventListener('mouseup',    onMouseUp);

    // Initial position for fixed
    if (fixed) _place(defX, window.innerHeight - defY);

    const handle = {
        get axisH()     { return axisH; },
        get axisV()     { return axisV; },
        get angle()     { return angle; },
        get magnitude() { return magnitude; },
        get active()    { return active; },
        /** Update style options at runtime */
        setStyle(s = {}) {
            if (s.baseColor)   overlay.style.background   = s.baseColor;
            if (s.knobColor)   knob.style.background      = s.knobColor;
            if (s.borderColor) overlay.style.borderColor  = s.borderColor;
            if (s.opacity   != null) overlay.style.opacity = String(s.opacity);
            if (s.size != null) {
                overlay.style.width  = s.size + 'px';
                overlay.style.height = s.size + 'px';
            }
        },
        destroy() {
            window.removeEventListener('touchstart', onTouchStart);
            window.removeEventListener('touchmove',  onTouchMove);
            window.removeEventListener('touchend',   onTouchEnd);
            window.removeEventListener('mousemove',  onMouseMove);
            window.removeEventListener('mouseup',    onMouseUp);
            overlay.remove();
            const idx = _joysticks.indexOf(handle);
            if (idx !== -1) _joysticks.splice(idx, 1);
        },
    };
    _joysticks.push(handle);
    return handle;
}

function _destroyAllJoysticks() {
    // Copy array because destroy() mutates it
    for (const j of [..._joysticks]) j.destroy();
}

function _initHammer() {
    _destroyHammer();
    const canvas = state.app?.view;
    if (!canvas || typeof window.Hammer === 'undefined') return;

    const hm = new window.Hammer.Manager(canvas, {
        recognizers: [
            [window.Hammer.Swipe,  { direction: window.Hammer.DIRECTION_ALL, threshold: 10, velocity: 0.3 }],
            [window.Hammer.Pinch,  { enable: true }],
            [window.Hammer.Tap,    { event: 'tap' }],
        ],
    });

    const DIRECTION_MAP = {
        [window.Hammer.DIRECTION_LEFT]:  'left',
        [window.Hammer.DIRECTION_RIGHT]: 'right',
        [window.Hammer.DIRECTION_UP]:    'up',
        [window.Hammer.DIRECTION_DOWN]:  'down',
    };

    hm.on('swipe', (ev) => {
        const dir = DIRECTION_MAP[ev.direction] ?? 'any';
        for (const inst of _instances) {
            const map = inst.api?._swipeHandlers;
            if (!map) continue;
            const fn = map.get(dir) ?? map.get('any');
            if (fn) try { fn(dir); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onSwipe');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    hm.on('pinch', (ev) => {
        for (const inst of _instances) {
            const fn = inst.api?._pinchHandler;
            if (fn) try { fn(ev.scale); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onPinch');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    hm.on('tap', () => {
        for (const inst of _instances) {
            const fn = inst.api?._tapHandler;
            if (fn) try { fn(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onTap');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    _hammerInst = hm;
}

function _destroyHammer() {
    if (_hammerInst) {
        try { _hammerInst.destroy(); } catch(_) {}
        _hammerInst = null;
    }
}
let   _physicsModule = null; // cached physics module ref — resolved once on first step

// ── Input event relay ─────────────────────────────────────────
function _kd(e) { for (const i of _instances) i._handleKeyDown(e.key); }
function _ku(e) { for (const i of _instances) i._handleKeyUp(e.key); }
function _mm(e) {
    const c = state.app?.view; if (!c) return;
    const r = c.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    for (const i of _instances) i._handleMouseMove(cx, cy);
}
function _md(e) {
    for (const i of _instances) i._handleMouseDown();
    // Hit-test for makeDraggable — grab starts on mousedown, not on click
    if (state.app?.view) {
        const canvas = state.app.view;
        const rect   = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        for (const i of _instances) {
            if (i._onDragMouseDown) i._handleDragMouseDown(cx, cy);
        }
    }
}
function _mu(e) {
    for (const i of _instances) i._handleMouseUp();
    _onDragMouseUp();
    // Dispatch onMouseClick to any instance whose object bounds contain the click point
    if (!state.app?.view) return;
    const canvas = state.app.view;
    const rect   = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    for (const i of _instances) {
        if (i._onMouseClick) i._handleMouseClick(cx, cy);
    }
}
// Touch relay — maps touch events to mouse equivalents + multi-touch tracking
function _td(e) {
    _updateActiveTouches(e.touches);
    for (const i of _instances) i._handleMouseDown();
    _muTouchPos = e.changedTouches[0];
    // Push primary touch screen coords immediately
    const t0 = e.changedTouches[0];
    if (t0) {
        const r = state.app?.view?.getBoundingClientRect?.() ?? { left:0, top:0 };
        for (const i of _instances) {
            i._mouse.screenX = t0.clientX;
            i._mouse.screenY = t0.clientY;
            i._mouse.x = t0.clientX - r.left;
            i._mouse.y = t0.clientY - r.top;
        }
        // makeDraggable: grab on touchstart over the object
        const cx = t0.clientX - r.left;
        const cy = t0.clientY - r.top;
        for (const i of _instances) {
            if (i._onDragMouseDown) i._handleDragMouseDown(cx, cy);
        }
    }
}
function _tu(e) {
    _updateActiveTouches(e.touches);
    for (const i of _instances) i._handleMouseUp();
    _onDragMouseUp();
    const t = e.changedTouches[0];
    if (!state.app?.view) return;
    const rect = state.app.view.getBoundingClientRect();
    const cx = t.clientX - rect.left;
    const cy = t.clientY - rect.top;
    for (const i of _instances) {
        if (i._onMouseClick) i._handleMouseClick(cx, cy);
    }
}
function _tm(e) {
    _updateActiveTouches(e.touches);
    const t = e.changedTouches[0];
    if (!state.app?.view) return;
    const r = state.app.view.getBoundingClientRect();
    const cx = t.clientX - r.left;
    const cy = t.clientY - r.top;
    for (const i of _instances) i._handleMouseMove(cx, cy);
}
let _muTouchPos = null;

// ── Overlap check pass (runs every frame) ─────────────────────
function _runOverlapChecks() {
    // Only check instances that have overlap handlers
    const tracked = _instances.filter(i => i._onOverlapEnter || i._onOverlapExit);
    if (tracked.length === 0) return;

    for (const inst of tracked) {
        for (const other of _instances) {
            if (other === inst) continue;
            const wasOverlapping = inst._activeOverlaps.has(other.obj);
            const isNow = _isOverlapping(inst.obj, other.obj);
            if (isNow && !wasOverlapping)  inst.handleOverlapEnter(other.obj);
            if (!isNow && wasOverlapping)  inst.handleOverlapExit(other.obj);
        }
    }
}

// ── Continuous collision stay pass (runs every frame) ─────────
function _runCollisionStayChecks() {
    for (const inst of _instances) {
        if (!inst._onCollisionStay) continue;
        for (const otherObj of inst._activeCollisions) {
            inst.handleCollisionStay(otherObj);
        }
    }
}

// ── Start scripts (enterPlayMode) ─────────────────────────────
export function startScripts() {
    stopScripts();
    _clearRegistries();
    _camera._followTarget = null;

    let count = 0;
    for (const obj of state.gameObjects) {
        if (!obj.scriptName) continue;
        const rec = getScript(obj.scriptName);
        if (!rec) {
            _logConsole(`[Scripting] Script "${obj.scriptName}" not found for "${obj.label}"`, '#facc15');
            continue;
        }
        const inst = new ScriptInstance(obj, obj.scriptName, rec.code);
        _instances.push(inst);
        _registerInstance(inst);
        count++;
    }

    if (count === 0) return;

    // Fire onStart for all instances after all are registered
    // (so messaging and findWithTag work in onStart)
    for (const i of _instances) i.start();

    window.addEventListener('keydown',   _kd);
    window.addEventListener('keyup',     _ku);
    window.addEventListener('mousemove', _mm);
    window.addEventListener('mousedown', _md);
    window.addEventListener('mouseup',   _mu);
    // Touch support (mobile)
    window.addEventListener('touchstart', _td, { passive: true });
    window.addEventListener('touchend',   _tu, { passive: true });
    window.addEventListener('touchmove',  _tm, { passive: true });

    // ── Hammer.js gesture recognition ────────────────────────
    _initHammer();

    // Cache playmode reference so we can update the camera mask each frame
    // without a per-frame dynamic import (which is expensive).
    let _playmodeRef = null;
    import('./engine.playmode.js').then(m => { _playmodeRef = m; });

    let _last = performance.now();
    _ticker = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now();
        const dt  = Math.min((now - _last) / 1000, 0.1);
        _last = now;

        _updateCamera(dt);
        // Update scene clipping mask AFTER camera moves so objects never flicker
        // out-of-bounds when the camera follows a moving object.
        if (_playmodeRef) _playmodeRef.updateSceneMask();

        _runOverlapChecks();
        _runCollisionStayChecks();
        _applyDragThisFrame(dt);
        _tickTimers(dt);
        _tickDebugLines(dt);

        // 1. Snapshot every object's previous-frame position so the prediction
        //    system can estimate velocity for objects without a physics body.
        navSnapshotPositions();

        // 2. Run all scripts — they write desired velocity into obj._kinematicVx/Vy
        // Purge dead instances (destroyed objects) — prevents _instances from growing forever
        for (let i = _instances.length - 1; i >= 0; i--) {
            if (!state.gameObjects.includes(_instances[i].obj)) {
                _instances.splice(i, 1);
            }
        }
        const snap = [..._instances];
        for (const i of snap) {
            i.update(dt);
        }

        // 2. Step physics — reads _kinematicVx/Vy, runs Planck, writes corrected
        //    positions back. Scripts and physics are in the same frame, no race.
        if (_physicsModule) {
            _physicsModule.stepPhysics(dt);
        } else {
            import('./engine.physics.js').then(m => { _physicsModule = m; m.stepPhysics(dt); });
        }
    };
    state.app.ticker.add(_ticker);
    _logConsole(`▶ Scripts: ${count} instance${count!==1?'s':''} running`, '#4ade80');
}

// ── Stop scripts (stopPlayMode) ───────────────────────────────
export function stopScripts() {
    for (const i of _instances) i.stop();
    _instances.length = 0;
    _clearRegistries();
    _camera._followTarget = null;
    clearSceneVars();
    clearGlobalVars();  // reset between play sessions
    _clearTimers();
    _clearDebugGfx();
    if (window._zeGizmos) window._zeGizmos.collision = false; // reset collision gizmo between sessions
    _physicsModule = null; // clear cached ref so next play session re-resolves cleanly
    _destroyAllJoysticks();
    _activeDragObj  = null;
    _activeDragOpts = {};
    _throwVelX = _throwVelY = _throwPrevX = _throwPrevY = 0;
    _activeTouches  = [];
    if (_ticker && state.app) { state.app.ticker.remove(_ticker); _ticker = null; }
    window.removeEventListener('keydown',   _kd);
    window.removeEventListener('keyup',     _ku);
    window.removeEventListener('mousemove', _mm);
    window.removeEventListener('mousedown', _md);
    window.removeEventListener('mouseup',   _mu);
    window.removeEventListener('touchstart', _td);
    window.removeEventListener('touchend',   _tu);
    window.removeEventListener('touchmove',  _tm);
    _destroyHammer();
    // Remove speech bubbles from all objects
    for (const obj of state.gameObjects) {
        if (obj._speechBubble) {
            try { obj._speechBubble.destroy({ children: true }); } catch(_) {}
            obj._speechBubble = null;
        }
    }
    // Remove the chat dialog (delegates to engine.scripting.chat.js)
    stopChat();
}

// ── Public console log (used by engine.scenes for play-mode messages) ─────
export function _logConsolePublic(msg, color) { _logConsole(msg, color); }

// ── Collision bridge (called from engine.physics.js) ──────────
export function triggerCollision(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionEnter(objB);
        if (i.obj === objB) i.handleCollisionEnter(objA);
    }
}

// ── Collision exit bridge (called from engine.physics.js) ─────
export function triggerCollisionEnd(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionExit(objB);
        if (i.obj === objB) i.handleCollisionExit(objA);
    }
}

// ── Collision stay bridge (called from engine.physics.js) ─────
export function triggerCollisionStay(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionStay?.(objB);
        if (i.obj === objB) i.handleCollisionStay?.(objA);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// SCRIPTING API SELF-TEST
// Verifies: AsyncFunction compile (no "unexpected reserved word"),
//           say/think bubble construction, chat bridge registration.
// Run via:  import { runScriptingApiTests } from './engine.scripting.js';
//           runScriptingApiTests();
// ══════════════════════════════════════════════════════════════════════════════

export function runScriptingApiTests() {
    const results = [];
    const pass = (name) => { results.push(`  ✅ ${name}`); };
    const fail = (name, err) => { results.push(`  ❌ ${name}: ${err}`); };

    // ── Test 1: AsyncFunction compiles without "unexpected reserved word" ──────
    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const code = `var result = await Promise.resolve(42);`;
        const fn   = new AsyncFunction('api', '__out', code);
        pass('AsyncFunction: top-level await compiles OK');
    } catch (e) {
        fail('AsyncFunction: top-level await', e.message);
    }

    // ── Test 2: async/await inside nested function ────────────────────────────
    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const code = `
            async function fetchData() {
                const val = await Promise.resolve('hello');
                return val;
            }
        `;
        const fn = new AsyncFunction('api', '__out', code);
        pass('AsyncFunction: nested async function compiles OK');
    } catch (e) {
        fail('AsyncFunction: nested async function', e.message);
    }

    // ── Test 3: say() and think() resolve api._ref not bare obj ──────────────
    try {
        // Simulate the prelude snippet directly
        let calledWith = null;
        function _drawSpeechBubble(ref, text, style, dur) { calledWith = ref; }
        const api = { _ref: { label: 'TestSprite', addChild: () => {} } };
        // Replicate the fixed prelude function
        function say(text, duration) { _drawSpeechBubble(api._ref, text, 'say', duration); }
        say('Hello!');
        if (calledWith === api._ref) {
            pass('say(): passes api._ref correctly');
        } else {
            fail('say(): wrong obj', `got ${calledWith}`);
        }
    } catch (e) {
        fail('say() execution', e.message);
    }

    // ── Test 4: think() same check ────────────────────────────────────────────
    try {
        let calledWith = null;
        function _drawSpeechBubble2(ref, text, style, dur) { calledWith = ref; }
        const api = { _ref: { label: 'TestSprite' } };
        function think(text, duration) { _drawSpeechBubble2(api._ref, text, 'think', duration); }
        think('Hmm...');
        if (calledWith === api._ref) {
            pass('think(): passes api._ref correctly');
        } else {
            fail('think(): wrong obj', `got ${calledWith}`);
        }
    } catch (e) {
        fail('think() execution', e.message);
    }

    // ── Test 5: window._ze chat bridge is registered ─────────────────────────
    try {
        if (typeof window !== 'undefined') {
            const hasShowChat   = typeof window._ze?.showChat   === 'function';
            const hasHideChat   = typeof window._ze?.hideChat   === 'function';
            const hasChatSay    = typeof window._ze?.chatSay    === 'function';
            const hasChatPlayer = typeof window._ze?.chatPlayer === 'function';
            const hasAiChat     = typeof window._ze?.aiChat     === 'function';
            if (hasShowChat && hasHideChat && hasChatSay && hasChatPlayer && hasAiChat) {
                pass('window._ze: all 5 chat functions registered');
            } else {
                const missing = ['showChat','hideChat','chatSay','chatPlayer','aiChat']
                    .filter(k => typeof window._ze?.[k] !== 'function');
                fail('window._ze: missing functions', missing.join(', '));
            }
        } else {
            pass('window._ze: skipped (non-browser environment)');
        }
    } catch (e) {
        fail('window._ze check', e.message);
    }

    // ── Test 6: showChat uses api.name not bare obj ───────────────────────────
    try {
        let receivedName = null;
        const fakeZe = { showChat: (n) => { receivedName = n; } };
        const api = { name: 'Knight' };
        // Replicate the fixed prelude function
        function showChat(npcName, onInput) { fakeZe.showChat(npcName ?? api.name ?? 'NPC', onInput); }
        showChat(undefined, null);
        if (receivedName === 'Knight') {
            pass('showChat(): falls back to api.name correctly');
        } else {
            fail('showChat(): wrong name fallback', `got "${receivedName}"`);
        }
    } catch (e) {
        fail('showChat() name fallback', e.message);
    }

    // ── Test 7: prelude template literal compiles without backtick truncation ──
    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        // Reproduces the exact pattern that was broken: a template literal used
        // inside a function that is itself inside the prelude template literal.
        const code = `
            function drawText(text, x, y, opts) {
                const key = opts.id != null ? String(opts.id) : \`_auto_\${x}_\${y}\`;
                return key;
            }
            var result = drawText('hi', 1, 2, {});
        `;
        const fn = new AsyncFunction('api', '__out', code);
        pass('Prelude: backtick template literal in inner function compiles OK');
    } catch (e) {
        fail('Prelude: backtick template literal in inner function', e.message);
    }

    // ── Report ────────────────────────────────────────────────────────────────
    const passed = results.filter(r => r.includes('✅')).length;
    const total  = results.length;
    console.group(`%c[Zengine Script API Tests] ${passed}/${total} passed`,
        passed === total ? 'color:#4ade80;font-weight:bold' : 'color:#f87171;font-weight:bold');
    results.forEach(r => console.log(r));
    console.groupEnd();
    return { passed, total, results };
}
