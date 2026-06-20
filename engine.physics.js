/* ============================================================
   Zengine — engine.physics.js  (PLANCK.JS BACKEND)
   Physics backend replaced: Matter.js → Planck.js
   All exported APIs and object interfaces unchanged.
   ============================================================ */

import { state } from './engine.state.js';
import {
    collisionGeom, rawSpriteSize,
    tileAlphaBoundsForAsset, unionTileAlphaBounds,
} from './engine.collision-overlay.js';

const PLANCK_CDN = 'https://cdn.jsdelivr.net/npm/planck@1.0.0/dist/planck.min.js';

// px/s² — 980 = 9.8 m/s² with 100 px = 1 m
const GRAVITY_PX = 980;

// ── Module state ───────────────────────────────────────────────
let _world  = null;
let _rafId  = null;
let _bodies          = [];       // { obj, body: planck.Body, type }[]
let _tileBodies      = [];       // { body: planck.Body, ownerLabel }[]
const _bodyByPlanckBody = new Map(); // planck.Body → entry  (O(1) collision dispatch)
const _tileByPlanckBody = new Map(); // planck.Body → tileEntry
const _pendingCollisions  = [];
const _kinematicContacts  = new Map();

// ── Collision event dispatch ──────────────────────────────────
function _fireCollisionEvents() {
    if (_pendingCollisions.length === 0) return;
    const batch = _pendingCollisions.splice(0);
    import('./engine.scripting.js').then(m => {
        for (const { p: pair, type } of batch) {
            const entA = _bodyByPlanckBody.get(pair.bodyA);
            const entB = _bodyByPlanckBody.get(pair.bodyB);
            if (entA && entB) {
                if (type === 'start') m.triggerCollision(entA.obj, entB.obj);
                else                  m.triggerCollisionEnd(entA.obj, entB.obj);
                continue;
            }
            const spriteEnt = entA || entB;
            if (!spriteEnt) continue;
            const otherBody = spriteEnt === entA ? pair.bodyB : pair.bodyA;
            const tileEnt   = _tileByPlanckBody.get(otherBody);
            if (!tileEnt) continue;
            import('./engine.state.js').then(({ state }) => {
                const tileObj = state.gameObjects.find(o => o.label === tileEnt.ownerLabel);
                if (!tileObj) return;
                if (type === 'start') m.triggerCollision(spriteEnt.obj, tileObj);
                else                  m.triggerCollisionEnd(spriteEnt.obj, tileObj);
            });
        }
    });
}

// ── CDN loader ────────────────────────────────────────────────
function _loadPlanck() {
    return new Promise((resolve, reject) => {
        if (window.planck) { resolve(); return; }
        const el = document.getElementById('planck-js-script');
        if (el) {
            el.addEventListener('load',  resolve);
            el.addEventListener('error', () => reject(new Error('Planck.js load failed')));
            return;
        }
        const s  = document.createElement('script');
        s.id     = 'planck-js-script';
        s.src    = PLANCK_CDN;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Planck.js load failed: ' + PLANCK_CDN));
        document.head.appendChild(s);
    });
}

// ── Size helpers ───────────────────────────────────────────────
function _rawSize(obj) {
    const sg  = obj.spriteGraphic;
    const rs  = obj._runtimeSprite;
    const src = sg || rs;
    if (src?.texture?.orig)  return { w: src.texture.orig.width,  h: src.texture.orig.height };
    if (src?.texture?.width) return { w: src.texture.width,       h: src.texture.height };
    const sx = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy = Math.abs(obj.scale?.y ?? 1) || 1;
    if (src?.width && src?.height) return { w: src.width / sx, h: src.height / sy };
    return { w: 40, h: 40 };
}

export function _innerScale(obj) {
    const src = obj.spriteGraphic || obj._runtimeSprite;
    return {
        x: Math.abs(src?.scale?.x ?? 1) || 1,
        y: Math.abs(src?.scale?.y ?? 1) || 1,
    };
}

export function migratePolygonsToContainer(obj) {
    if (!obj || obj._polyUnit === 'container') return;
    const { x: ssx, y: ssy } = _innerScale(obj);
    if (ssx === 1 && ssy === 1) { obj._polyUnit = 'container'; return; }
    if (Array.isArray(obj.physicsPolygon)) {
        obj.physicsPolygon = obj.physicsPolygon.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
    }
    if (obj.physicsPolygons && typeof obj.physicsPolygons === 'object') {
        for (const k in obj.physicsPolygons) {
            const arr = obj.physicsPolygons[k];
            if (Array.isArray(arr)) {
                obj.physicsPolygons[k] = arr.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
            }
        }
    }
    obj._polyUnit = 'container';
}

// ── Active polygon for animated frame ────────────────────────
function _getActivePolygon(obj) {
    migratePolygonsToContainer(obj);
    const map = obj.physicsPolygons;
    if (!map) return obj.physicsPolygon || null;
    if (obj._runtimePhysicsFrameId
        && Array.isArray(map[obj._runtimePhysicsFrameId])
        && map[obj._runtimePhysicsFrameId].length >= 3) {
        return map[obj._runtimePhysicsFrameId];
    }
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return map[frameId];
    if (Array.isArray(map.shared) && map.shared.length >= 3) return map.shared;
    return null;
}

// ── Fixture / body options ────────────────────────────────────
function _bodyOpts(obj) {
    return {
        isSensor:           !!obj.physicsIsSensor,
        friction:           obj.physicsFriction    ?? 0.5,
        restitution:        obj.physicsRestitution ?? 0.05,
        density:            obj.physicsDensity     ?? 0.001,
        filterCategoryBits: (obj.physicsCollisionCategory ?? 0x0001) & 0xFFFF,
        filterMaskBits:     (obj.physicsCollisionMask ?? -1) >>> 0 & 0xFFFF,
    };
}

