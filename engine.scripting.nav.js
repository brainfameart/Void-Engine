/* ============================================================
   engine.scripting.nav.js
   A* pathfinding engine + nav-tick locomotion for the scripting
   system.  All functions are module-private; _buildSandbox in
   engine.scripting.sandbox.js closes over them via the shared
   import below.
   ============================================================ */

import { state }        from './engine.state.js';
import { _logConsole, _instances, _getAABB } from './engine.scripting.shared.js';
import {
    navFleeVelocity, navSeparationForce, navTickWander, navTickStuck,
    navPredictPosition, navUpdateMemory,
} from './pathfindlogic.js';

// ══════════════════════════════════════════════════════════════════════════════
// ── PATHFINDING ENGINE (A* on dynamic obstacle grid) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build an obstacle bitmap for A*.
 * Returns { grid: Uint8Array, cols, rows, ox, oy, cs }
 *   grid[row*cols+col] = 1 means blocked
 *   ox/oy = pixel origin (top-left of grid)
 *   cs    = cell size in pixels
 */
function _navBuildGrid(agentObj, opts, destPx) {
    // ── Agent clearance radius ───────────────────────────────────────────────
    // If minHoleSize is given (world units), the agent radius is derived so
    // any gap ≥ minHoleSize is navigable.  Otherwise fall back to the sprite
    // half-width or an explicit agentRadius override.
    const sprW = agentObj.spriteGraphic?.width  ?? agentObj._bounds?.width  ?? 50;
    const sprH = agentObj.spriteGraphic?.height ?? agentObj._bounds?.height ?? 50;
    const agentHW = (Math.min(sprW, sprH) * Math.abs(agentObj.scale?.x ?? 1)) / 2;

    let agentR;
    if (opts.minHoleSize != null) {
        // minHoleSize (world units) → pixel radius that still leaves one cell
        // of clearance inside the narrowest navigable gap.
        agentR = Math.max(1, opts.minHoleSize * 100 / 2 - 1);
    } else if (opts.agentRadius != null) {
        agentR = opts.agentRadius * 100;
    } else {
        agentR = agentHW;
    }

    // ── Cell size ────────────────────────────────────────────────────────────
    // When minHoleSize is supplied, cells must be small enough that a
    // minHoleSize-wide gap contains at least 2 cells → cs ≤ minHoleSize*50.
    let cs;
    if (opts.cellSize != null) {
        cs = Math.max(8, opts.cellSize * 100);
    } else if (opts.minHoleSize != null) {
        // Cell fits neatly inside the narrowest allowed gap
        cs = Math.max(8, Math.min(opts.minHoleSize * 50, agentR * 2));
    } else {
        cs = Math.max(20, Math.min(80, agentR * 2.5));
    }

    // ── Grid bounds: cover agent + destination + every obstacle ─────────────
    // This ensures the grid works at any location, not just near scene origin.
    const obstacles = _navGetObstacles(agentObj, opts);
    const pad = agentR;

    let minWX = agentObj.x, maxWX = agentObj.x;
    let minWY = agentObj.y, maxWY = agentObj.y;
    if (destPx) {
        minWX = Math.min(minWX, destPx.x); maxWX = Math.max(maxWX, destPx.x);
        minWY = Math.min(minWY, destPx.y); maxWY = Math.max(maxWY, destPx.y);
    }
    for (const o of obstacles) {
        const bb = _getAABB(o);
        minWX = Math.min(minWX, bb.left);   maxWX = Math.max(maxWX, bb.right);
        minWY = Math.min(minWY, bb.top);    maxWY = Math.max(maxWY, bb.bottom);
    }
    // Also extend to cover any tilemap objects
    for (const tm of state.gameObjects) {
        if (!tm.isTilemap && !tm.isAutoTilemap) continue;
        const bb = _getAABB(tm);
        if (bb) {
            minWX = Math.min(minWX, bb.left);  maxWX = Math.max(maxWX, bb.right);
            minWY = Math.min(minWY, bb.top);   maxWY = Math.max(maxWY, bb.bottom);
        }
    }
    const margin = Math.max(pad * 4, 150);
    const ox     = minWX - margin;
    const oy     = minWY - margin;
    const totalW = (maxWX - minWX) + margin * 2;
    const totalH = (maxWY - minWY) + margin * 2;
    const cols   = Math.max(4, Math.ceil(totalW / cs));
    const rows   = Math.max(4, Math.ceil(totalH / cs));
    const grid   = new Uint8Array(cols * rows); // 0 = free, 1 = blocked

    // ── Mark obstacle cells ──────────────────────────────────────────────────
    for (const o of obstacles) {
        const bb = _getAABB(o);
        const left   = bb.left   - pad;
        const right  = bb.right  + pad;
        const top    = bb.top    - pad;
        const bottom = bb.bottom + pad;
        const c0 = Math.max(0, Math.floor((left   - ox) / cs));
        const c1 = Math.min(cols - 1, Math.ceil((right  - ox) / cs));
        const r0 = Math.max(0, Math.floor((top    - oy) / cs));
        const r1 = Math.min(rows - 1, Math.ceil((bottom - oy) / cs));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                grid[r * cols + c] = 1;
            }
        }
    }

    // ── Mark tilemap tiles as blocked ────────────────────────────────────────
    for (const tmObj of state.gameObjects) {
        if (!tmObj.isTilemap && !tmObj.isAutoTilemap) continue;
        _navMarkTilemapBlocked(grid, cols, rows, ox, oy, cs, pad, tmObj);
    }

    return { grid, cols, rows, ox, oy, cs };
}

