/* ============================================================
   Zengine — engine.physics.inspector.js
   Physics inspector panel UI, polygon editor, auto-fit,
   snapshot/restore, and style helpers.
   Split from engine.physics.js for maintainability.
   ============================================================ */

import { state } from './engine.state.js';
import { collisionGeom, rawSpriteSize } from './engine.collision-overlay.js';
import {
    rebuildBodyForObject,
    migratePolygonsToContainer,
} from './engine.physics.js';

// ── Inspector HTML ────────────────────────────────────────────

export function buildPhysicsInspectorHTML(obj) {
    if (obj.isTilemap || obj.isAutoTilemap) {
        return `<div class="component-block" id="inspector-physics-section">
          <div class="component-header">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>
            </svg>
            <span style="font-weight:600;color:#facc15;">Physics</span>
          </div>
          <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
            <div class="prop-row">
              <span class="prop-label">Body</span>
              <span style="color:#60a5fa;font-size:11px;font-weight:600;">🔵 Static (locked)</span>
            </div>
            <div style="background:#1a1a10;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;">
              Tilemaps are always static colliders — one box per filled tile.
            </div>
          </div>
        </div>`;
    }

    const type   = obj.physicsBody      ?? 'none';
    const fric   = obj.physicsFriction        ?? 0.3;
    const rest   = obj.physicsRestitution     ?? 0.1;
    const dens   = obj.physicsDensity         ?? 0.001;
    const grav   = obj.physicsGravityScale    ?? 1;
    const ldamp  = obj.physicsLinearDamping   ?? 0.08;
    const adamp  = obj.physicsAngularDamping  ?? 0.05;
    const fixRot  = !!obj.physicsFixedRotation;
    const sensor  = !!obj.physicsIsSensor;
    const immov   = !!obj.physicsImmovable;
    const shape  = obj.physicsShape           ?? 'box';

    const isDynamic   = type === 'dynamic';
    const isKinematic = type === 'kinematic';
    const isStatic    = type === 'static';
    const hasPhysics  = type !== 'none';

    const OPT  = (v, l) => `<option value="${v}" ${type  === v ? 'selected' : ''}>${l}</option>`;
    const SOPT = (v, l) => `<option value="${v}" ${shape === v ? 'selected' : ''}>${l}</option>`;

    const geom   = collisionGeom(obj);
    const psW    = +geom.w.toFixed(1);
    const psH    = +geom.h.toFixed(1);
    const psR    = +geom.r.toFixed(1);
    const psCapW = +(obj.physicsSize?.capW ?? geom.w).toFixed(1);
    const psCapH = +(obj.physicsSize?.capH ?? geom.h).toFixed(1);
    const hasOverride = !!(obj.physicsSize && (obj.physicsSize.w || obj.physicsSize.h || obj.physicsSize.r));

    const typeDescs = {
        none:      '',
        static:    '🔵 Completely immovable. Infinite mass — not affected by gravity, forces, or collisions. Use for floors, walls, and buildings. Dynamic bodies bounce/stop against it; kinematic bodies pass through or collide.',
        kinematic: '🟡 Script-controlled movement. Not affected by gravity or forces. Pushes dynamic bodies; not pushed back. Use for moving platforms, doors, and scripted NPCs. Set velocity via velocityX/Y or move().',
        dynamic:   '🔴 Fully physics-driven. Affected by gravity, forces, and impulses. Reacts realistically to everything. Use for boxes, balls, and falling objects.',
    };

    const anims   = obj.animations || [];
    const frames  = anims.flatMap(a => (a.frames || []).map(f => ({ id: f.id, name: f.name || f.id })));
    const polyMap = obj.physicsPolygons || {};
    const frameTabsHTML = frames.length > 0
        ? `<div style="margin-top:4px;">
            <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Per-frame shapes</div>
            <div style="display:flex;flex-wrap:wrap;gap:3px;">
              <button class="pe-frame-btn" data-frame="shared"
                style="${_frameBtn(!frames.some(f => (polyMap[f.id]?.length >= 3)), 'shared')}">
                All frames
              </button>
              ${frames.map(f => `
              <button class="pe-frame-btn" data-frame="${f.id}"
                style="${_frameBtn(!!(polyMap[f.id]?.length >= 3), f.id)}">
                ${f.name}
              </button>`).join('')}
            </div>
          </div>`
        : '';

    const sharedSummary = _polySummary(polyMap.shared);

    const sizeEditorsHTML = `
        <div id="phys-box-row" style="display:${shape==='box'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Box size (px)</div>
          <div class="prop-row">
            <span class="prop-label">Width</span>
            <input id="phys-box-w" type="number" min="1" step="1" value="${psW}" style="width:80px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Height</span>
            <input id="phys-box-h" type="number" min="1" step="1" value="${psH}" style="width:80px;${_inp()}">
          </div>
          <button id="phys-size-reset-box" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-circle-row" style="display:${shape==='circle'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Radius (px)</div>
          <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input id="phys-circle-r" type="number" min="1" step="1" value="${psR}" style="width:80px;${_inp()}">
          </div>
          <button id="phys-size-reset-circle" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-capsule-row" style="display:${shape==='capsule'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Capsule size (px)</div>
          <div class="prop-row">
            <span class="prop-label">Width</span>
            <input id="phys-cap-w" type="number" min="1" step="1" value="${psCapW}" style="width:80px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Height</span>
            <input id="phys-cap-h" type="number" min="1" step="1" value="${psCapH}" style="width:80px;${_inp()}">
          </div>
          <div style="color:#555;font-size:9px;">Pill shape — round ends on the short axis</div>
          <button id="phys-size-reset-capsule" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-polygon-row" style="display:${shape==='polygon'?'flex':'none'};flex-direction:column;gap:4px;">
          <button id="phys-edit-polygon" style="${_btn('#7c3aed')}width:100%;">✏ Edit Collision Shape</button>
          <button id="phys-autofit" style="${_btn('#06b6d4')}width:100%;margin-top:2px;">🎯 Auto-fit from Sprite</button>
          <div style="color:#666;font-size:9px;text-align:center;">${sharedSummary}</div>
          ${frameTabsHTML}
        </div>
    `;

    const materialHTML = `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Material</div>
        <div class="prop-row">
          <span class="prop-label">Friction</span>
          <input id="phys-friction" type="number" value="${fric}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=ice, 1=sticky</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Bounce</span>
          <input id="phys-bounce" type="number" value="${rest}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=none, 1=full</span>
        </div>
    `;

    const massHTML = isDynamic ? `
        <div class="prop-row">
          <span class="prop-label">Density</span>
          <input id="phys-density" type="number" value="${dens}" min="0.0001" max="100" step="0.0005" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">affects mass</span>
        </div>
    ` : '';

    const dampingHTML = isDynamic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Damping</div>
        <div class="prop-row">
          <span class="prop-label">Linear</span>
          <input id="phys-linear-damp" type="number" value="${ldamp}" min="0" max="100" step="0.01" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">air drag (0.01 default)</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Angular</span>
          <input id="phys-angular-damp" type="number" value="${adamp}" min="0" max="100" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">spin drag</span>
        </div>
    ` : '';

    const gravityHTML = isDynamic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Gravity</div>
        <div class="prop-row">
          <span class="prop-label">Scale Y</span>
          <input id="phys-gravity-scale" type="number" value="${grav}" min="0" max="20" step="0.1" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=float, 1=normal</span>
        </div>
        <div style="background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:4px 8px;font-size:9px;color:#4a4a6a;">
          Or in script: <code style="color:#7cb9f0;">velocityY -= 9.8 * dt</code>
        </div>
    ` : '';

    const constraintsHTML = (isDynamic || isKinematic) ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Constraints</div>
        <div class="prop-row">
          <span class="prop-label" title="Lock this body in place — nothing can move it">Immovable</span>
          <input id="phys-immovable" type="checkbox" ${immov ? 'checked' : ''} style="width:14px;height:14px;accent-color:#ef4444;cursor:pointer;">
          <span style="color:#555;font-size:9px;">locks position</span>
        </div>
        ${isDynamic ? `
        <div class="prop-row">
          <span class="prop-label" title="Prevent this body from rotating">Fix rotation</span>
          <input id="phys-fixed-rot" type="checkbox" ${fixRot ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">no spin</span>
        </div>` : ''}
        <div class="prop-row">
          <span class="prop-label" title="Detects overlaps but causes no physics response">Is Sensor</span>
          <input id="phys-sensor" type="checkbox" ${sensor ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">detect only</span>
        </div>
    ` : (isStatic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Constraints</div>
        <div class="prop-row">
          <span class="prop-label">Is Sensor</span>
          <input id="phys-sensor" type="checkbox" ${sensor ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">detect only</span>
        </div>
    ` : '');

    const kinematicNote = isKinematic ? `
        <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:5px 8px;font-size:9px;color:#facc1588;margin-top:2px;line-height:1.6;">
            🟡 <strong style="color:#facc15;">Kinematic body rules:</strong><br>
            • Move via <code style="color:#facc15;">velocityX/Y</code> or <code style="color:#facc15;">move()</code><br>
            • No gravity — fake it with <code style="color:#facc15;">velocityY += gravity * dt</code><br>
            • Pushes dynamic bodies, not pushed back<br>
            • <strong style="color:#facc15;">One shared collision shape</strong> — set in the Animation Panel on any frame. Movement uses its bounding box. Shape does <em>not</em> change per frame (use Dynamic for that).
        </div>` : '';

    const layersHTML = hasPhysics ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Collision Layers</div>
        <div class="prop-row">
          <span class="prop-label" title="Bitmask: which layer this body belongs to">Category</span>
          <input id="phys-col-cat" type="number" value="${obj.physicsCollisionCategory ?? 1}" min="1" max="2147483647" step="1" style="width:80px;${_inp()}">
        </div>
        <div class="prop-row">
          <span class="prop-label" title="Bitmask: which layers to collide with (−1 = all)">Mask</span>
          <input id="phys-col-mask" type="number" value="${obj.physicsCollisionMask ?? -1}" min="-2147483648" max="2147483647" step="1" style="width:80px;${_inp()}">
        </div>
    ` : '';

    return `
    <div class="component-block" id="inspector-physics-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
        </svg>
        <span style="font-weight:600;color:#facc15;">Physics</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:6px;">
        <div class="prop-row">
          <span class="prop-label">Body type</span>
          <select id="phys-type" style="${_sel()}">
            ${OPT('none','❌ None')}
            ${OPT('static','🔵 Static')}
            ${OPT('kinematic','🟡 Kinematic')}
            ${OPT('dynamic','🔴 Dynamic')}
          </select>
        </div>
        ${hasPhysics && typeDescs[type] ? `
        <div style="background:${type==='static'?'#0a1020':type==='kinematic'?'#1a1400':'#1a0a0a'};border:1px solid ${type==='static'?'#60a5fa33':type==='kinematic'?'#facc1533':'#f8717133'};border-radius:3px;padding:5px 8px;font-size:9px;color:${type==='static'?'#60a5fa88':type==='kinematic'?'#facc1588':'#f8717188'};line-height:1.5;">
            ${typeDescs[type]}
        </div>` : ''}
        <div id="phys-extra" style="display:${hasPhysics?'flex':'none'};flex-direction:column;gap:5px;">
          <div style="background:#0a0a18;border:1px solid #7c3aed33;border-radius:3px;padding:5px 8px;font-size:9px;color:#a78bfa99;line-height:1.5;">
            ${isKinematic
                ? `🎞 Set <strong style="color:#a78bfa;">one shared collision shape</strong> in the Animation Panel (auto-fitted from any frame). Kinematic movement uses its bounding box — shape does not change per frame.`
                : `🎞 Collision shapes are set per animation frame in the <strong style="color:#a78bfa;">Animation Panel</strong>. Each frame gets its own auto-fitted shape.`
            }
          </div>
          ${materialHTML}
          ${massHTML}
          ${gravityHTML}
          ${dampingHTML}
          ${constraintsHTML}
          ${kinematicNote}
          ${layersHTML}
          <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;margin-top:2px;">
            ▶ Physics runs in Play Mode only
          </div>
          <button id="phys-show-collision" style="${_btn('#facc15')}width:100%;margin-top:2px;font-size:10px;${state.showCollision?'background:#facc1533;':''}">
            ${state.showCollision ? '👁 Hide Collision Shape' : '👁 Show Collision Shape'}
          </button>
        </div>
      </div>
    </div>`;
}

function _frameBtn(hasShape, frameId) {
    const active = hasShape;
    return `background:${active ? '#1a1a30' : '#0a0a18'};border:1px solid ${active ? '#7c3aed' : '#1a1a30'};
            color:${active ? '#a78bfa' : '#555'};border-radius:3px;padding:2px 6px;cursor:pointer;
            font-size:9px;font-weight:${active ? '700' : '400'};`;
}

function _polySummary(poly) {
    return (Array.isArray(poly) && poly.length >= 3)
        ? `${poly.length} vertices defined`
        : 'No shape — draw one below';
}

// ── Auto-fit ──────────────────────────────────────────────────
export function autoFitCollisionShape(obj, onDone) {
    _autoFitCollisionShape(obj, onDone);
}

function _autoFitCollisionShape(obj, onDone) {
    const dataURL = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.dataURL
                 || obj.spriteGraphic?.texture?.baseTexture?.resource?.source?.src
                 || null;
    if (dataURL) {
        _alphaHullFromDataURL(dataURL, obj, onDone);
    } else {
        const raw = rawSpriteSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        obj._polyUnit = 'container';
        obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        try { onDone?.(); } catch(_) {}
    }
}

function _alphaHullFromDataURL(dataURL, obj, onDone) {
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth  || 64;
        canvas.height = img.naturalHeight || 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let hull     = _computeAlphaOBB(pixels, canvas.width, canvas.height);
            if (hull && hull.length >= 3) {
                const { x: ssx, y: ssy } = _innerScale(obj);
                hull = hull.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
                if (!obj.physicsPolygons) obj.physicsPolygons = {};
                obj.physicsPolygons.shared = hull;
                obj.physicsShape  = 'polygon';
                obj.physicsPolygon = hull.slice();
                obj._polyUnit = 'container';
                const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
                if (firstFrameId) obj.physicsPolygons[firstFrameId] = hull.slice();
                try { onDone?.(); } catch(_) {}
                return;
            }
        } catch(_) {}
        const raw = rawSpriteSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        obj._polyUnit = 'container';
        const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
        if (firstFrameId) obj.physicsPolygons[firstFrameId] = obj.physicsPolygons.shared.slice();
        try { onDone?.(); } catch(_) {}
    };
    img.src = dataURL;
}

function _computeAlphaOBB(imageData, w, h) {
    const data = imageData.data;
    const THRESHOLD = 20;
    let minX = w, maxX = 0, minY = h, maxY = 0, found = false;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > THRESHOLD) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                found = true;
            }
        }
    }
    if (!found) return null;
    minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1); maxY = Math.min(h - 1, maxY + 1);
    const cx = w / 2, cy = h / 2;
    return [
        { x: minX - cx, y: minY - cy }, { x: maxX - cx, y: minY - cy },
        { x: maxX - cx, y: maxY - cy }, { x: minX - cx, y: maxY - cy },
    ];
}

// ── Inspector bindings ────────────────────────────────────────
export function bindPhysicsInspector(obj) {
    const typeEl  = document.getElementById('phys-type');
    const extra   = document.getElementById('phys-extra');
    const shapeEl = document.getElementById('phys-shape');
    const polyRow = document.getElementById('phys-polygon-row');
    const editBtn = document.getElementById('phys-edit-polygon');
    const fricEl  = document.getElementById('phys-friction');
    const bnceEl  = document.getElementById('phys-bounce');
    if (!typeEl) return;

    typeEl.addEventListener('change', () => {
        obj.physicsBody = typeEl.value;
        // Always use polygon shape so per-frame collision works
        if (typeEl.value !== 'none') {
            obj.physicsShape = 'polygon';
            obj._polyUnit    = 'container';
        }
        _pushUndo();
        // Rebuild the live physics body immediately if we're in play mode
        import('./engine.physics.js').then(m => {
            if (state.isPlaying) {
                m.rebuildBodyForObject(obj);
            }
        });
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });

    // Shape, size editors and polygon editor are removed from the inspector.
    // Collision shapes are set per-frame in the Animation Panel.

    fricEl?.addEventListener('change', () => { obj.physicsFriction = Math.max(0, Math.min(1, parseFloat(fricEl.value) || 0)); _pushUndo(); });
    bnceEl?.addEventListener('change', () => { obj.physicsRestitution = Math.max(0, Math.min(1, parseFloat(bnceEl.value) || 0)); _pushUndo(); });
    document.getElementById('phys-density')?.addEventListener('change', (e) => { obj.physicsDensity = Math.max(0.0001, parseFloat(e.target.value) || 0.001); _pushUndo(); });
    document.getElementById('phys-gravity-scale')?.addEventListener('change', (e) => {
        obj.physicsGravityScale = parseFloat(e.target.value) ?? 1;
        // Wake the body immediately so new gravity takes effect without needing a script
        if (obj._physicsBody) { try { obj._physicsBody.setAwake(true); } catch(_) {} }
        _pushUndo();
    });
    document.getElementById('phys-gravity-x-scale')?.addEventListener('change', (e) => {
        obj.physicsGravityXScale = parseFloat(e.target.value) ?? 0;
        if (obj._physicsBody) { try { obj._physicsBody.setAwake(true); } catch(_) {} }
        _pushUndo();
    });
    document.getElementById('phys-linear-damp')?.addEventListener('change', (e) => { obj.physicsLinearDamping = Math.max(0, parseFloat(e.target.value) || 0); _pushUndo(); });
    document.getElementById('phys-angular-damp')?.addEventListener('change', (e) => { obj.physicsAngularDamping = Math.max(0, parseFloat(e.target.value) || 0); _pushUndo(); });
    document.getElementById('phys-immovable')?.addEventListener('change', (e) => {
        obj.physicsImmovable = e.target.checked;
        import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
        _pushUndo();
    });
    document.getElementById('phys-fixed-rot')?.addEventListener('change', (e) => { obj.physicsFixedRotation = e.target.checked; _pushUndo(); });
    document.getElementById('phys-sensor')?.addEventListener('change', (e) => { obj.physicsIsSensor = e.target.checked; _pushUndo(); });
    document.getElementById('phys-col-cat')?.addEventListener('change', (e) => { obj.physicsCollisionCategory = Math.max(1, parseInt(e.target.value) || 1); _pushUndo(); });
    document.getElementById('phys-col-mask')?.addEventListener('change', (e) => { obj.physicsCollisionMask = parseInt(e.target.value) ?? -1; _pushUndo(); });

    document.getElementById('phys-show-collision')?.addEventListener('click', () => {
        import('./engine.collision-overlay.js').then(m => {
            m.setCollisionVisible(!state.showCollision);
            const btn = document.getElementById('phys-show-collision');
            if (btn) {
                btn.textContent = state.showCollision ? '👁 Hide Collision Shape' : '👁 Show Collision Shape';
                btn.style.background = state.showCollision ? '#facc1533' : '';
            }
        });
    });
}

function _pushUndo() { import('./engine.history.js').then(({ pushUndo }) => pushUndo()); }

// ── Polygon Editor ────────────────────────────────────────────
export function openPolygonEditor(obj, frameId = 'shared', opts = {}) {
    document.getElementById('poly-editor-panel')?.remove();
    if (!obj.physicsPolygons || typeof obj.physicsPolygons !== 'object') {
        obj.physicsPolygons = {};
        if (Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3)
            obj.physicsPolygons.shared = obj.physicsPolygon.map(p => ({ x: p.x, y: p.y }));
    }
    migratePolygonsToContainer(obj);

    const raw = rawSpriteSize(obj);
    const sprW = raw.w, sprH = raw.h;
    const BORDER = Math.max(sprW, sprH, 80);
    const totalW = sprW + 2 * BORDER;
    const totalH = sprH + 2 * BORDER;
    const FIT_SCALE = Math.min(420 / totalW, 420 / totalH, 4);
    let SCALE = FIT_SCALE;
    let cvW   = Math.round(totalW * SCALE);
    let cvH   = Math.round(totalH * SCALE);

    const existing = obj.physicsPolygons[frameId];
    let pts = (Array.isArray(existing) && existing.length >= 3)
        ? existing.map(p => ({ x: p.x, y: p.y }))
        : _defaultBox(sprW, sprH);

    let previewURL = null;
    if (frameId !== 'shared') {
        for (const anim of (obj.animations || [])) {
            const f = (anim.frames || []).find(f => f.id === frameId);
            if (f) { previewURL = f.dataURL; break; }
        }
    } else {
        previewURL = obj.animations?.[0]?.frames?.[0]?.dataURL || null;
    }
    if (!previewURL && obj.spriteGraphic?.texture?.baseTexture?.resource?.source) {
        const src = obj.spriteGraphic.texture.baseTexture.resource.source;
        previewURL = src.src || src.currentSrc || null;
    }

    const frameLabel = frameId === 'shared' ? 'All Frames (Shared)' : (frameId || 'shared');
    const panel = document.createElement('div');
    panel.id = 'poly-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);font-family:sans-serif;';

    panel.innerHTML = `
    <div style="background:#0d0d1e;border:1px solid #7c3aed66;border-radius:8px;overflow:hidden;
                display:flex;flex-direction:column;width:min(700px,95vw);max-height:92vh;">
      <div style="padding:12px 16px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;gap:10px;">
        <span style="color:#7c3aed;font-weight:700;font-size:13px;">Collision Shape Editor</span>
        <span style="color:#555;font-size:11px;">→</span>
        <span style="color:#a78bfa;font-size:11px;">${frameLabel}</span>
        <div style="display:flex;gap:5px;margin-left:auto;">
          <button id="pe-zoom-out" title="Zoom out" style="${_btn('#a78bfa')}padding:4px 7px;">−</button>
          <span id="pe-zoom-label" style="color:#a78bfa;font-size:10px;align-self:center;min-width:36px;text-align:center;">100%</span>
          <button id="pe-zoom-in"  title="Zoom in"  style="${_btn('#a78bfa')}padding:4px 7px;">+</button>
          <button id="pe-zoom-fit" title="Fit"      style="${_btn('#a78bfa')}padding:4px 7px;">⤢</button>
          <span style="border-left:1px solid #1a1a30;margin:0 4px;"></span>
          <button id="pe-box"    style="${_btn('#3b82f6')}">↺ Box</button>
          <button id="pe-circle" style="${_btn('#06b6d4')}">↺ Circle</button>
          <button id="pe-clear"  style="${_btn('#ef4444')}">✕ Clear</button>
        </div>
      </div>
      <div style="display:flex;flex:1;overflow:hidden;">
        <div style="display:flex;flex-direction:column;align-items:center;padding:14px;gap:6px;flex:1;min-width:0;">
          <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:.05em;text-align:center;">
            Click: add point  •  Drag: move  •  Right-click: delete  •  Ctrl+Wheel: zoom
          </div>
          <div id="pe-canvas-wrap" style="overflow:auto;max-width:600px;max-height:560px;background:#04040a;border:1px solid #1a1a30;border-radius:4px;display:flex;">
            <canvas id="pe-canvas" width="${cvW}" height="${cvH}"
              style="background:#080812;cursor:crosshair;display:block;flex-shrink:0;"
              oncontextmenu="return false;"></canvas>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-grid" type="checkbox" checked style="accent-color:#7c3aed;"> Grid
            </label>
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-sprite" type="checkbox" checked style="accent-color:#7c3aed;"> Preview sprite
            </label>
          </div>
        </div>
        <div style="width:180px;flex-shrink:0;border-left:1px solid #1a1a30;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:8px 10px;border-bottom:1px solid #1a1a30;color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Vertices (local px)</div>
          <div id="pe-vlist" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px;"></div>
          <div id="pe-status" style="padding:6px 10px;border-top:1px solid #1a1a30;color:#555;font-size:9px;"></div>
        </div>
      </div>
      <div style="padding:10px 16px;border-top:1px solid #1a1a30;display:flex;justify-content:flex-end;gap:8px;">
        <button id="pe-cancel" style="${_btn('#555')}">Cancel</button>
        <button id="pe-copy-to-all" style="${_btn('#06b6d4')}" title="Copy this shape to all frames">Copy to all frames</button>
        <button id="pe-save"   style="${_btn('#7c3aed')}font-weight:700;">✓ Save</button>
      </div>
    </div>`;

    document.body.appendChild(panel);
    const canvas = panel.querySelector('#pe-canvas');
    const wrap   = panel.querySelector('#pe-canvas-wrap');
    const zoomLbl = panel.querySelector('#pe-zoom-label');
    const ctx    = canvas.getContext('2d');
    let spriteImg = null, showGrid = true, showSprite = true;

    if (previewURL) { spriteImg = new Image(); spriteImg.onload = draw; spriteImg.src = previewURL; }
    requestAnimationFrame(() => {
        const spriteCenterX = (BORDER + sprW / 2) * SCALE;
        const spriteCenterY = (BORDER + sprH / 2) * SCALE;
        wrap.scrollLeft = Math.max(0, spriteCenterX - wrap.clientWidth  / 2);
        wrap.scrollTop  = Math.max(0, spriteCenterY - wrap.clientHeight / 2);
    });

    let dragging = -1, hover = -1;
    const ZOOM_MIN = 0.25, ZOOM_MAX = 16;

    function applyZoom(newScale, anchorClient) {
        const old  = SCALE;
        const next = Math.max(ZOOM_MIN * FIT_SCALE, Math.min(ZOOM_MAX * FIT_SCALE, newScale));
        if (Math.abs(next - old) < 0.001) return;
        const wrapRect = wrap.getBoundingClientRect();
        const cvRect   = canvas.getBoundingClientRect();
        const ax = anchorClient ? anchorClient.x - cvRect.left : (wrap.clientWidth  / 2 - (cvRect.left - wrapRect.left));
        const ay = anchorClient ? anchorClient.y - cvRect.top  : (wrap.clientHeight / 2 - (cvRect.top  - wrapRect.top ));
        const localX = ax / old, localY = ay / old;
        SCALE = next;
        cvW = Math.round(totalW * SCALE); cvH = Math.round(totalH * SCALE);
        canvas.width = cvW; canvas.height = cvH;
        wrap.scrollLeft = Math.max(0, localX * SCALE - ax);
        wrap.scrollTop  = Math.max(0, localY * SCALE - ay);
        if (zoomLbl) zoomLbl.textContent = Math.round((SCALE / FIT_SCALE) * 100) + '%';
        draw();
    }

    function toCanvas(p) { return { x: (p.x + sprW/2 + BORDER) * SCALE, y: (p.y + sprH/2 + BORDER) * SCALE }; }
    function toLocal(cx, cy) { return { x: cx / SCALE - sprW/2 - BORDER, y: cy / SCALE - sprH/2 - BORDER }; }
    function evPos(e) {
        const r  = canvas.getBoundingClientRect();
        const sx = cvW / r.width, sy = cvH / r.height;
        const s  = e.touches ? e.touches[0] : e;
        return { cx: (s.clientX - r.left) * sx, cy: (s.clientY - r.top) * sy };
    }
    function nearestPt(cx, cy) {
        let best = -1, bd = Infinity;
        pts.forEach((p, i) => { const c = toCanvas(p); const d = Math.hypot(cx - c.x, cy - c.y); if (d < bd) { bd = d; best = i; } });
        return bd < 10 ? best : -1;
    }

    function draw() {
        ctx.clearRect(0, 0, cvW, cvH);
        ctx.fillStyle = '#080812'; ctx.fillRect(0, 0, cvW, cvH);
        const sprLeft = BORDER * SCALE, sprTop = BORDER * SCALE;
        const sprPxW = sprW * SCALE, sprPxH = sprH * SCALE;
        if (showSprite && spriteImg?.complete && spriteImg.naturalWidth > 0) {
            ctx.globalAlpha = 0.4; ctx.drawImage(spriteImg, sprLeft, sprTop, sprPxW, sprPxH); ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
        ctx.strokeRect(sprLeft, sprTop, sprPxW, sprPxH); ctx.setLineDash([]);
        if (showGrid) {
            const step = Math.max(8, Math.round(Math.min(sprW, sprH) / 8)) * SCALE;
            const ox = cvW / 2, oy = cvH / 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
            for (let x = ox % step; x < cvW; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cvH); ctx.stroke(); }
            for (let y = oy % step; y < cvH; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cvW,y); ctx.stroke(); }
            ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.setLineDash([3,3]);
            ctx.beginPath(); ctx.moveTo(ox,0); ctx.lineTo(ox,cvH); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0,oy); ctx.lineTo(cvW,oy); ctx.stroke();
            ctx.setLineDash([]);
        }
        if (pts.length === 0) {
            ctx.fillStyle='#444'; ctx.font='11px sans-serif'; ctx.textAlign='center';
            ctx.fillText('Click to add vertices', cvW/2, cvH/2); ctx.textAlign='left';
            rebuildList(); updateStatus(); return;
        }
        const c0 = toCanvas(pts[0]);
        ctx.beginPath(); ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i < pts.length; i++) { const c = toCanvas(pts[i]); ctx.lineTo(c.x, c.y); }
        if (pts.length >= 3) ctx.closePath();
        ctx.fillStyle = 'rgba(124,58,237,0.2)'; if (pts.length >= 3) ctx.fill();
        ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5; ctx.stroke();
        pts.forEach((p, i) => {
            const c = toCanvas(p), big = i === dragging || i === hover;
            ctx.beginPath(); ctx.arc(c.x, c.y, big ? 7 : 4, 0, Math.PI*2);
            ctx.fillStyle = i === dragging ? '#facc15' : i === hover ? '#fff' : '#a78bfa';
            ctx.strokeStyle = '#0d0d1e'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
            ctx.fillStyle = i === dragging ? '#000' : '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(String(i), c.x, c.y + 3); ctx.textAlign = 'left';
        });
        rebuildList(); updateStatus();
    }

    function updateStatus() {
        const el = panel.querySelector('#pe-status');
        if (!el) return;
        const MAX_POLY_PTS = 16;
        if (pts.length >= MAX_POLY_PTS) {
            el.textContent = `⚠ ${pts.length}/${MAX_POLY_PTS} vertices — at limit`;
            el.style.color = '#fbbf24';
        } else if (pts.length >= 3) {
            el.textContent = `✓ ${pts.length}/${MAX_POLY_PTS} vertices — valid`;
            el.style.color = '#4ade80';
        } else {
            el.textContent = `${pts.length} / 3+ vertices needed`;
            el.style.color = '#ef4444';
        }
    }

    function rebuildList() {
        const el = panel.querySelector('#pe-vlist');
        if (!el) return;
        el.innerHTML = '';
        pts.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:3px;background:${i===hover?'#140e28':'transparent'};border-radius:2px;padding:1px 2px;`;
            row.innerHTML = `
              <span style="color:#7c3aed;font-size:9px;min-width:12px;">${i}</span>
              <input type="number" data-i="${i}" data-ax="x" value="${p.x.toFixed(1)}" style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <input type="number" data-i="${i}" data-ax="y" value="${p.y.toFixed(1)}" style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <button data-del="${i}" style="${_btn('#ef4444')}padding:1px 3px;font-size:9px;line-height:1;">✕</button>`;
            el.appendChild(row);
        });
        el.querySelectorAll('input[data-i]').forEach(inp => inp.addEventListener('change', () => { pts[parseInt(inp.dataset.i)][inp.dataset.ax] = parseFloat(inp.value) || 0; draw(); }));
        el.querySelectorAll('button[data-del]').forEach(btn => btn.addEventListener('click', () => { pts.splice(parseInt(btn.dataset.del), 1); draw(); }));
    }

    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        const { cx, cy } = evPos(e);
        if (e.button === 2) { const i = nearestPt(cx, cy); if (i >= 0) { pts.splice(i, 1); hover = -1; draw(); } return; }
        const i = nearestPt(cx, cy);
        if (i >= 0) { dragging = i; canvas.style.cursor = 'grabbing'; }
        else {
            const MAX_POLY_PTS = 16;
            if (pts.length >= MAX_POLY_PTS) {
                // Flash the status label red to tell the user they're at the limit
                const st = panel.querySelector('#pe-status');
                if (st) {
                    st.textContent = `⚠ Max ${MAX_POLY_PTS} vertices — remove a point first`;
                    st.style.color = '#f87171';
                    clearTimeout(st._warnTimer);
                    st._warnTimer = setTimeout(() => updateStatus(), 2000);
                }
            } else {
                pts.push(toLocal(cx, cy));
                draw();
            }
        }
    });
    const _onMove = e => {
        const { cx, cy } = evPos(e);
        if (dragging >= 0) { pts[dragging] = toLocal(cx, cy); draw(); return; }
        const old = hover; hover = nearestPt(cx, cy);
        canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
        if (hover !== old) draw();
    };
    const _onUp = () => { if (dragging >= 0) { dragging = -1; canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair'; draw(); } };
    window.addEventListener('mousemove', _onMove);
    window.addEventListener('mouseup',   _onUp);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    panel.querySelector('#pe-show-grid').addEventListener('change',   e => { showGrid   = e.target.checked; draw(); });
    panel.querySelector('#pe-show-sprite').addEventListener('change', e => { showSprite = e.target.checked; draw(); });
    panel.querySelector('#pe-box').addEventListener('click',    () => { pts = _defaultBox(sprW, sprH); draw(); });
    panel.querySelector('#pe-circle').addEventListener('click', () => { pts = _defaultCircle(Math.min(sprW, sprH) / 2); draw(); });
    panel.querySelector('#pe-clear').addEventListener('click',  () => { pts = []; draw(); });
    panel.querySelector('#pe-zoom-in') .addEventListener('click', () => applyZoom(SCALE * 1.25));
    panel.querySelector('#pe-zoom-out').addEventListener('click', () => applyZoom(SCALE / 1.25));
    panel.querySelector('#pe-zoom-fit').addEventListener('click', () => applyZoom(FIT_SCALE));
    wrap.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); applyZoom(SCALE * (e.deltaY < 0 ? 1.15 : 1/1.15), { x: e.clientX, y: e.clientY }); }, { passive: false });

    function saveAndClose() {
        window.removeEventListener('mousemove', _onMove);
        window.removeEventListener('mouseup',   _onUp);
        if (pts.length >= 3) {
            if (!obj.physicsPolygons) obj.physicsPolygons = {};
            obj.physicsPolygons[frameId] = pts.map(p => ({ x: p.x, y: p.y }));
            obj.physicsShape = 'polygon';
            obj._polyUnit = 'container';
            if (frameId === 'shared') {
                obj.physicsPolygon = obj.physicsPolygons.shared.slice();
                const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
                if (firstFrameId && !obj.physicsPolygons[firstFrameId])
                    obj.physicsPolygons[firstFrameId] = obj.physicsPolygons.shared.slice();
            }
            const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
            if (frameId === firstFrameId) {
                obj.physicsPolygon = pts.map(p => ({ x: p.x, y: p.y }));
                obj.physicsPolygons.shared = obj.physicsPolygon.slice();
            }
        }
        import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
        import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
        _pushUndo();
        panel.remove();
        try { opts?.onSave?.(frameId); } catch (_) {}
    }

    panel.querySelector('#pe-save').addEventListener('click', saveAndClose);
    panel.querySelector('#pe-copy-to-all').addEventListener('click', () => {
        if (pts.length < 3) return;
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = pts.map(p => ({ x: p.x, y: p.y }));
        (obj.animations || []).forEach(anim => (anim.frames || []).forEach(f => { obj.physicsPolygons[f.id] = pts.map(p => ({ x: p.x, y: p.y })); }));
        obj._polyUnit = 'container';
        saveAndClose();
    });
    panel.querySelector('#pe-cancel').addEventListener('click', () => {
        window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove();
    });
    panel.addEventListener('mousedown', e => {
        if (e.target === panel) {
            if (pts.length >= 3) saveAndClose();
            else { window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove(); }
        }
    });
    const _onKey = (e) => {
        if (e.key === 'Escape') {
            if (pts.length >= 3) saveAndClose();
            else { window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove(); }
            window.removeEventListener('keydown', _onKey);
        }
    };
    window.addEventListener('keydown', _onKey);
    draw();
}

