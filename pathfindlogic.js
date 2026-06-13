/* ============================================================
   Zengine — pathfindlogic.js
   Advanced 2D AI navigation utilities.
   Imported by engine.scripting.js.

   Provides on top of the core A* engine:
     • Prediction    — intercept moving targets by extrapolating velocity
     • Memory        — last-seen position with time-based decay
     • Anti-stuck    — detect zero-progress and issue backup / repath actions
     • Separation    — repulsion steering so agents don't pile up
     • Vision / FOV  — line-of-sight (grid + fallback) + angle cone check
     • Flee          — flee-velocity computation (inverse of pursuit)
     • Wander        — smooth random wandering with per-agent state
     • Pos-snapshot  — one-shot per-frame position recorder for velocity estimation
   ============================================================ */

import { state } from './engine.state.js';

// ── Tuneable constants ────────────────────────────────────────
const MEMORY_DECAY     = 10;   // seconds until a last-seen entry expires
const STUCK_INTERVAL   = 0.6;  // seconds between stuck-position checks
const STUCK_THRESHOLD  = 10;   // pixels — must move at least this far per check
const STUCK_REPATH_CNT = 2;    // consecutive failed checks → trigger backup
const STUCK_BACKUP_DUR = 0.45; // seconds to back up when stuck fires
const SEP_FALLOFF      = 1.8;  // exponent for separation distance falloff

// ── Per-agent memory (WeakMap — GC-friendly, no manual cleanup needed) ────
const _agentMem = new WeakMap();

function _getMem(obj) {
    if (!_agentMem.has(obj)) {
        _agentMem.set(obj, {
            lastSeen: {},   // targetLabel → { x, y, t }
            wander:   null, // wander sub-state { targetPx, timer }
        });
    }
    return _agentMem.get(obj);
}

// ════════════════════════════════════════════════════════════════
// POSITION SNAPSHOT  (call once per frame before scripts run)
// Lets navPredictPosition estimate velocity without a physics body.
// ════════════════════════════════════════════════════════════════

export function navSnapshotPositions() {
    for (const o of state.gameObjects) {
        o._prevX = o.x;
        o._prevY = o.y;
    }
}

// ════════════════════════════════════════════════════════════════
// PREDICTION  — estimate where a target will be N seconds ahead
// ════════════════════════════════════════════════════════════════

/**
 * Returns a PIXI-pixel {x, y} estimate of targetObj's position `dtSec`
 * seconds from now.  Uses the Planck physics body velocity when present,
 * otherwise falls back to a one-frame finite-difference estimate stored
 * by navSnapshotPositions() above.
 */
export function navPredictPosition(targetObj, dtSec) {
    let vx = 0, vy = 0;
    const body = targetObj._physicsBody;
    if (body) {
        try {
            const v = body.getLinearVelocity();
            // Planck velocities are in world-units/sec; convert to px/sec (*100)
            vx = v.x * 100;
            vy = v.y * 100;
        } catch (_) {}
    } else if (targetObj._prevX !== undefined) {
        // 1-frame finite difference; multiply by 60 to get px/sec
        vx = (targetObj.x - targetObj._prevX) * 60;
        vy = (targetObj.y - targetObj._prevY) * 60;
    }
    return {
        x: targetObj.x + vx * dtSec,
        y: targetObj.y + vy * dtSec,
    };
}

// ════════════════════════════════════════════════════════════════
// MEMORY  — remember the last time each agent saw each target
// ════════════════════════════════════════════════════════════════

/**
 * Record that agentObj currently observes targetObj at its present position.
 * Called automatically by walkToObject/pursue when `memory !== false`.
 */
export function navUpdateMemory(agentObj, targetObj) {
    const mem = _getMem(agentObj);
    const key = targetObj.label ?? String(targetObj);
    mem.lastSeen[key] = { x: targetObj.x, y: targetObj.y, t: Date.now() };
}

/**
 * Return the last recorded PIXI-pixel position {x,y} of a named target,
 * or null if never seen or the memory has expired (> MEMORY_DECAY seconds).
 */