function _navMarkTilemapBlocked(grid, cols, rows, ox, oy, cs, pad, tmObj) {
    let tileW, tileH, tmCols, tmRows, isFilled;
    if (tmObj.isTilemap && tmObj.tilemapData) {
        const d = tmObj.tilemapData;
        ({ tileW, tileH } = d);
        tmCols = d.cols; tmRows = d.rows;
        const tiles = d.tiles;
        isFilled = i => tiles && tiles[i] >= 0;
    } else if (tmObj.isAutoTilemap && tmObj.autoTileData) {
        const d = tmObj.autoTileData;
        ({ tileW, tileH } = d);
        tmCols = d.cols; tmRows = d.rows;
        const cells = d.cells;
        isFilled = i => Array.isArray(cells?.[i]) && cells[i].length > 0;
    } else {
        return;
    }
    const tw = (tileW ?? 32) * Math.abs(tmObj.scale?.x ?? 1);
    const th = (tileH ?? 32) * Math.abs(tmObj.scale?.y ?? 1);
    const totalCells = (tmCols ?? 0) * (tmRows ?? 0);
    for (let i = 0; i < totalCells; i++) {
        if (!isFilled(i)) continue;
        const col = i % tmCols, row = Math.floor(i / tmCols);
        const left   = tmObj.x + col * tw - pad;
        const right  = left + tw + pad * 2;
        const top    = tmObj.y + row * th - pad;
        const bottom = top + th + pad * 2;
        const c0 = Math.max(0, Math.floor((left   - ox) / cs));
        const c1 = Math.min(cols - 1, Math.ceil((right  - ox) / cs));
        const r0 = Math.max(0, Math.floor((top    - oy) / cs));
        const r1 = Math.min(rows - 1, Math.ceil((bottom - oy) / cs));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                grid[r * cols + c] = 1;
            }
        }
    }
}