// ── Get world-space AABB of a Planck body ─────────────────────
function _getPlanckBodyBounds(body) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let f = body.getFixtureList(); f; f = f.getNext()) {
        try {
            const aabb = f.getAABB(0);
            if (aabb.lowerBound.x < minX) minX = aabb.lowerBound.x;
            if (aabb.lowerBound.y < minY) minY = aabb.lowerBound.y;
            if (aabb.upperBound.x > maxX) maxX = aabb.upperBound.x;
            if (aabb.upperBound.y > maxY) maxY = aabb.upperBound.y;
        } catch (_) {}
    }
    if (!isFinite(minX)) {
        const pos = body.getPosition();
        return { min: { x: pos.x - 16, y: pos.y - 16 }, max: { x: pos.x + 16, y: pos.y + 16 } };
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

// ── Build a Planck body for a game object ─────────────────────
function _makeBody(obj, cx, cy, bodyType) {
    const P    = window.planck;
    const opts = _bodyOpts(obj);
    const sx   = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy   = Math.abs(obj.scale?.y ?? 1) || 1;
    const g    = collisionGeom(obj);
    const w    = g.w * sx;
    const h    = g.h * sy;
    const r    = g.r * Math.min(sx, sy);
    const ox   = (g.ox || 0) * sx;
    const oy   = (g.oy || 0) * sy;

    // Body positioned at the collider centre (includes rotated offset)
    const rot  = obj.rotation || 0;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const bcx  = cx + ox * cosR - oy * sinR;
    const bcy  = cy + ox * sinR + oy * cosR;

    const shape = obj.physicsShape ?? 'box';
    const poly  = _getActivePolygon(obj);

    // kinematic bodies: treated as static + manually teleported each frame
    const isStatic = bodyType === 'static' || bodyType === 'kinematic';

    const body = _world.createBody({
        type:           isStatic ? 'static' : 'dynamic',
        position:       P.Vec2(bcx, bcy),
        angle:          rot,
        linearDamping:  obj.physicsLinearDamping  ?? 0.5,
        angularDamping: obj.physicsAngularDamping ?? 0.5,
        fixedRotation:  bodyType === 'dynamic' && !!obj.physicsFixedRotation,
        userData:       { label: obj.label },
    });

    const fixDef = {
        density:            bodyType === 'dynamic' ? (opts.density || 0.001) : 0,
        friction:           opts.friction,
        restitution:        opts.restitution,
        isSensor:           opts.isSensor,
        filterCategoryBits: opts.filterCategoryBits,
        filterMaskBits:     opts.filterMaskBits,
        filterGroupIndex:   0,
    };

    if (shape === 'circle') {
        body.createFixture({ ...fixDef, shape: P.Circle(Math.max(r, 2)) });
    } else if (shape === 'capsule') {
        const capW = (obj.physicsSize?.capW ?? g.w) * sx;
        const capH = (obj.physicsSize?.capH ?? g.h) * sy;
        const capR = Math.min(capW, capH) / 2;
        const len  = Math.max(capW, capH) / 2 - capR;
        const capFix = { ...fixDef, density: bodyType === 'dynamic' ? ((opts.density || 0.001) / 3) : 0 };
        try {
            if (capW >= capH) {
                body.createFixture({ ...capFix, shape: P.Box(Math.max(len, 1), Math.max(capH / 2, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(len, 0), Math.max(capR, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(-len, 0), Math.max(capR, 1)) });
            } else {
                body.createFixture({ ...capFix, shape: P.Box(Math.max(capW / 2, 1), Math.max(len, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(0, -len), Math.max(capR, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(0,  len), Math.max(capR, 1)) });
            }
        } catch (e) {
            console.warn('[Physics] capsule fixture failed, using box:', e.message);
            body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
        }
    } else if ((shape === 'polygon' || shape === 'shared') && Array.isArray(poly) && poly.length >= 3) {
        try {
            const verts = poly.slice(0, 8).map(p => P.Vec2(p.x * sx, p.y * sy));
            body.createFixture({ ...fixDef, shape: P.Polygon(verts) });
        } catch (e) {
            console.warn('[Physics] polygon fixture failed, using box:', e.message);
            body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
        }
    } else {
        body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
    }

    body._zenOffset = { x: ox, y: oy };
    return body;
}

// ── startPhysics ──────────────────────────────────────────────
export async function startPhysics() {
    if (_world) stopPhysics();
    try { await _loadPlanck(); }
    catch (err) { console.error('[Physics]', err); return; }

    const P = window.planck;
    _world = P.World({ gravity: P.Vec2(0, 0) });
    _bodies           = [];
    _tileBodies.length = 0;
    _bodyByPlanckBody.clear();
    _tileByPlanckBody.clear();
    _kinematicContacts.clear();

    // Pre-warm alpha-bounds cache for every animation frame that has a dataURL.
    // This ensures collisionGeom() never returns ox=0 on the first frame switch
    // (which would cause a one-frame mis-anchor when switching animation frames).
    const { alphaBoundsForDataURL } = await import('./engine.collision-overlay.js');
    const warmPromises = [];
    for (const obj of state.gameObjects) {
        if (!obj.animations) continue;
        for (const anim of obj.animations) {
            for (const frame of anim.frames || []) {
                if (!frame.dataURL) continue;
                const p = new Promise(res => {
                    const result = alphaBoundsForDataURL(frame.dataURL, res);
                    if (result !== null) res(); // already cached
                });
                warmPromises.push(p);
            }
        }
    }
    // Wait up to 2 seconds for cache to populate — then proceed regardless
    await Promise.race([
        Promise.all(warmPromises),
        new Promise(res => setTimeout(res, 2000)),
    ]);

    for (const obj of state.gameObjects) {
        // ── Tilemap → one static body per filled cell ────────
        if (obj.isTilemap) {
            const td = obj.tilemapData;
            for (let row = 0; row < td.rows; row++) {
                for (let col = 0; col < td.cols; col++) {
                    const aid = td.tiles[row * td.cols + col];
                    if (!aid) continue;
                    const ab = tileAlphaBoundsForAsset(aid, td.tileW, td.tileH);
                    const cx = obj.x + col * td.tileW + td.tileW / 2 + ab.ox;
                    const cy = obj.y + row * td.tileH + td.tileH / 2 + ab.oy;
                    const tb = _world.createBody({ type: 'static', position: P.Vec2(cx, cy) });
                    tb.createFixture({ shape: P.Box(Math.max(ab.w / 2, 1), Math.max(ab.h / 2, 1)), friction: 0.5, restitution: 0.05 });
                    tb.setUserData({ label: `tm_${obj.label}_${row}_${col}` });
                    tb._zenOffset = { x: 0, y: 0 };
                    const tileEnt1 = { body: tb, ownerLabel: obj.label };
                    _tileBodies.push(tileEnt1);
                    _tileByPlanckBody.set(tb, tileEnt1);
                }
            }
            continue;
        }

        if (obj.isAutoTilemap) {
            const d = obj.autoTileData;
            for (let row = 0; row < d.rows; row++) {
                for (let col = 0; col < d.cols; col++) {
                    const v   = d.cells[row * d.cols + col];
                    const ids = Array.isArray(v) ? v : (v ? [v] : []);
                    if (!ids.length) continue;
                    const ab = unionTileAlphaBounds(ids, d.tileW, d.tileH);
                    const cx = obj.x + col * d.tileW + d.tileW / 2 + ab.ox;
                    const cy = obj.y + row * d.tileH + d.tileH / 2 + ab.oy;
                    const tb = _world.createBody({ type: 'static', position: P.Vec2(cx, cy) });
                    tb.createFixture({ shape: P.Box(Math.max(ab.w / 2, 1), Math.max(ab.h / 2, 1)), friction: 0.5, restitution: 0.05 });
                    tb.setUserData({ label: `at_${obj.label}_${row}_${col}` });
                    tb._zenOffset = { x: 0, y: 0 };
                    const tileEnt2 = { body: tb, ownerLabel: obj.label };
                    _tileBodies.push(tileEnt2);
                    _tileByPlanckBody.set(tb, tileEnt2);
                }
            }
            continue;
        }

        // ── Regular sprite ────────────────────────────────────
        const type = obj.physicsBody || 'none';
        if (type === 'none') continue;

        if (type === 'kinematic') {
            obj._kinematicVx           = 0;
            obj._kinematicVy           = 0;
            // Sustained velocity — persists frame-to-frame like Godot's
            // CharacterBody2D.velocity / Unity's Rigidbody.velocity, unlike
            // _kinematicVx/Vy which is a one-shot per-frame input that scripts
            // re-supply every update(). Used by throwObject()/makeThrowable()
            // so thrown objects WITHOUT a script keep moving after release.
            obj._kinematicSustainedVx  = 0;
            obj._kinematicSustainedVy  = 0;
            obj._pendingKinematicDelta = { x: 0, y: 0 };
            obj._kinematicPrevX        = obj.x;
            obj._kinematicPrevY        = obj.y;
            _kinematicContacts.set(obj, new Set());
            const kBody = _makeBody(obj, obj.x, obj.y, 'kinematic');
            const kEntry = { obj, body: kBody || null, type: 'kinematic' };
            _bodies.push(kEntry);
            if (kBody) { _bodyByPlanckBody.set(kBody, kEntry); obj._physicsBody = kBody; }

            // Kinematic uses ONE shared collision shape — not per-frame.
            // The polygon is set in the Animation Panel (auto-fit from any frame).
            // Movement sweep uses its AABB. Shape never changes mid-animation.
            // To use the shared polygon we point _runtimePhysicsFrameId at 'shared'
            // if one exists, otherwise leave it at the first frame so collisionGeom
            // can find something to work with.
            const polyMap = obj.physicsPolygons || {};
            if (Array.isArray(polyMap.shared) && polyMap.shared.length >= 3) {
                obj._runtimePhysicsFrameId = 'shared';
            } else {
                const initAnim  = obj.animations?.[obj.activeAnimIndex ?? 0];
                const initFrame = initAnim?.frames?.[0];
                if (initFrame?.id) obj._runtimePhysicsFrameId = initFrame.id;
            }
            continue;
        }

        const body = _makeBody(obj, obj.x, obj.y, type);
        if (!body) continue;

        const entry = { obj, body, type };
        _bodies.push(entry);
        _bodyByPlanckBody.set(body, entry);
        obj._physicsBody = body;

        // Per-frame collision shape swap for dynamic bodies
        // Always reads from the CURRENT active animation so playAnimation() switches
        // also update the collision shape correctly.
        const as = obj._runtimeSprite;
        if (as && as.onFrameChange !== undefined) {
            const initAnim2  = obj.animations?.[obj.activeAnimIndex ?? 0];
            const initFrame2 = initAnim2?.frames?.[as.currentFrame ?? 0];
            if (initFrame2?.id) obj._runtimePhysicsFrameId = initFrame2.id;

            as.onFrameChange = (idx) => {
                const curAnim2   = obj.animations?.[obj.activeAnimIndex ?? 0];
                const f = curAnim2?.frames?.[idx];
                if (!f || obj._runtimePhysicsFrameId === f.id) return;
                obj._runtimePhysicsFrameId = f.id;
                _rebuildBodyForFrame(entry);
            };
        } else {
            const f0 = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0];
            if (f0?.id) obj._runtimePhysicsFrameId = f0.id;
        }
    }

    // Wire Planck.js collision events
    _world.on('begin-contact', (contact) => {
        const bodyA = contact.getFixtureA().getBody();
        const bodyB = contact.getFixtureB().getBody();
        _pendingCollisions.push({ p: { bodyA, bodyB }, type: 'start' });
    });
    _world.on('end-contact', (contact) => {
        const bodyA = contact.getFixtureA().getBody();
        const bodyB = contact.getFixtureB().getBody();
        _pendingCollisions.push({ p: { bodyA, bodyB }, type: 'end' });
    });

    _rafId = 1;
}

// ══════════════════════════════════════════════════════════════
// SAT (Separating Axis Theorem) kinematic sweep system
//
// Handles:
//   • Convex AND concave polygons (decomposed into convex triangles)
//   • Circle / capsule shape types (approximated as polygon)
//   • Box fallback for objects with no drawn polygon
//   • Correct hit-direction flags without fragile axis-angle thresholds
//   • Runtime scale changes (verts rebuilt from obj.scale each frame)
//
// A "compound shape" is an array of convex polygon vert-lists.
// Simple box/polygon objects have one entry; concave polygons have many.
// ══════════════════════════════════════════════════════════════

const SWEEP_SKIN = 1;   // px — gap kept between shapes after resolution
const PROBE_DIST = 4;   // px — ground-probe lookahead below the shape

// ── Surface-angle classification (mirrors Godot / Unity / Unreal) ──────────
// A contact whose push-normal Y component exceeds this dot-product threshold
// (in screen space where +Y = down) is a floor or ceiling; otherwise a wall.
//   FLOOR_DOT = cos(45°) ≈ 0.707  →  surfaces within 45° of horizontal = floor/ceiling
//   WALL_DOT  = sin(45°) ≈ 0.707  →  surfaces within 45° of vertical   = wall
// You can widen the floor angle by lowering FLOOR_DOT (e.g. 0.5 = 60° like Unity default).
const FLOOR_DOT = 0.707;

// ── Ear-clip triangulation (handles concave polygons) ─────────
// Returns an array of triangles [ [{x,y},{x,y},{x,y}], ... ]
function _triangulate(pts) {
    if (pts.length < 3) return [];
    if (pts.length === 3) return [pts.slice()];

    // Determine winding; flip to CCW if CW
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        area += (b.x - a.x) * (b.y + a.y);
    }
    const poly = area > 0 ? pts.slice().reverse() : pts.slice();

    const tris = [];
    const idx  = Array.from({ length: poly.length }, (_, i) => i);

    function isEar(i) {
        const n = idx.length;
        const a = poly[idx[(i - 1 + n) % n]];
        const b = poly[idx[i]];
        const c = poly[idx[(i + 1) % n]];
        // Must be convex (CCW turn)
        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) return false;
        // No other vertex inside the triangle
        for (let j = 0; j < n; j++) {
            if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
            const p = poly[idx[j]];
            if (_ptInTri(p, a, b, c)) return false;
        }
        return true;
    }

    let safety = idx.length * idx.length + 10;
    while (idx.length > 3 && safety-- > 0) {
        let clipped = false;
        for (let i = 0; i < idx.length; i++) {
            if (isEar(i)) {
                const n = idx.length;
                tris.push([
                    poly[idx[(i - 1 + n) % n]],
                    poly[idx[i]],
                    poly[idx[(i + 1) % n]],
                ]);
                idx.splice(i, 1);
                clipped = true;
                break;
            }
        }
        if (!clipped) break; // degenerate polygon — stop to avoid infinite loop
    }
    if (idx.length === 3) tris.push([poly[idx[0]], poly[idx[1]], poly[idx[2]]]);
    return tris;
}

function _ptInTri(p, a, b, c) {
    const d1 = (p.x-b.x)*(a.y-b.y) - (a.x-b.x)*(p.y-b.y);
    const d2 = (p.x-c.x)*(b.y-c.y) - (b.x-c.x)*(p.y-c.y);
    const d3 = (p.x-a.x)*(c.y-a.y) - (c.x-a.x)*(p.y-a.y);
    const hasNeg = (d1<0)||(d2<0)||(d3<0);
    const hasPos = (d1>0)||(d2>0)||(d3>0);
    return !(hasNeg && hasPos);
}

// ── Circle approximation polygon (n verts) ────────────────────
function _circleVerts(cx, cy, r, n = 16) {
    return Array.from({ length: n }, (_, i) => ({
        x: cx + Math.cos((i / n) * Math.PI * 2) * r,
        y: cy + Math.sin((i / n) * Math.PI * 2) * r,
    }));
}

// ── Build a world-space compound shape for an object ──────────
// Returns { parts: [ [{x,y},...], ... ], allVerts: [{x,y},...] }
// parts   — array of convex polygons (triangles for concave input)
// allVerts — flat list of all verts (for AABB / centroid maths)
//
// ROTATION: vertices are first built around a local origin, then
// rotated by obj.rotation so the collision shape always matches
// the visual sprite — like Unity/Godot/Unreal do automatically.
function _rotateVertsAround(verts, cx, cy, angle) {
    if (!angle) return verts; // fast path for unrotated objects
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return verts.map(v => {
        const dx = v.x - cx, dy = v.y - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
}

function _getKinematicShape(obj) {
    const sx    = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy    = Math.abs(obj.scale?.y ?? 1) || 1;
    const shape = obj.physicsShape ?? 'box';
    const rot   = obj.rotation || 0;   // obj rotation in radians

    // ── Circle ───────────────────────────────────────────────
    if (shape === 'circle') {
        const g  = collisionGeom(obj);
        const r  = g.r * Math.min(sx, sy);
        // Offset is in local space — rotate it by obj.rotation
        const ox = (g.ox || 0) * sx;
        const oy = (g.oy || 0) * sy;
        const cx = obj.x + (ox * Math.cos(rot) - oy * Math.sin(rot));
        const cy = obj.y + (ox * Math.sin(rot) + oy * Math.cos(rot));
        const verts = _circleVerts(cx, cy, r, 16);
        return { parts: [verts], allVerts: verts };
    }

    // ── Capsule ──────────────────────────────────────────────
    if (shape === 'capsule') {
        const g    = collisionGeom(obj);
        const capW = (obj.physicsSize?.capW ?? g.w) * sx;
        const capH = (obj.physicsSize?.capH ?? g.h) * sy;
        const capR = Math.min(capW, capH) / 2;
        const ox   = (g.ox || 0) * sx;
        const oy   = (g.oy || 0) * sy;
        const cx   = obj.x + (ox * Math.cos(rot) - oy * Math.sin(rot));
        const cy   = obj.y + (ox * Math.sin(rot) + oy * Math.cos(rot));
        const N    = 8; // verts per hemisphere
        let rawVerts = [];
        if (capW >= capH) {
            const len = capW / 2 - capR;
            for (let i = 0; i <= N; i++) { const a = Math.PI/2 + (i/N)*Math.PI; rawVerts.push({ x: cx - len + Math.cos(a)*capR, y: cy + Math.sin(a)*capR }); }
            for (let i = 0; i <= N; i++) { const a = -Math.PI/2 + (i/N)*Math.PI; rawVerts.push({ x: cx + len + Math.cos(a)*capR, y: cy + Math.sin(a)*capR }); }
        } else {
            const len = capH / 2 - capR;
            for (let i = 0; i <= N; i++) { const a = Math.PI + (i/N)*Math.PI; rawVerts.push({ x: cx + Math.cos(a)*capR, y: cy - len + Math.sin(a)*capR }); }
            for (let i = 0; i <= N; i++) { const a = (i/N)*Math.PI; rawVerts.push({ x: cx + Math.cos(a)*capR, y: cy + len + Math.sin(a)*capR }); }
        }
        const verts = _rotateVertsAround(rawVerts, cx, cy, rot);
        return { parts: [verts], allVerts: verts };
    }

    // ── Drawn polygon ────────────────────────────────────────
    const poly = _getActivePolygon(obj);
    if (Array.isArray(poly) && poly.length >= 3 &&
        (shape === 'polygon' || shape === 'shared')) {
        // Polygon verts are in object-local space (relative to sprite centre).
        // Apply obj.scale then obj.rotation then translate to world position.
        const worldVerts = poly.map(p => {
            const lx = p.x * sx;
            const ly = p.y * sy;
            return {
                x: obj.x + lx * Math.cos(rot) - ly * Math.sin(rot),
                y: obj.y + lx * Math.sin(rot) + ly * Math.cos(rot),
            };
        });
        const tris = _triangulate(worldVerts);
        const parts = tris.length > 0 ? tris : [worldVerts];
        return { parts, allVerts: worldVerts };
    }

    // ── Box fallback ─────────────────────────────────────────
    const g  = collisionGeom(obj);
    const w  = (g.w || 32) * sx;
    const h  = (g.h || 32) * sy;
    const ox = (g.ox || 0) * sx;
    const oy = (g.oy || 0) * sy;
    // Centre of the collision box in world space (offset rotated by obj.rotation)
    const bcx = obj.x + (ox * Math.cos(rot) - oy * Math.sin(rot));
    const bcy = obj.y + (ox * Math.sin(rot) + oy * Math.cos(rot));
    const rawVerts = [
        { x: bcx - w/2, y: bcy - h/2 }, { x: bcx + w/2, y: bcy - h/2 },
        { x: bcx + w/2, y: bcy + h/2 }, { x: bcx - w/2, y: bcy + h/2 },
    ];
    const verts = _rotateVertsAround(rawVerts, bcx, bcy, rot);
    return { parts: [verts], allVerts: verts };
}

// ── AABB of a compound shape (for broadphase and Planck sync) ─
function _getKinematicAABB(obj) {
    const { allVerts } = _getKinematicShape(obj);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of allVerts) {
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ── Centroid of allVerts ──────────────────────────────────────
function _shapeCentroid(allVerts) {
    let cx = 0, cy = 0;
    for (const v of allVerts) { cx += v.x; cy += v.y; }
    return { cx: cx / allVerts.length, cy: cy / allVerts.length };
}

// ── SAT helpers ───────────────────────────────────────────────

function _project(verts, nx, ny) {
    let min = Infinity, max = -Infinity;
    for (const v of verts) {
        const d = v.x * nx + v.y * ny;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return { min, max };
}

function _edgeNormals(verts) {
    const axes = [];
    for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const ex = b.x - a.x, ey = b.y - a.y;
        const len = Math.hypot(ex, ey);
        if (len < 0.0001) continue;
        axes.push({ x: -ey / len, y: ex / len });
    }
    return axes;
}

// SAT test between two CONVEX polygons.
// Returns null (no overlap) or MTV { nx, ny, depth } pushing vertsA out of vertsB.
function _satConvex(vertsA, vertsB) {
    const axes = [..._edgeNormals(vertsA), ..._edgeNormals(vertsB)];
    let minDepth = Infinity, minNx = 0, minNy = 0;

    for (const ax of axes) {
        const pA = _project(vertsA, ax.x, ax.y);
        const pB = _project(vertsB, ax.x, ax.y);
        const overlap = Math.min(pA.max, pB.max) - Math.max(pA.min, pB.min);
        if (overlap <= 0) return null;
        if (overlap < minDepth) { minDepth = overlap; minNx = ax.x; minNy = ax.y; }
    }

    // Ensure MTV pushes A away from B
    let cAx = 0, cAy = 0, cBx = 0, cBy = 0;
    for (const v of vertsA) { cAx += v.x; cAy += v.y; }
    for (const v of vertsB) { cBx += v.x; cBy += v.y; }
    cAx /= vertsA.length; cAy /= vertsA.length;
    cBx /= vertsB.length; cBy /= vertsB.length;
    if ((cAx - cBx) * minNx + (cAy - cBy) * minNy < 0) { minNx = -minNx; minNy = -minNy; }

    return { nx: minNx, ny: minNy, depth: minDepth };
}

// SAT test between a COMPOUND shape (array of convex parts) and a static (convex).
// Returns the deepest penetration MTV across all parts, or null if no overlap.
function _satCompound(parts, staticVerts) {
    let best = null;
    for (const part of parts) {
        const mtv = _satConvex(part, staticVerts);
        if (mtv && (!best || mtv.depth > best.depth)) best = mtv;
    }
    return best;
}

function _translateVerts(verts, dx, dy) {
    return verts.map(v => ({ x: v.x + dx, y: v.y + dy }));
}

function _translateShape(shape, dx, dy) {
    return {
        parts:    shape.parts.map(p => _translateVerts(p, dx, dy)),
        allVerts: _translateVerts(shape.allVerts, dx, dy),
    };
}

function _boxVerts(b) {
    return [
        { x: b.min.x, y: b.min.y }, { x: b.max.x, y: b.min.y },
        { x: b.max.x, y: b.max.y }, { x: b.min.x, y: b.max.y },
    ];
}

// ── SAT sweep (axis-separated X then Y) ──────────────────────
// shape    — compound shape { parts, allVerts }
// dx, dy   — desired displacement this substep
// statics  — array of { verts, ownerLabel }
// Returns { shape, dx (actual), dy (actual), hitX/Y/Down/Up/Left/Right, hitStatics, hitNormals }
//
// hitNormals — array of {nx,ny} contact normals (each already oriented to push
//   the swept body AWAY from the surface, in screen space +Y-down).
//   The kinematic section uses these for angle-based floor/ceiling/wall
//   classification identical to Godot's move_and_slide / Unity's CharacterController.
//
// Corner-sticking fix:
//   Old code used strict axis-dominance (|nx| > |ny|) which silently dropped
//   near-45° MTVs at tile corners, leaving the body embedded and causing the
//   next pass to push it in the wrong direction (false floor or ceiling hit).
//
//   Fix 1: Use a bias ratio (CORNER_BIAS) so an axis only wins if it is
//           meaningfully more dominant — near-diagonal MTVs fall through to a
//           post-pass depenetration step instead of being silently discarded.
//
//   Fix 2: After the two axis passes, run a "corner depenetration" pass that
//           resolves any remaining overlaps with a minimal-axis push (picks
//           whichever axis needs the smaller correction), clamped so it can
//           never push opposite to the surface gravity direction.  This is
//           what lets bodies slide cleanly off corners instead of sticking.
//
const CORNER_BIAS = 1.25; // an axis must be this much larger than the other to "win"

function _sweepSAT(shape, dx, dy, statics) {
    let hitX = false, hitY = false;
    let hitDown = false, hitUp = false, hitLeft = false, hitRight = false;
    const hitStatics = [];
    const hitNormals = []; // angle-based surface classification (Godot/Unity/Unreal style)

    // ── X pass ───────────────────────────────────────────────
    shape = _translateShape(shape, dx, 0);
    for (const s of statics) {
        const mtv = _satCompound(shape.parts, s.verts);
        if (!mtv) continue;
        // Only respond when X is clearly dominant (not near-corner)
        if (Math.abs(mtv.nx) <= Math.abs(mtv.ny) * CORNER_BIAS) continue;
        const push = Math.max(0, mtv.depth - SWEEP_SKIN);
        shape = _translateShape(shape, mtv.nx * push, 0);
        hitX  = true;
        if (mtv.nx > 0) hitLeft = true; else hitRight = true;
        if (!hitStatics.includes(s)) hitStatics.push(s);
        hitNormals.push({ nx: mtv.nx, ny: mtv.ny });
    }

    // ── Y pass ───────────────────────────────────────────────
    shape = _translateShape(shape, 0, dy);
    for (const s of statics) {
        const mtv = _satCompound(shape.parts, s.verts);
        if (!mtv) continue;
        // Only respond when Y is clearly dominant (not near-corner)
        if (Math.abs(mtv.ny) <= Math.abs(mtv.nx) * CORNER_BIAS) continue;
        const push = Math.max(0, mtv.depth - SWEEP_SKIN);
        shape = _translateShape(shape, 0, mtv.ny * push);
        hitY  = true;
        if (mtv.ny > 0) hitDown = true; else hitUp = true;
        if (!hitStatics.includes(s)) hitStatics.push(s);
        hitNormals.push({ nx: mtv.nx, ny: mtv.ny });
    }

    // ── Corner depenetration pass ─────────────────────────────
    // Resolves any leftover overlaps from near-diagonal MTVs that were skipped
    // above.  For each remaining overlap we pick the axis with the smaller
    // correction needed (minimal-push resolution) so the body slides off the
    // corner rather than sticking to it.  We deliberately do NOT set hitX/hitY
    // for these corrections — they are geometry clean-up, not real surface hits.
    for (const s of statics) {
        const mtv = _satCompound(shape.parts, s.verts);
        if (!mtv) continue;
        if (mtv.depth <= SWEEP_SKIN) continue; // already resolved or inside skin

        // Decompose overlap into the two axis corrections
        const xCorrect = Math.abs(mtv.nx) * (mtv.depth - SWEEP_SKIN);
        const yCorrect = Math.abs(mtv.ny) * (mtv.depth - SWEEP_SKIN);

        if (xCorrect <= yCorrect) {
            // X is cheaper — slide along X
            const push = Math.max(0, mtv.depth - SWEEP_SKIN);
            shape = _translateShape(shape, mtv.nx * push, 0);
            // Only flag a real X hit if the correction is non-trivial
            if (xCorrect > SWEEP_SKIN * 0.5) {
                hitX = true;
                if (mtv.nx > 0) hitLeft = true; else hitRight = true;
                if (!hitStatics.includes(s)) hitStatics.push(s);
                hitNormals.push({ nx: mtv.nx, ny: mtv.ny });
            }
        } else {
            // Y is cheaper — slide along Y
            const push = Math.max(0, mtv.depth - SWEEP_SKIN);
            // Guard: never push UP during a downward-or-horizontal move (prevents false ceiling
            // detection when grazing the top corner of a tile while falling or moving sideways).
            if (mtv.ny < 0 && dy >= 0) continue;  // would push up, but not moving up
            shape = _translateShape(shape, 0, mtv.ny * push);
            if (yCorrect > SWEEP_SKIN * 0.5) {
                hitY = true;
                if (mtv.ny > 0) hitDown = true; else hitUp = true;
                if (!hitStatics.includes(s)) hitStatics.push(s);
                hitNormals.push({ nx: mtv.nx, ny: mtv.ny });
            }
        }
    }

    return { shape, hitX, hitY, hitDown, hitUp, hitLeft, hitRight, hitStatics, hitNormals };
}

// ── Angle-aware surface probes ────────────────────────────────
// Each probe moves the shape a tiny distance in a direction and checks the
// contact normal of any overlap.  Only contacts whose normal falls within
// FLOOR_DOT of the expected gravity axis count as ground/ceiling; everything
// else is a wall — exactly how Godot / Unity / Unreal classify surfaces.
//
// Screen-space convention (+Y = down):
//   Ground:  contact pushes player UP   → mtv.ny < 0,  |mtv.ny| ≥ FLOOR_DOT
//   Ceiling: contact pushes player DOWN → mtv.ny > 0,  |mtv.ny| ≥ FLOOR_DOT
//   Wall:    contact pushes player sideways → |mtv.nx| ≥ FLOOR_DOT
// Returns 'ground' (flat, walkable, within FLOOR_DOT of horizontal),
// 'slope' (pushes upward but steeper than the walkable cone — a real
// object here would slide), or null (nothing below).
function _probeGroundType(shape, statics) {
    const probed = _translateShape(shape, 0, PROBE_DIST);
    let best = null; // steepest qualifying contact wins (most physically relevant)
    for (const s of statics) {
        const mtv = _satCompound(probed.parts, s.verts);
        if (!mtv) continue;
        if (mtv.ny < -FLOOR_DOT) return 'ground'; // flat floor — no need to keep looking
        // Upward-ish push but outside the walkable cone = slope. Same 0.1..FLOOR_DOT
        // band used by the sweep classifier, so idle and moving frames agree.
        if (mtv.ny < -0.1) best = 'slope';
    }
    return best;
}
function _probeGround(shape, statics) {
    return _probeGroundType(shape, statics) === 'ground';
}
function _probeCeiling(shape, statics) {
    const probed = _translateShape(shape, 0, -PROBE_DIST);
    for (const s of statics) {
        const mtv = _satCompound(probed.parts, s.verts);
        if (!mtv) continue;
        // Normal must push player mostly DOWN (ceiling-like angle ≤ 45° from horizontal)
        if (mtv.ny > FLOOR_DOT) return true;
    }
    return false;
}
function _probeWall(shape, statics) {
    const probedL = _translateShape(shape, -PROBE_DIST, 0);
    const probedR = _translateShape(shape,  PROBE_DIST, 0);
    for (const s of statics) {
        const mtvL = _satCompound(probedL.parts, s.verts);
        if (mtvL && Math.abs(mtvL.nx) >= FLOOR_DOT) return true;
        const mtvR = _satCompound(probedR.parts, s.verts);
        if (mtvR && Math.abs(mtvR.nx) >= FLOOR_DOT) return true;
    }
    return false;
}

// ── Build static grid for the SAT sweep ──────────────────────
// Each static entry carries { verts: [convex polygon], ownerLabel }.
// Static/kinematic sprites with drawn polygons expose their actual shape.
// Tile cells and dynamic bodies use box verts.
function _buildStaticGrid(excludeObj = null) {
    const statics = [];

    // 1. Tilemap / auto-tilemap cells (always static boxes)
    for (const t of _tileBodies) {
        const b = _getPlanckBodyBounds(t.body);
        statics.push({ verts: _boxVerts(b), ownerLabel: t.ownerLabel });
    }

    // 2. All non-sensor sprite bodies except the swept object
    for (const { obj: o, body, type } of _bodies) {
        if (o === excludeObj || !body || o.physicsIsSensor) continue;
        if (type === 'static' || type === 'kinematic') {
            // Use the full compound shape; push each convex part as a separate static entry
            // so the swept kinematic collides correctly against all parts of a concave static.
            const sh = _getKinematicShape(o);
            for (const part of sh.parts) {
                statics.push({ verts: part, ownerLabel: o.label });
            }
        } else if (type === 'dynamic') {
            const b = _getPlanckBodyBounds(body);
            statics.push({ verts: _boxVerts(b), ownerLabel: o.label });
        }
    }

    return statics;
}

// ── stepPhysics(dt) ───────────────────────────────────────────
export function stepPhysics(dt) {
    if (!_world) return;
    if (state.isPaused) return;

    const P = window.planck;

    // ── KINEMATIC BODIES ──────────────────────────────────────
    // Each kinematic object gets its own static grid (excludes itself so it
    // doesn't self-collide) that includes: tile cells, static sprite bodies,
    // other kinematic bodies, and non-sensor dynamic bodies.
    for (const { obj, body, type } of _bodies) {
        if (type !== 'kinematic') continue;

        // Immovable kinematic: just keep Planck body in sync and stay put
        if (obj.physicsImmovable) {
            obj._kinematicVx           = 0;
            obj._kinematicVy           = 0;
            obj._kinematicSustainedVx  = 0;
            obj._kinematicSustainedVy  = 0;
            obj._pendingKinematicDelta = { x: 0, y: 0 };
            obj._kinematicPrevX        = obj.x;
            obj._kinematicPrevY        = obj.y;
            obj._isOnGround  = false;
            obj._isOnCeiling = false;
            obj._isOnWall    = false;
            obj._isOnSlope   = false;
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }
            continue;
        }

        // 1. Consume desired velocity / pending delta from scripts
        // Sustained velocity (from throwObject/makeThrowable on a scriptless
        // object) adds in every frame until it decays or the object lands —
        // it is NOT cleared here. A script writing _kinematicVx this frame
        // (one-shot input) takes priority and also damps any sustained value
        // so the two systems don't fight (e.g. a script grabbing control of
        // an object mid-flight).
        let vx = obj._kinematicVx ?? 0;
        let vy = obj._kinematicVy ?? 0;
        const sustainedVx = obj._kinematicSustainedVx ?? 0;
        const sustainedVy = obj._kinematicSustainedVy ?? 0;
        if (sustainedVx !== 0 || sustainedVy !== 0) {
            vx += sustainedVx;
            vy += sustainedVy;
        }
        obj._kinematicVx = 0;
        obj._kinematicVy = 0;
        const pd = obj._pendingKinematicDelta || { x: 0, y: 0 };
        obj._pendingKinematicDelta = { x: 0, y: 0 };

        // directDx/Y: any teleport/position-write done directly by scripts this frame
        const prevX = obj._kinematicPrevX ?? obj.x;
        const prevY = obj._kinematicPrevY ?? obj.y;
        const directDx = obj.x - prevX;
        const directDy = obj.y - prevY;

        // Total desired displacement in px (screen space, +Y = down)
        const dx = vx * dt + pd.x + directDx;
        const dy = vy * dt + pd.y + directDy;

        // 2. Build static grid excluding this object
        const statics = _buildStaticGrid(obj);

        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
            // Not moving — probe contact directions.
            // isOnCeiling is intentionally NOT set here: the lookahead probe fires
            // even when the body is just near a ceiling (not touching), which causes
            // scripts that zero velocityY on isOnCeiling() to kill gravity and float.
            // Ceiling contact is only meaningful when the body actually swept into one.
            const idleShape = _getKinematicShape(obj);
            const idleGroundType = _probeGroundType(idleShape, statics);
            obj._isOnGround  = idleGroundType === 'ground';
            obj._isOnCeiling = false;
            obj._isOnWall    = idleGroundType ? false : _probeWall(idleShape, statics);
            obj._isOnSlope   = idleGroundType === 'slope';
            obj._kinematicActualVx = 0;
            obj._kinematicActualVy = 0;
            obj._kinematicPrevX = obj.x;
            obj._kinematicPrevY = obj.y;
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }
            // Still fire onCollisionStay / onCollisionExit for objects we were
            // already touching — a stationary body can remain in contact indefinitely.
            const prevContacts = _kinematicContacts.get(obj);
            if (prevContacts && prevContacts.size > 0) {
                import('./engine.scripting.js').then(m => {
                    for (const label of prevContacts) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollisionStay?.(obj, other);
                    }
                });
            }
            continue;
        }

        // 3. Reset to last confirmed-safe position before sweeping
        obj.x = prevX;
        obj.y = prevY;

        // 4–7. Substep sweep — prevents tunnelling through fast-moving objects
        const KIN_SUBSTEPS = 3;
        const subDx = dx / KIN_SUBSTEPS;
        const subDy = dy / KIN_SUBSTEPS;
        const subDt = dt / KIN_SUBSTEPS;

        let hitX = false, hitY = false;
        let hitDown = false, hitUp = false, hitLeft = false, hitRight = false;
        const hitStatics = [];
        const allHitNormals = []; // collect across all substeps for angle-based classification

        // Build the static grid once for all substeps — statics don't move mid-frame.
        const subStatics = _buildStaticGrid(obj);

        for (let _ks = 0; _ks < KIN_SUBSTEPS; _ks++) {

            // Build shape from current obj.x/y (updated each substep)
            const curShape = _getKinematicShape(obj);
            // Snapshot centroid BEFORE sweep so we can compute the delta
            const { cx: preCx, cy: preCy } = _shapeCentroid(curShape.allVerts);

            const res = _sweepSAT(curShape, subDx, subDy, subStatics);

            if (res.hitX) { hitX = true; hitLeft  = hitLeft  || res.hitLeft;  hitRight = hitRight || res.hitRight; }
            if (res.hitY) { hitY = true; hitDown  = hitDown  || res.hitDown;  hitUp    = hitUp    || res.hitUp; }
            for (const s of res.hitStatics) if (!hitStatics.includes(s)) hitStatics.push(s);
            for (const n of res.hitNormals) allHitNormals.push(n);

            // Derive obj.x/y from how much the shape centroid moved after resolution
            const { cx: postCx, cy: postCy } = _shapeCentroid(res.shape.allVerts);
            obj.x += postCx - preCx;
            obj.y += postCy - preCy;

            // Teleport Planck body so dynamics get pushed out this substep
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }

            // Mini world step — ejects dynamic bodies from the kinematic
            _world.step(subDt, 8, 3);

            // Apply kinematic velocity to overlapping dynamic bodies (AABB broadphase)
            if (Math.abs(subDx) > 0.001 || Math.abs(subDy) > 0.001) {
                const kinAabb = _getKinematicAABB(obj);
                const kvx = subDx / Math.max(subDt, 0.001);
                const kvy = subDy / Math.max(subDt, 0.001);
                for (const { body: dynBody, type: dynType, obj: dynObj } of _bodies) {
                    if (dynType !== 'dynamic' || !dynBody || dynObj.physicsIsSensor) continue;
                    const db = _getPlanckBodyBounds(dynBody);
                    if (db.max.x < kinAabb.x || db.min.x > kinAabb.x + kinAabb.w) continue;
                    if (db.max.y < kinAabb.y || db.min.y > kinAabb.y + kinAabb.h) continue;
                    const cur = dynBody.getLinearVelocity();
                    dynBody.setLinearVelocity(P.Vec2(kvx !== 0 ? kvx : cur.x, kvy !== 0 ? kvy : cur.y));
                    dynBody.setAwake(true);
                }
            }

            // Note: do NOT break on hitX && hitY — corner resolution needs all substeps
            // to fully clear the shape from diagonal contacts before stopping.
        }

        obj._kinematicPrevX = obj.x;
        obj._kinematicPrevY = obj.y;

        // 6. Ground / wall / ceiling flags — angle-based (Godot / Unity / Unreal style)
        // ─────────────────────────────────────────────────────────────────────────────
        // Classify each contact normal collected during the sweep substeps:
        //   • Normal pushes player UP   (ny < -FLOOR_DOT) → floor  → isOnGround
        //   • Normal pushes player DOWN (ny >  FLOOR_DOT) → ceiling → isOnCeiling
        //   • Otherwise                                   → wall   → isOnWall
        // This means a steep wall or angled surface will NEVER set isOnGround just
        // because the player touched it — only surfaces within 45° of horizontal do.
        // The idle ground-probe runs after (angle-aware too) so standing still on a
        // slope still registers correctly.
        let sweepOnGround = false, sweepOnCeiling = false, sweepOnWall = false, sweepOnSlope = false;
        for (const n of allHitNormals) {
            if      (n.ny < -FLOOR_DOT)              sweepOnGround  = true;
            else if (n.ny >  FLOOR_DOT)              sweepOnCeiling = true;
            else if (Math.abs(n.nx) >= FLOOR_DOT)    sweepOnWall    = true;
            // Slope: normal pushes upward but not enough to be a flat floor —
            // mirrors Godot's is_on_floor() / is_on_wall() gap.
            // |ny| between 0.1 and FLOOR_DOT means a diagonal surface (slope).
            else if (n.ny < -0.1)                    sweepOnSlope   = true;
        }
        const finalShape = _getKinematicShape(obj);
        const finalGroundType = _probeGroundType(finalShape, subStatics);
        obj._isOnGround  = sweepOnGround  || finalGroundType === 'ground';
        obj._isOnCeiling = sweepOnCeiling;
        obj._isOnWall    = sweepOnWall    || (!sweepOnGround && !sweepOnCeiling && (hitLeft || hitRight));
        obj._isOnSlope   = (sweepOnSlope || finalGroundType === 'slope') && !obj._isOnGround;

        // ── Sustained velocity decay (thrown scriptless objects) ────────────
        // Kinematic bodies have NO gravity by engine design (script-controlled
        // only — see physicsBody docs). So a thrown scriptless kinematic object
        // keeps its horizontal AND vertical velocity in a straight line until it
        // hits something, then ground friction brings it to rest — exactly like
        // sliding an object across a table. If you want it to arc and fall,
        // attach a script and apply your own gravity via velocityY, same as any
        // other kinematic body in this engine.
        if (sustainedVx !== 0 || sustainedVy !== 0) {
            let nsvx = sustainedVx, nsvy = sustainedVy;
            if (obj._isOnGround) {
                // Landed — ground friction brings it to a stop (default friction 0.3 → ~0.5s)
                const fric  = obj.physicsFriction ?? 0.3;
                const decay = Math.max(0, 1 - fric * 6 * dt);
                nsvx *= decay;
                nsvy *= decay;
                if (Math.abs(nsvx) < 2) nsvx = 0; // snap to rest below 0.02 world-units/sec
                if (Math.abs(nsvy) < 2) nsvy = 0;
            }
            if (sweepOnWall)                nsvx = 0; // wall stopped horizontal motion
            if (sweepOnCeiling && nsvy < 0) nsvy = 0; // ceiling stopped upward motion
            obj._kinematicSustainedVx = nsvx;
            obj._kinematicSustainedVy = nsvy;
        }

        // Track actual velocity (px/s) so physics.velX/velY work for kinematic too
        obj._kinematicActualVx =  (obj.x - prevX) / Math.max(dt, 0.001);
        obj._kinematicActualVy =  (obj.y - prevY) / Math.max(dt, 0.001);

        // 8. Collision events for kinematic ↔ solid surfaces
        if (hitX || hitY) {
            const contacts    = _kinematicContacts.get(obj) || new Set();
            const nowTouching = new Set(hitStatics.map(s => s.ownerLabel).filter(Boolean));
            import('./engine.scripting.js').then(m => {
                for (const label of nowTouching) {
                    if (!contacts.has(label)) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollision(obj, other);
                    }
                }
                for (const label of contacts) {
                    if (!nowTouching.has(label)) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollisionEnd(obj, other);
                    }
                }
                _kinematicContacts.set(obj, nowTouching);
            });
        } else {
            const contacts = _kinematicContacts.get(obj);
            if (contacts && contacts.size > 0) {
                import('./engine.scripting.js').then(m => {
                    for (const label of contacts) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollisionEnd(obj, other);
                    }
                    _kinematicContacts.set(obj, new Set());
                });
            }
        }
    }

    // ── DYNAMIC: apply per-body gravity via applyForce ────────
    // Planck v1.0.0 has no setGravityScale — we apply gravity
    // manually each frame. This is correct: F = m*g*scale.
    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        if (body.isStatic()) continue;
        const gravScale  = obj.physicsGravityScale  ?? 1;
        const gravXScale = obj.physicsGravityXScale ?? 0;
        if (gravScale !== 0 || gravXScale !== 0) {
            const gy = GRAVITY_PX * 0.001 * gravScale;
            const gx = GRAVITY_PX * 0.001 * gravXScale;
            body.applyForce(
                P.Vec2(gx * body.getMass(), gy * body.getMass()),
                body.getWorldCenter(),
                true
            );
        }
    }

    // ── VELOCITY CAP: prevent teleportation from extreme speed spikes ─────────
    // If a body is moving faster than MAX_SPEED_PX_S it would travel further than
    // a typical object's width in a single frame, guaranteeing a tunnel.  Cap the
    // velocity here — the body still moves fast, it just can't skip over walls.
    const MAX_SPEED_PX_S = 4000; // 40 world-units/sec — generous but finite
    for (const { body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        const vel   = body.getLinearVelocity();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
        if (speed > MAX_SPEED_PX_S) {
            const scale = MAX_SPEED_PX_S / speed;
            body.setLinearVelocity(P.Vec2(vel.x * scale, vel.y * scale));
        }
    }

    // Enable bullet (CCD) mode for fast-moving dynamic bodies to prevent tunneling.
    // A body moving faster than ~4 world-units/frame risks skipping through thin objects;
    // bullet mode forces continuous collision detection on those bodies only.
    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        const vel   = body.getLinearVelocity();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
        // Enable CCD above ~500 px/s (5 world-units/s).  Disable when slow again to
        // avoid the small CPU cost on every static body.
        body.setBullet(speed > 500);
    }

    // Run Planck in substeps to prevent tunnelling.
    // 6 substeps (up from 3) gives much better collision fidelity at high speeds.
    const SUBSTEPS = 6;
    const subDt    = dt / SUBSTEPS;
    for (let _s = 0; _s < SUBSTEPS; _s++) {
        _world.step(subDt, 8, 4);
    }

    // ── POST-STEP: realistic energy bleed + ground detection ────
    // 1. GROUND FLAG  — detect when a dynamic body is resting on a surface
    //    so scripts can read isOnGround and zero their velocityY correctly.
    // 2. BOUNCE KILL  — zero any post-bounce velocity below threshold so
    //    objects settle cleanly instead of micro-bouncing forever.
    // 3. SLEEP        — explicitly zero and sleep bodies that are basically still.
    //
    // Thresholds are in px/s (engine space, 1 world-unit = 100 px).
    const BOUNCE_KILL_Y  = 80;   // vy below this after upward bounce → clamp to 0
    const BOUNCE_KILL_X  = 30;   // vx below this → clamp to 0
    const SLEEP_SPEED    = 8;    // total speed below this → full sleep
    const SLEEP_OMEGA    = 0.05; // angular speed below this → zero rotation

    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body || body.isStatic()) continue;

        const vel   = body.getLinearVelocity();
        const omega = body.getAngularVelocity();
        const speed = Math.hypot(vel.x, vel.y);

        // ── Ground / ceiling / wall detection — angle-based (Godot / Unity / Unreal) ──
        // Walk Planck's contact list and classify each contact normal by angle.
        // push.y > FLOOR_DOT  → surface pushes us UP enough   → floor  → isOnGround
        // push.y < -FLOOR_DOT → surface pushes us DOWN enough → ceiling → isOnCeiling
        // |push.x| dominates (wall-like angle)               → wall   → isOnWall
        // Only surfaces within 45° of horizontal register as floor or ceiling;
        // steep walls and angled surfaces at >45° from horizontal are walls.
        let onGround = false, onCeiling = false, onWall = false, onSlope = false;
        for (let ce = body.getContactList(); ce; ce = ce.next) {
            const contact = ce.contact;
            if (!contact || !contact.isTouching()) continue;
            const manifold = contact.getWorldManifold();
            if (!manifold || !manifold.normal) continue;
            // Planck v1 normal points FROM bodyA OUTWARD (away from A, toward B).
            // Flip so push vector always points FROM the surface TOWARD us.
            // Planck uses +Y = up (math convention), so py > 0 = push upward = floor.
            const isBodyA = contact.getFixtureA().getBody() === body;
            const px = isBodyA ? -manifold.normal.x : manifold.normal.x;
            const py = isBodyA ? -manifold.normal.y : manifold.normal.y;
            if      (py >=  FLOOR_DOT)           onGround  = true;
            else if (py <= -FLOOR_DOT)           onCeiling = true;
            else if (Math.abs(px) >= FLOOR_DOT)  onWall    = true;
            // Slope: surface pushes upward but not enough to count as flat floor —
            // a real object resting here (outside the friction cone) would slide down.
            // Same 0.1..FLOOR_DOT band as the kinematic sweep classifier above.
            else if (py > 0.1)                   onSlope   = true;
        }
        obj._isOnGround  = onGround;
        obj._isOnCeiling = onCeiling;
        obj._isOnWall    = onWall;
        obj._isOnSlope   = onSlope && !onGround;

        // ── Full sleep ───────────────────────────────────────────
        // Skip sleep entirely on a slope: gravity has a real component along
        // the surface there, so a momentarily-slow tire/box should keep being
        // accelerated by the simulation instead of getting frozen mid-incline.
        if (!onSlope && speed < SLEEP_SPEED && Math.abs(omega) < SLEEP_OMEGA) {
            body.setLinearVelocity(P.Vec2(0, 0));
            body.setAngularVelocity(0);
            body.setAwake(false);
            continue;
        }

        let vx = vel.x, vy = vel.y;

        // ── Bounce-kill on Y ─────────────────────────────────────
        // After hitting a floor the body bounces up (vy < 0 in Planck +Y-down).
        // If the upward speed is below threshold, kill it — no more micro-bounces.
        if (vy < 0 && Math.abs(vy) < BOUNCE_KILL_Y) vy = 0;
        // After a ceiling hit the body bounces down — same kill logic.
        if (vy > 0 && onGround && Math.abs(vy) < BOUNCE_KILL_Y) vy = 0;

        // ── Bounce-kill on X ─────────────────────────────────────
        // Only kills lingering bounce jitter on flat ground/walls. On a slope,
        // slow horizontal speed is often the start of a real roll/slide under
        // gravity — zeroing it here would stop a tire before it can build speed.
        if (!onSlope && Math.abs(vx) < BOUNCE_KILL_X) vx = 0;

        // ── Angular rest ─────────────────────────────────────────
        const newOmega = Math.abs(omega) < SLEEP_OMEGA ? 0 : omega;

        if (vx !== vel.x || vy !== vel.y || newOmega !== omega) {
            body.setLinearVelocity(P.Vec2(vx, vy));
            body.setAngularVelocity(newOmega);
        }
    }

    // ── POST-STEP: sync dynamic body position → sprite ────────
    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        const pos  = body.getPosition();
        const ang  = body.getAngle();
        const off  = body._zenOffset || { x: 0, y: 0 };
        const cosR = Math.cos(ang);
        const sinR = Math.sin(ang);
        obj.x = pos.x - (off.x * cosR - off.y * sinR);
        obj.y = pos.y - (off.x * sinR + off.y * cosR);
        obj.rotation = ang;
    }

    _fireCollisionEvents();
}