export function navGetLastKnownPos(agentObj, targetLabel) {
    const mem   = _getMem(agentObj);
    const entry = mem.lastSeen[targetLabel];
    if (!entry) return null;
    const ageSec = (Date.now() - entry.t) / 1000;
    if (ageSec > MEMORY_DECAY) {
        delete mem.lastSeen[targetLabel];
        return null;
    }
    return { x: entry.x, y: entry.y };
}

/**
 * Erase all memory entries for agentObj (e.g. when respawning or resetting).
 */
export function navClearMemory(agentObj) {
    if (_agentMem.has(agentObj)) {
        const m = _agentMem.get(agentObj);
        m.lastSeen = {};
        m.wander   = null;
    }
}

// ════════════════════════════════════════════════════════════════
// LINE-OF-SIGHT  (Bresenham sweep against nav obstacle grid)
// ════════════════════════════════════════════════════════════════

/**
 * Returns true when agentObj has an unobstructed line of sight to targetObj.
 *
 * Strategy (fastest → most accurate):
 *   1. Optional range check — bail out early if beyond maxRange.
 *   2. If a nav grid was built for agentObj this frame (_nav._grid), use a
 *      Bresenham walk across the obstacle bitmap — O(N cells along line).
 *   3. Fallback: AABB intersection sweep against static / tagged objects.
 *
 * opts:
 *   maxRange    — world units (default: unlimited)
 *   avoidStatic — fallback mode: treat static bodies as blockers (default true)
 *   avoidTag    — fallback mode: only this tag blocks sight
 */
export function navCanSee(agentObj, targetObj, opts = {}) {
    const ax = agentObj.x,  ay = agentObj.y;
    const tx = targetObj.x, ty = targetObj.y;

    // 1. Range gate
    if (opts.maxRange != null) {
        const rdx = tx - ax, rdy = ty - ay;
        if (Math.sqrt(rdx*rdx + rdy*rdy) > opts.maxRange * 100) return false;
    }

    // 2. Grid-based Bresenham walk
    const g = agentObj._nav?._grid;
    if (g) {
        const { grid, cols, rows, ox, oy, cs } = g;
        const sc = Math.floor((ax - ox) / cs);
        const sr = Math.floor((ay - oy) / cs);
        const ec = Math.floor((tx - ox) / cs);
        const er = Math.floor((ty - oy) / cs);
        return _bresenhamClear(grid, cols, rows, sc, sr, ec, er);
    }

    // 3. AABB segment fallback
    const avoidStatic = opts.avoidStatic ?? true;
    const avoidTag    = opts.avoidTag ?? null;
    for (const o of state.gameObjects) {
        if (o === agentObj || o === targetObj || !o.visible) continue;
        if (avoidTag) {
            if ((o._scriptTag ?? '') !== avoidTag) continue;
        } else if (avoidStatic) {
            if ((o.physicsBody ?? 'none') !== 'static') continue;
        } else {
            continue;
        }
        if (_segmentBlockedByAABB(ax, ay, tx, ty, o)) return false;
    }
    return true;
}

function _bresenhamClear(grid, cols, rows, c0, r0, c1, r1) {
    const dc = Math.abs(c1 - c0);
    const dr = Math.abs(r1 - r0);
    let   c  = c0, r = r0;
    const sc = c0 < c1 ? 1 : -1;
    const sr = r0 < r1 ? 1 : -1;
    let   err = dc - dr;
    let   steps = dc + dr + 1;
    while (steps-- > 0) {
        if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
        if (grid[r * cols + c]) return false;
        if (c === c1 && r === r1) break;
        const e2 = 2 * err;
        if (e2 > -dr) { err -= dr; c += sc; }
        if (e2 <  dc) { err += dc; r += sr; }
    }
    return true;
}