function _navGetObstacles(agentObj, opts) {
    const result = [];
    const avoidTag    = opts.avoidTag;
    const avoidGroup  = opts.avoidGroup;
    const avoidStatic = opts.avoidStatic;
    const avoidAll    = opts.avoidAll;
    const avoidTags   = avoidTag   ? (Array.isArray(avoidTag)  ? avoidTag   : [avoidTag])   : [];
    const avoidGroups = avoidGroup ? (Array.isArray(avoidGroup)? avoidGroup : [avoidGroup]) : [];

    for (const o of state.gameObjects) {
        if (o === agentObj) continue;
        if (!o.visible) continue;
        let blocked = false;
        if (avoidAll && (o.physicsBody ?? 'none') !== 'none') blocked = true;
        if (!blocked && avoidStatic && (o.physicsBody ?? 'none') === 'static') blocked = true;
        if (!blocked && avoidTags.length) {
            const tag = o._scriptTag ?? '';
            if (avoidTags.includes(tag)) blocked = true;
        }
        if (!blocked && avoidGroups.length) {
            const grp = o._scriptGroup ?? '';
            if (avoidGroups.includes(grp)) blocked = true;
        }
        if (blocked) result.push(o);
    }
    return result;
}

/** World-pixel point → grid cell */
function _navWorldToCell(wx, wy, ox, oy, cs) {
    return {
        c: Math.floor((wx - ox) / cs),
        r: Math.floor((wy - oy) / cs),
    };
}

/** Grid cell centre → world-pixel point */
function _navCellToWorld(c, r, ox, oy, cs) {
    return {
        x: ox + c * cs + cs / 2,
        y: oy + r * cs + cs / 2,
    };
}

/**
 * A* pathfinding.
 * Returns array of pixel-space {x,y} waypoints (including start & end),
 * or null if no path found.
 */