// ── stopPhysics ───────────────────────────────────────────────
export function stopPhysics() {
    _rafId = null;
    for (const { obj } of _bodies) {
        const as = obj?._runtimeSprite;
        if (as && as.onFrameChange) as.onFrameChange = null;
        if (obj) {
            delete obj._runtimePhysicsFrameId;
            delete obj._physicsBody;
            delete obj._kinematicVx;
            delete obj._kinematicVy;
            delete obj._kinematicSustainedVx;
            delete obj._kinematicSustainedVy;
            delete obj._kinematicActualVx;
            delete obj._kinematicActualVy;
            delete obj._kinematicPrevX;
            delete obj._kinematicPrevY;
            delete obj._pendingKinematicDelta;
            delete obj._isOnGround;
            delete obj._isOnCeiling;
            delete obj._isOnWall;
            delete obj._isOnSlope;
        }
    }
    _world  = null;
    _bodies = [];
    _tileBodies.length = 0;
    _bodyByPlanckBody.clear();
    _tileByPlanckBody.clear();
    _kinematicContacts.clear();
    _pendingCollisions.length = 0;
}

// ── Ground / wall / ceiling queries ──────────────────────────
/** Returns true if the kinematic body is currently resting on a floor. */
export function getIsOnGround(obj)   { return !!obj._isOnGround; }
/** Returns true if the kinematic body bumped a ceiling this frame. */
export function getIsOnCeiling(obj)  { return !!obj._isOnCeiling; }
/** Returns true if the kinematic body is pressed against a wall. */
export function getIsOnWall(obj)     { return !!obj._isOnWall; }
/** Returns true if the kinematic body is touching a slope (diagonal surface). */
export function getIsOnSlope(obj)    { return !!obj._isOnSlope; }