function _segmentBlockedByAABB(ax, ay, bx, by, obj) {
    const hw = (obj.spriteGraphic?.width  ?? obj._bounds?.width  ?? 100) / 2;
    const hh = (obj.spriteGraphic?.height ?? obj._bounds?.height ?? 100) / 2;
    const sx = Math.abs(obj.scale?.x ?? 1);
    const sy = Math.abs(obj.scale?.y ?? 1);
    const L = obj.x - hw*sx, R = obj.x + hw*sx;
    const T = obj.y - hh*sy, B = obj.y + hh*sy;
    // Liang–Barsky clip
    const dx = bx - ax, dy = by - ay;
    let tMin = 0, tMax = 1;
    for (const [p, q] of [[-dx, ax-L],[dx, R-ax],[-dy, ay-T],[dy, B-ay]]) {
        if (p === 0) { if (q < 0) return true; continue; }
        const t = q / p;
        if (p < 0) { if (t > tMax) return false; if (t > tMin) tMin = t; }
        else        { if (t < tMin) return false; if (t < tMax) tMax = t; }
    }
    return tMin <= tMax;
}

// ════════════════════════════════════════════════════════════════
// FIELD OF VIEW  — forward-cone + optional range check
// ════════════════════════════════════════════════════════════════

/**
 * Returns true if targetObj lies within the agent's forward view cone.
 *
 * fovDeg  — total cone width in degrees (e.g. 90 = ±45° each side of forward)
 * range   — world units, 0 means unlimited
 *
 * "Forward" is derived from the agent's .rotation (PIXI radians, 0 = up).
 * If the agent has a _vel set, that direction is used instead for accuracy
 * even before the sprite has visually rotated.
 */
export function navInFOV(agentObj, targetObj, fovDeg, range) {
    const dx = targetObj.x - agentObj.x;
    const dy = targetObj.y - agentObj.y;
    const d  = Math.sqrt(dx*dx + dy*dy);
    if (range > 0 && d > range * 100) return false;
    if (d < 1) return true; // overlapping — always "in view"

    // Determine facing direction (unit vector)
    let fx, fy;
    const nav = agentObj._nav;
    if (nav?.api?._vel) {
        const vx = nav.api._vel.x ?? 0;
        const vy = nav.api._vel.y ?? 0;
        const vl = Math.sqrt(vx*vx + vy*vy);
        if (vl > 0.001) {
            // _vel is in world units (+Y = up); flip Y for PIXI comparison
            fx = vx / vl;
            fy = -vy / vl;
        } else {
            const rot = agentObj.rotation ?? 0;
            fx = Math.sin(rot); fy = -Math.cos(rot);
        }
    } else {
        const rot = agentObj.rotation ?? 0;
        fx = Math.sin(rot); fy = -Math.cos(rot);
    }

    const dot      = fx * (dx/d) + fy * (dy/d);
    const halfCone = (fovDeg / 2) * (Math.PI / 180);
    return dot >= Math.cos(halfCone);
}

// ════════════════════════════════════════════════════════════════
// SEPARATION STEERING  — push agents away from each other
// ════════════════════════════════════════════════════════════════

/**
 * Return an {x, y} repulsion velocity (world units/sec) that steers
 * agentObj away from every other nav-active agent within radiusPx pixels.
 * Magnitude is capped at `maxSpeed`.
 */
export function navSeparationForce(agentObj, radiusPx, maxSpeed) {
    let fx = 0, fy = 0;
    const r2 = radiusPx * radiusPx;
    for (const o of state.gameObjects) {
        if (o === agentObj || !o._nav?.active) continue;
        const dx = agentObj.x - o.x;
        const dy = agentObj.y - o.y;
        const d2 = dx*dx + dy*dy;
        if (d2 === 0 || d2 >= r2) continue;
        const d        = Math.sqrt(d2);
        const strength = Math.pow(1 - d / radiusPx, SEP_FALLOFF) * maxSpeed;
        fx += (dx / d) * strength;
        fy += (dy / d) * strength;
    }
    const fLen = Math.sqrt(fx*fx + fy*fy);
    if (fLen > maxSpeed && fLen > 0) {
        fx = (fx / fLen) * maxSpeed;
        fy = (fy / fLen) * maxSpeed;
    }
    return { x: fx, y: fy };
}

// ════════════════════════════════════════════════════════════════
// ANTI-STUCK DETECTION  — per-frame tick, returns recovery action
// ════════════════════════════════════════════════════════════════