function _navAstar(grid, cols, rows, sc, sr, ec, er) {
    if (sc < 0 || sc >= cols || sr < 0 || sr >= rows) return null;
    if (ec < 0 || ec >= cols || er < 0 || er >= rows) return null;

    // ── Relax START cell ─────────────────────────────────────────────────────
    // Physics can push the agent slightly into an obstacle's inflated zone,
    // making its grid cell blocked.  Find the nearest free cell so we always
    // get a valid path instead of immediately returning null (which would stop
    // the agent dead when it touches an avoided object).
    if (grid[sr * cols + sc]) {
        let best = null, bestD = Infinity;
        for (let dr = -4; dr <= 4; dr++) {
            for (let dc = -4; dc <= 4; dc++) {
                const nr = sr + dr, nc = sc + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (grid[nr * cols + nc]) continue;
                const d = dr*dr + dc*dc;
                if (d < bestD) { bestD = d; best = { r: nr, c: nc }; }
            }
        }
        if (!best) return null;
        sr = best.r; sc = best.c;
    }

    // ── Relax END cell ───────────────────────────────────────────────────────
    // When the target (e.g. player pressing against a wall) is inside an
    // inflated obstacle zone, find the closest reachable cell.  Using a
    // larger radius (8) ensures the AI gets as close as physically possible.
    if (grid[er * cols + ec]) {
        let best = null, bestD = Infinity;
        for (let dr = -8; dr <= 8; dr++) {
            for (let dc = -8; dc <= 8; dc++) {
                const nr = er + dr, nc = ec + dc;
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (grid[nr * cols + nc]) continue;
                const d = dr*dr + dc*dc;
                if (d < bestD) { bestD = d; best = { r: nr, c: nc }; }
            }
        }
        if (!best) return null;
        er = best.r; ec = best.c;
    }

    const idx = (r, c) => r * cols + c;
    const heur = (r, c) => {
        const dr = r - er, dc = c - ec;
        return Math.sqrt(dr * dr + dc * dc); // euclidean
    };

    // Binary min-heap
    const openHeap  = [];
    const gScore    = new Float32Array(cols * rows).fill(Infinity);
    const fScore    = new Float32Array(cols * rows).fill(Infinity);
    const cameFrom  = new Int32Array(cols * rows).fill(-1);
    const inOpen    = new Uint8Array(cols * rows);
    const inClosed  = new Uint8Array(cols * rows);

    const heapPush = (val) => {
        openHeap.push(val);
        let i = openHeap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (fScore[openHeap[parent]] <= fScore[openHeap[i]]) break;
            [openHeap[i], openHeap[parent]] = [openHeap[parent], openHeap[i]];
            i = parent;
        }
    };
    const heapPop = () => {
        const top = openHeap[0];
        const last = openHeap.pop();
        if (openHeap.length > 0) {
            openHeap[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2*i+1, r = 2*i+2;
                if (l < openHeap.length && fScore[openHeap[l]] < fScore[openHeap[smallest]]) smallest = l;
                if (r < openHeap.length && fScore[openHeap[r]] < fScore[openHeap[smallest]]) smallest = r;
                if (smallest === i) break;
                [openHeap[i], openHeap[smallest]] = [openHeap[smallest], openHeap[i]];
                i = smallest;
            }
        }
        return top;
    };

    const startIdx = idx(sr, sc);
    gScore[startIdx] = 0;
    fScore[startIdx] = heur(sr, sc);
    heapPush(startIdx);
    inOpen[startIdx] = 1;

    // 8-directional neighbours
    const DIRS = [
        [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
        [-1,-1, 1.4142], [-1, 1, 1.4142], [1,-1, 1.4142], [1, 1, 1.4142],
    ];

    const maxIter = Math.min(cols * rows, 8000); // safety cap
    let iter = 0;

    while (openHeap.length > 0 && iter++ < maxIter) {
        const cur = heapPop();
        const cr  = Math.floor(cur / cols);
        const cc  = cur - cr * cols;
        inClosed[cur] = 1;

        if (cr === er && cc === ec) {
            // Reconstruct path
            const path = [];
            let c = cur;
            while (c !== -1) {
                path.push(c);
                c = cameFrom[c];
            }
            path.reverse();
            return path.map(i => ({ r: Math.floor(i / cols), c: i % cols }));
        }

        for (const [dr, dc, cost] of DIRS) {
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const ni = idx(nr, nc);
            if (grid[ni] || inClosed[ni]) continue;
            // Diagonal clearance: both cardinal neighbours must be free
            if (dr !== 0 && dc !== 0) {
                if (grid[idx(cr + dr, cc)] || grid[idx(cr, cc + dc)]) continue;
            }
            const tentative = gScore[cur] + cost;
            if (tentative < gScore[ni]) {
                cameFrom[ni] = cur;
                gScore[ni]   = tentative;
                fScore[ni]   = tentative + heur(nr, nc);
                if (!inOpen[ni]) {
                    inOpen[ni] = 1;
                    heapPush(ni);
                }
            }
        }
    }
    return null; // no path
}

/**
 * String-pull (funnel) path smoother using line-of-sight.
 * Removes unnecessary waypoints when the agent can walk straight.
 */
function _navSmoothPath(rawCells, grid, cols, rows, ox, oy, cs) {
    if (!rawCells || rawCells.length <= 2) return rawCells;
    const smooth = [rawCells[0]];
    let cursor = 0;
    while (cursor < rawCells.length - 1) {
        let reach = cursor + 1;
        // Extend as far as we have unobstructed line of sight
        for (let test = cursor + 2; test < rawCells.length; test++) {
            if (_navLineOfSight(grid, cols, rows,
                rawCells[cursor].r, rawCells[cursor].c,
                rawCells[test].r,   rawCells[test].c)) {
                reach = test;
            } else {
                break; // first obstruction — stop extending
            }
        }
        smooth.push(rawCells[reach]);
        cursor = reach;
    }
    return smooth;
}