// ── Default shapes ────────────────────────────────────────────
function _defaultBox(w, h) {
    const hw = w/2 - 0.5, hh = h/2 - 0.5;
    return [{ x:-hw,y:-hh },{ x:hw,y:-hh },{ x:hw,y:hh },{ x:-hw,y:hh }];
}
function _defaultCircle(r, n = 12) {
    return Array.from({ length: n }, (_, i) => ({
        x: Math.round(Math.cos((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
        y: Math.round(Math.sin((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
    }));
}

// ── Snapshot helpers ──────────────────────────────────────────
export function snapshotPhysics(obj) {
    return {
        physicsBody:              obj.physicsBody              ?? 'none',
        physicsFriction:          obj.physicsFriction          ?? 0.3,
        physicsRestitution:       obj.physicsRestitution       ?? 0.1,
        physicsShape:             obj.physicsShape             ?? 'box',
        physicsDensity:           obj.physicsDensity           ?? 0.001,
        physicsGravityScale:      obj.physicsGravityScale      ?? 1,
        physicsGravityXScale:     obj.physicsGravityXScale     ?? 0,
        physicsLinearDamping:     obj.physicsLinearDamping     ?? 0.08,
        physicsAngularDamping:    obj.physicsAngularDamping    ?? 0.05,
        physicsFixedRotation:     !!obj.physicsFixedRotation,
        physicsIsSensor:          !!obj.physicsIsSensor,
        physicsImmovable:         !!obj.physicsImmovable,
        physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
        physicsCollisionMask:     obj.physicsCollisionMask     ?? -1,
        physicsSize:     obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
        physicsPolygon:  obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
        physicsPolygons: obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
        _polyUnit:               obj._polyUnit || null,
        _collisionShapeInit:     !!obj._collisionShapeInit,
    };
}

export function restorePhysics(obj, snap) {
    if (!snap) return;
    obj.physicsBody              = snap.physicsBody              ?? 'none';
    obj.physicsFriction          = snap.physicsFriction          ?? 0.3;
    obj.physicsRestitution       = snap.physicsRestitution       ?? 0.1;
    obj.physicsShape             = snap.physicsShape             ?? 'box';
    obj.physicsDensity           = snap.physicsDensity           ?? 0.001;
    obj.physicsGravityScale      = snap.physicsGravityScale      ?? 1;
    obj.physicsGravityXScale     = snap.physicsGravityXScale     ?? 0;
    obj.physicsLinearDamping     = snap.physicsLinearDamping     ?? 0.08;
    obj.physicsAngularDamping    = snap.physicsAngularDamping    ?? 0.05;
    obj.physicsFixedRotation     = !!snap.physicsFixedRotation;
    obj.physicsIsSensor          = !!snap.physicsIsSensor;
    obj.physicsImmovable         = !!snap.physicsImmovable;
    obj.physicsCollisionCategory = snap.physicsCollisionCategory ?? 1;
    obj.physicsCollisionMask     = snap.physicsCollisionMask     ?? -1;
    obj.physicsSize     = snap.physicsSize     ? JSON.parse(JSON.stringify(snap.physicsSize))     : null;
    obj.physicsPolygon  = snap.physicsPolygon  ? JSON.parse(JSON.stringify(snap.physicsPolygon))  : null;
    obj.physicsPolygons = snap.physicsPolygons ? JSON.parse(JSON.stringify(snap.physicsPolygons)) : null;
    obj._polyUnit            = snap._polyUnit || null;
    obj._collisionShapeInit  = !!snap._collisionShapeInit;
}

// ── Style helpers ─────────────────────────────────────────────
function _btn(c)  { return `background:${c}22;border:1px solid ${c}66;color:${c};border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;`; }
function _sel()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;`; }
function _inp()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`; }