/**
 * Must be called every frame from inside _navTick (receives dt in seconds).
 * Returns one of:
 *   null      — no action; movement is progressing normally
 *   'repath'  — agent hasn't moved enough; retry A* from current position
 *   'backup'  — repeated failure; back up first, then repath next frame
 */
export function navTickStuck(obj, dt) {
    const nav = obj._nav;
    if (!nav || !nav.active) return null;

    if (!nav._stuck) {
        nav._stuck = { timer: 0, lastX: obj.x, lastY: obj.y, count: 0, backing: 0 };
    }
    const s = nav._stuck;

    // Count down active backup phase — do not interrupt it
    if (s.backing > 0) {
        s.backing -= dt;
        return null;
    }

    s.timer += dt;
    if (s.timer < STUCK_INTERVAL) return null;

    const moved = Math.sqrt((obj.x - s.lastX)**2 + (obj.y - s.lastY)**2);
    s.timer = 0;
    s.lastX = obj.x;
    s.lastY = obj.y;

    if (moved >= STUCK_THRESHOLD) {
        s.count = 0; // healthy movement — reset counter
        return null;
    }

    s.count++;
    if (s.count >= STUCK_REPATH_CNT) {
        s.count   = 0;
        s.backing = STUCK_BACKUP_DUR;
        return 'backup';
    }
    return 'repath';
}

/** Returns true if the agent's stuck counter is non-zero (has recently failed to progress). */
export function navIsStuck(obj) {
    return (obj._nav?._stuck?.count ?? 0) > 0;
}

// ════════════════════════════════════════════════════════════════
// FLEE  — velocity pointing directly away from a target
// ════════════════════════════════════════════════════════════════

/**
 * Compute a flee velocity {x, y} in world units/sec.
 * The Y component is already flipped (world +Y = up) so it can be
 * assigned directly to api._vel.
 *
 * agentObj / targetObj — raw game objects (PIXI pixel space)
 * speed               — world units / sec
 */
export function navFleeVelocity(agentObj, targetObj, speed) {
    const dx = agentObj.x - targetObj.x;
    const dy = agentObj.y - targetObj.y;
    const d  = Math.sqrt(dx*dx + dy*dy);
    if (d < 1) return { x: speed, y: 0 }; // overlapping — pick any direction
    return {
        x:  (dx / d) * speed,           // world X (+right)
        y: -(dy / d) * speed,           // world Y (+up) — note Y-flip
    };
}

// ════════════════════════════════════════════════════════════════
// WANDER  — per-frame tick for smooth random movement
// ════════════════════════════════════════════════════════════════

/**
 * Call every frame to drive wander behaviour.
 * Writes directly to api._vel (world units/sec, Y already flipped).
 *
 * opts:
 *   speed          — world units/sec  (default 1.5)
 *   radius         — world units to pick targets within (default 3)
 *   changeInterval — seconds between picking a new waypoint (default 2)
 */
export function navTickWander(obj, api, dt, opts = {}) {
    const speed          = (opts.speed          ?? 1.5);
    const radiusPx       = (opts.radius         ?? 3  ) * 100;
    const changeInterval = (opts.changeInterval ?? 2.0);

    const mem = _getMem(obj);
    if (!mem.wander) mem.wander = { targetPx: null, timer: 0 };
    const w = mem.wander;

    w.timer -= dt;
    if (!w.targetPx || w.timer <= 0) {
        const angle    = Math.random() * Math.PI * 2;
        const r        = radiusPx * (0.4 + Math.random() * 0.6);
        w.targetPx     = { x: obj.x + Math.cos(angle) * r, y: obj.y + Math.sin(angle) * r };
        w.timer        = changeInterval * (0.7 + Math.random() * 0.6);
    }

    const dx   = w.targetPx.x - obj.x;
    const dy   = w.targetPx.y - obj.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > 10) {
        api._vel.x =  (dx / dist) * speed;
        api._vel.y = -(dy / dist) * speed; // Y-flip
    } else {
        w.targetPx = null; // arrived — pick new target next tick
    }
}