/** Bresenham line-of-sight check on the blocked grid */
function _navLineOfSight(grid, cols, rows, r0, c0, r1, c1) {
    let dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
    let r = r0, c = c0;
    const sr2 = r0 < r1 ? 1 : -1;
    const sc2 = c0 < c1 ? 1 : -1;
    let err = dc - dr;
    let steps = dr + dc;
    while (steps-- > 0) {
        if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
        if (grid[r * cols + c]) return false;
        const e2 = 2 * err;
        if (e2 > -dr) { err -= dr; c += sc2; }
        if (e2 <  dc) { err += dc; r += sr2; }
    }
    return true;
}

/** Per-instance nav state stored on obj._nav */
function _navStop(obj) {
    if (!obj._nav) return;
    obj._nav.active      = false;
    obj._nav.path        = [];
    obj._nav.follow      = false;
    obj._nav.target      = null;
    obj._nav.mode        = 'walk';
    obj._nav.fleeTarget  = null;
}

function _navStartWalk(obj, api, tx, ty, opts) {
    const wpx = tx * 100, wpy = -ty * 100; // world-pixel
    if (!obj._nav) obj._nav = {};
    obj._nav.active       = true;
    obj._nav.mode         = 'walk';
    obj._nav.destPx       = { x: wpx, y: wpy };
    obj._nav.opts         = opts;
    obj._nav.speed        = (opts.speed ?? 3) * 100; // px/sec
    obj._nav.stopRadius   = (opts.stopRadius ?? 0.3) * 100;
    obj._nav.onDone       = opts.onDone   ?? null;
    obj._nav.follow       = false;
    obj._nav.followTarget = null;
    obj._nav.repathTimer  = 0;
    obj._nav.repath       = (opts.repath ?? 0.5);
    obj._nav.debug        = opts.debug ?? false;
    obj._nav.smooth       = opts.smooth !== false;
    obj._nav.path         = [];
    obj._nav.pathIdx      = 0;
    obj._nav.api          = api;
    obj._nav.predict      = opts.predict     ?? false;
    obj._nav.predictTime  = opts.predictTime ?? 0.5;
    // Build path immediately
    _navRepath(obj);
}

function _navStartFollow(obj, api, target, opts) {
    // target.x / target.y are in PIXI pixel-space (Y-down).
    // _navStartWalk expects world units: worldX = px/100, worldY = -py/100
    _navStartWalk(obj, api, target.x / 100, -target.y / 100, opts);
    obj._nav.follow       = true;
    obj._nav.followTarget = target;
    obj._nav.destPx       = { x: target.x, y: target.y };
    obj._nav.repath       = (opts.repath ?? 0.5);
    obj._nav.followDone   = opts.follow !== true; // if follow=false, stop on arrival
    _navRepath(obj);
}

// ── Flee: run directly away from a target (no pathfinding) ──────────────
function _navStartFlee(obj, api, target, opts) {
    if (!obj._nav) obj._nav = {};
    obj._nav.active      = true;
    obj._nav.mode        = 'flee';
    obj._nav.fleeTarget  = target;
    obj._nav.speed       = (opts.speed ?? 3) * 100;
    obj._nav.opts        = opts;
    obj._nav.api         = api;
    obj._nav.follow      = false;
    obj._nav.path        = [];
    obj._nav._stuck      = null; // reset stuck state for fresh flee
}

// ── Wander: smooth random movement ──────────────────────────────────────
function _navStartWander(obj, api, opts) {
    if (!obj._nav) obj._nav = {};
    obj._nav.active = true;
    obj._nav.mode   = 'wander';
    obj._nav.speed  = (opts.speed ?? 1.5) * 100;
    obj._nav.opts   = opts;
    obj._nav.api    = api;
    obj._nav.follow = false;
    obj._nav.path   = [];
}