// ── rebuildBodyForObject ──────────────────────────────────────
/**
 * Remove and destroy the Planck physics body for a game object that has been
 * destroyed at runtime. Called by engine.scripting._destroyObject so the
 * collision shape disappears the same frame the sprite does.
 */
export function removePhysicsBody(obj) {
    if (!_world || !obj) return;
    const idx = _bodies.findIndex(e => e.obj === obj);
    if (idx === -1) return;
    const { body } = _bodies[idx];
    if (body) {
        _bodyByPlanckBody.delete(body);
        try { _world.destroyBody(body); } catch (_) {}
    }
    delete obj._physicsBody;
    delete obj._kinematicVx;
    delete obj._kinematicVy;
    delete obj._kinematicSustainedVx;
    delete obj._kinematicSustainedVy;
    delete obj._kinematicActualVx;
    delete obj._kinematicActualVy;
    delete obj._kinematicPrevX;
    delete obj._kinematicPrevY;
    delete obj._pendingKinematicDelta;
    delete obj._isOnGround;
    delete obj._isOnCeiling;
    delete obj._isOnWall;
    delete obj._isOnSlope;
    _bodies.splice(idx, 1);
    _kinematicContacts.delete(obj);
}

export function rebuildBodyForObject(obj) {
    if (!_world) return;
    const idx = _bodies.findIndex(e => e.obj === obj);
    if (idx !== -1) {
        const { body } = _bodies[idx];
        if (body) {
            _bodyByPlanckBody.delete(body);
            try { _world.destroyBody(body); } catch (_) {}
        }
        delete obj._physicsBody;
        _bodies.splice(idx, 1);
    }
    _kinematicContacts.delete(obj);

    const type = obj.physicsBody;
    if (!type || type === 'none') {
        // Switching to none — clean up all physics runtime state
        delete obj._kinematicVx;
        delete obj._kinematicVy;
        delete obj._kinematicSustainedVx;
        delete obj._kinematicSustainedVy;
        delete obj._kinematicActualVx;
        delete obj._kinematicActualVy;
        delete obj._kinematicPrevX;
        delete obj._kinematicPrevY;
        delete obj._pendingKinematicDelta;
        delete obj._isOnGround;
        delete obj._isOnCeiling;
        delete obj._isOnWall;
        delete obj._isOnSlope;
        return;
    }

    // Resolve the active polygon frame ID for both kinematic and dynamic
    // (needed so _makeBody/_getActivePolygon finds the right polygon)
    const polyMap2 = obj.physicsPolygons || {};
    if (Array.isArray(polyMap2.shared) && polyMap2.shared.length >= 3) {
        obj._runtimePhysicsFrameId = 'shared';
    } else {
        const ra = obj.animations?.[obj.activeAnimIndex ?? 0];
        const rf = ra?.frames?.[0];
        if (rf?.id) obj._runtimePhysicsFrameId = rf.id;
    }

    if (type === 'kinematic') {
        obj._kinematicVx           = 0;
        obj._kinematicVy           = 0;
        obj._pendingKinematicDelta = { x: 0, y: 0 };
        obj._kinematicPrevX        = obj.x;
        obj._kinematicPrevY        = obj.y;
        _kinematicContacts.set(obj, new Set());

        const kBody = _makeBody(obj, obj.x, obj.y, 'kinematic');
        if (kBody) {
            const kEnt = { obj, body: kBody, type: 'kinematic' };
            _bodies.push(kEnt);
            _bodyByPlanckBody.set(kBody, kEnt);
            obj._physicsBody = kBody;
        } else {
            _bodies.push({ obj, body: null, type: 'kinematic' });
        }
        return;
    }

    // dynamic or static — clean up any leftover kinematic state
    delete obj._kinematicVx;
    delete obj._kinematicVy;
    delete obj._kinematicSustainedVx;
    delete obj._kinematicSustainedVy;
    delete obj._kinematicActualVx;
    delete obj._kinematicActualVy;
    delete obj._kinematicPrevX;
    delete obj._kinematicPrevY;
    delete obj._pendingKinematicDelta;

    const body = _makeBody(obj, obj.x, obj.y, type);
    if (!body) return;
    const newEnt = { obj, body, type };
    _bodies.push(newEnt);
    _bodyByPlanckBody.set(body, newEnt);
    obj._physicsBody = body;
}

