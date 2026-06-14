/* ============================================================
   Zengine — engine.renderer.js
   Scene graph, grid, camera bounds, gizmo size ticker.
   ============================================================ */

import { state, PIXELS_PER_UNIT } from './engine.state.js';

export function initScene() {
    const { app } = state;

    // ── GPU / Quality settings ────────────────────────────
    // Use LINEAR filtering for smooth edges (no pixelation)
    PIXI.settings.SCALE_MODE      = PIXI.SCALE_MODES.LINEAR;
    // Preserve full resolution — no forced downscale
    PIXI.settings.RESOLUTION      = window.devicePixelRatio || 1;
    // Max texture size guard (GPU limit)
    PIXI.settings.SPRITE_MAX_TEXTURES = 32;

    // ── Scene hierarchy ───────────────────────────────────
    // Layer order (back → front):
    //   [0] gridLayer    — editor grid (always behind game objects)
    //   [1] sceneContainer — all game objects live here
    //   [2] cameraBounds   — editor overlay (always on top in editor)
    //
    // Grid and cameraBounds are siblings of sceneContainer on the stage,
    // so no game object can ever be sorted below the grid.

    state.gridLayer = new PIXI.Graphics();
    state.gridLayer.name = '__grid__';
    app.stage.addChild(state.gridLayer);

    state.sceneContainer = new PIXI.Container();
    state.sceneContainer.sortableChildren = false;
    app.stage.addChild(state.sceneContainer);
    state.sceneContainer.position.set(
        app.screen.width  / 2,
        app.screen.height / 2
    );

    state.cameraBounds = new PIXI.Graphics();
    app.stage.addChild(state.cameraBounds);

    // Mirror sceneContainer position/scale onto grid every frame
    // so the grid scrolls/zooms with the camera
    app.ticker.add(_syncGridTransform);

    drawGrid();
}

function _syncGridTransform() {
    if (!state.gridLayer || !state.sceneContainer) return;
    state.gridLayer.position.copyFrom(state.sceneContainer.position);
    state.gridLayer.scale.copyFrom(state.sceneContainer.scale);
    state.gridLayer.visible = state.showGrid && !state.isPlaying;
}

/** Toggle the editor grid on/off */
export function setGridVisible(visible) {
    state.showGrid = visible;
    if (state.gridLayer) state.gridLayer.visible = visible && !state.isPlaying;
    // Update toolbar badge
    const badge = document.getElementById('grid-toggle-badge');
    if (badge) badge.style.display = visible ? 'block' : 'none';
    const btn = document.getElementById('btn-grid-toggle');
    if (btn) btn.style.color = visible ? '#6adf88' : '#555';
    import('./engine.persist.js').then(m => m.markDirty()).catch(() => {});
}

export function drawGrid() {
    const { gridLayer } = state;
    if (!gridLayer) return;
    gridLayer.clear();

    // ── Subtle grid ──
    gridLayer.lineStyle(1, 0x2a2a2a, 1);
    const size = 8000, step = 25;
    for (let i = -size; i <= size; i += step) {
        gridLayer.moveTo(i, -size); gridLayer.lineTo(i,  size);
        gridLayer.moveTo(-size, i); gridLayer.lineTo(size, i);
    }
    // Major grid lines every 100 units
    gridLayer.lineStyle(1, 0x3a3a3a, 1);
    for (let i = -size; i <= size; i += 100) {
        gridLayer.moveTo(i, -size); gridLayer.lineTo(i,  size);
        gridLayer.moveTo(-size, i); gridLayer.lineTo(size, i);
    }
    // Origin axes
    gridLayer.lineStyle(2, 0x444455, 1);
    gridLayer.moveTo(0, -size); gridLayer.lineTo(0,  size);
    gridLayer.moveTo(-size, 0); gridLayer.lineTo(size, 0);

    // Store ref and sync visibility
    state.gridGraphics = gridLayer;
    gridLayer.visible  = state.showGrid && !state.isPlaying;

    // Redraw HTML camera bounds overlay
    import('./engine.playmode.js').then(m => m.drawCameraBounds());
}

export function startGizmoSizeTicker() {
    state.app.ticker.add(() => {
        const camScale = state.sceneContainer.scale.x;
        for (const obj of state.gameObjects) {
            const gc = obj._gizmoContainer;
            if (!gc) continue;
            // Lights and tilemaps: constant screen-size gizmo
            if (obj.isLight || obj.isTilemap) {
                gc.scale.set(1 / camScale, 1 / camScale);
            } else {
                gc.scale.set(
                    1 / (camScale * obj.scale.x),
                    1 / (camScale * obj.scale.y)
                );
            }
        }
    });
}