function _navRepath(obj) {
    const nav = obj._nav;
    if (!nav || !nav.active) return;

    const opts   = nav.opts ?? {};
    const gridInfo = _navBuildGrid(obj, opts, nav.destPx);
    const { grid, cols, rows, ox, oy, cs } = gridInfo;

    const sx = obj.x, sy = obj.y;
    const ex = nav.destPx.x, ey = nav.destPx.y;

    const start = _navWorldToCell(sx, sy, ox, oy, cs);
    const end   = _navWorldToCell(ex, ey, ox, oy, cs);

    const rawCells = _navAstar(grid, cols, rows, start.c, start.r, end.c, end.r);
    if (!rawCells) {
        _logConsole(`[Nav] No path found for "${obj.label}" — destination may be fully enclosed by obstacles.`, '#facc15');
        nav.active = false;
        return;
    }

    const cells = nav.smooth ? _navSmoothPath(rawCells, grid, cols, rows, ox, oy, cs) : rawCells;

    // Convert cells to pixel waypoints
    nav.path    = cells.map(cell => _navCellToWorld(cell.c, cell.r, ox, oy, cs));
    nav.pathIdx = 1; // skip first node (agent is already there)
    nav._grid   = gridInfo; // keep for debug draw

    // Track the actual last reachable point (may differ from destPx when the
    // target is pressed against a wall and A* relaxed the endpoint).
    // _navTick uses this to detect arrival even when destPx is inside a wall.
    const lastCell = cells[cells.length - 1];
    nav.effectiveDest = _navCellToWorld(lastCell.c, lastCell.r, ox, oy, cs);

    // Debug draw — show the computed path as cyan lines
    if (nav.debug) {
        const dbgApi = nav.api;
        if (dbgApi && nav.path.length >= 2) {
            for (let i = 0; i < nav.path.length - 1; i++) {
                const a = nav.path[i], b = nav.path[i + 1];
                // drawDebugLine(x1, y1, x2, y2, color, duration, width)
                dbgApi.drawDebugLine(
                    a.x / 100, -a.y / 100,
                    b.x / 100, -b.y / 100,
                    '#00e5ff', nav.repath + 0.1, 2
                );
            }
        }
    }
}

/**
 * Tick navigation for one object every frame.
 * Called from the update() path inside _navTickAll.
 *
 * Handles five modes:
 *   'walk'   — one-shot A* walk to a world position
 *   'follow' — continuously repaths toward a target (follow:true)
 *   'flee'   — direct velocity away from a target (no A*)
 *   'wander' — smooth random movement (no A*)
 *   prediction / separation / anti-stuck are layered on top of walk/follow.
 */