// ── Rebuild body when animation frame changes ─────────────────
function _rebuildBodyForFrame(entry) {
    if (!_world) return;
    const { obj, body: oldBody, type } = entry;
    if (!oldBody || type === 'kinematic') return;

    // Only rebuild the body if this specific frame has a dedicated polygon shape.
    // For box / circle / capsule shapes — or polygon shapes without per-frame
    // polygon data — the collision dimensions must stay constant when the
    // animation frame changes (even if sprite resolution differs).
    // This prevents the collision shape from glitching when switching
    // animations that have different source image resolutions.
    const shape = obj.physicsShape ?? 'box';
    const frameId = obj._runtimePhysicsFrameId;
    const pfPoly = frameId && obj.physicsPolygons
        ? obj.physicsPolygons[frameId]
        : null;
    const hasPFPolygon = Array.isArray(pfPoly) && pfPoly.length >= 3;

    if (!hasPFPolygon && shape !== 'polygon' && shape !== 'shared') {
        // No per-frame polygon defined for this frame — keep existing body as-is.
        return;
    }

    const pos    = oldBody.getPosition();
    const vel    = oldBody.getLinearVelocity();
    const angle  = oldBody.getAngle();
    const angVel = oldBody.getAngularVelocity();

    const newBody = _makeBody(obj, pos.x, pos.y, type);
    if (!newBody) return;
    newBody.setTransform(pos, angle);
    if (type !== 'static') {
        newBody.setLinearVelocity(vel);
        newBody.setAngularVelocity(angVel);
    }

    _bodyByPlanckBody.delete(oldBody);
    _world.destroyBody(oldBody);
    entry.body       = newBody;
    obj._physicsBody = newBody;
    _bodyByPlanckBody.set(newBody, entry);
}


// ── Re-export inspector functions so existing import paths work ───
export {
    buildPhysicsInspectorHTML,
    autoFitCollisionShape,
    bindPhysicsInspector,
    openPolygonEditor,
    snapshotPhysics,
    restorePhysics,
} from './engine.physics.inspector.js';