function _navTick(inst, dt) {
    const nav = inst.obj._nav;
    if (!nav || !nav.active) return;

    const obj = inst.obj;
    const api = inst.api;

    // ── FLEE mode ─────────────────────────────────────────────────────────────
    // Pure velocity: no pathfinding.  Runs directly away from fleeTarget.
    if (nav.mode === 'flee') {
        const t = nav.fleeTarget;
        // Stop if target has been destroyed or left the scene
        if (!t || !state.gameObjects.includes(t)) { nav.active = false; return; }
        const spd = nav.speed / 100; // world units/sec
        const fv  = navFleeVelocity(obj, t, spd);
        if (nav.opts?.separation) {
            const sepR = (nav.opts.separationRadius ?? 1.5) * 100;
            const sep  = navSeparationForce(obj, sepR, spd * 0.5);
            api._vel.x = fv.x + sep.x;
            api._vel.y = fv.y + sep.y;
        } else {
            api._vel.x = fv.x;
            api._vel.y = fv.y;
        }
        return;
    }

    // ── WANDER mode ───────────────────────────────────────────────────────────
    // Pure velocity: picks random nearby waypoints and glides toward them.
    if (nav.mode === 'wander') {
        navTickWander(obj, api, dt, nav.opts ?? {});
        return;
    }

    // ── ANTI-STUCK detection (walk / follow modes only) ───────────────────────
    const stuckAction = navTickStuck(obj, dt);
    if (stuckAction === 'backup') {
        // Reverse the last heading for STUCK_BACKUP_DUR seconds, then repath
        const bx  = -(api._vel.x || 0);
        const by  = -(api._vel.y || 0);
        const bLen = Math.sqrt(bx*bx + by*by);
        const spd  = nav.speed / 100;
        if (bLen > 0.0001) {
            api._vel.x = (bx / bLen) * spd;
            api._vel.y = (by / bLen) * spd;
        } else {
            // No prior heading — nudge in a random direction
            const a    = Math.random() * Math.PI * 2;
            api._vel.x = Math.cos(a) * spd;
            api._vel.y = Math.sin(a) * spd;
        }
        return;
    } else if (stuckAction === 'repath') {
        _navRepath(obj);
    }

    // ── REPATH timer (follow mode) ────────────────────────────────────────────
    nav.repathTimer = (nav.repathTimer ?? 0) + dt;
    if (nav.follow && nav.followTarget && nav.repathTimer >= nav.repath) {
        nav.repathTimer = 0;
        // PREDICTION: lead a moving target by estimating future position
        if (nav.predict && nav.followTarget) {
            const pred  = navPredictPosition(nav.followTarget, nav.predictTime ?? 0.5);
            nav.destPx  = pred;
        } else {
            nav.destPx  = { x: nav.followTarget.x, y: nav.followTarget.y };
        }
        // MEMORY: record last known position for the script's lastKnownPos()
        navUpdateMemory(obj, nav.followTarget);
        _navRepath(obj);
    }

    if (!nav.path || nav.path.length === 0) { nav.active = false; return; }

    // ── ARRIVAL check ─────────────────────────────────────────────────────────
    // Measure against BOTH the requested destination AND the effective
    // (A*-relaxed) endpoint so the AI stops when pinned against a wall.
    const dest  = nav.destPx;
    const dx0   = dest.x - obj.x, dy0 = dest.y - obj.y;
    let distToArrival = Math.sqrt(dx0*dx0 + dy0*dy0);
    if (nav.effectiveDest) {
        const edx = nav.effectiveDest.x - obj.x;
        const edy = nav.effectiveDest.y - obj.y;
        distToArrival = Math.min(distToArrival, Math.sqrt(edx*edx + edy*edy));
    }
    if (distToArrival <= nav.stopRadius) {
        api._vel.x = 0;
        api._vel.y = 0;
        if (!nav.follow || !nav.followDone) {
            nav.active = false;
            if (nav.onDone) try { nav.onDone(); } catch(_) {}
        }
        return;
    }

    // ── WAYPOINT traversal ────────────────────────────────────────────────────
    while (nav.pathIdx < nav.path.length) {
        const wp   = nav.path[nav.pathIdx];
        const dx   = wp.x - obj.x, dy = wp.y - obj.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < nav.stopRadius * 1.5) {
            nav.pathIdx++;
        } else {
            const spd = nav.speed;
            let vx =  (dx / dist) * spd / 100; // world units/sec
            let vy = -(dy / dist) * spd / 100; // Y flip
            // ── SEPARATION steering ───────────────────────────────────────────
            if (nav.opts?.separation) {
                const sepR = (nav.opts.separationRadius ?? 1.5) * 100;
                const sep  = navSeparationForce(obj, sepR, spd / 100 * 0.55);
                vx += sep.x;
                vy += sep.y;
            }
            api._vel.x = vx;
            api._vel.y = vy;
            return;
        }
    }

    // All waypoints consumed
    if (nav.follow) {
        nav.repathTimer = nav.repath; // force immediate repath next tick
    } else {
        nav.active = false;
        api._vel.x = 0;
        api._vel.y = 0;
        if (nav.onDone) try { nav.onDone(); } catch(_) {}
    }
}


// ── Exports used by engine.scripting.sandbox.js ───────────────
export { _navBuildGrid, _navAstar, _navSmoothPath, _navTick, _navStartWalk, _navStartFollow, _navStop, _navStartFlee, _navStartWander };
