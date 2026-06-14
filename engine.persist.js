/* ============================================================
   Zengine — engine.persist.js
   Auto-saves ALL project state to IndexedDB + localStorage.
   Restores everything on page load so the user picks up exactly
   where they left off.

   Storage split:
   • IndexedDB  — large binary blobs (asset dataURLs, tileset tile
                   dataURLs).  Key "zengine_assets".
   • localStorage — everything else (scenes, objects, prefabs,
                   scripts, scene settings, UI state).
                   Key "zengine_project".

   Auto-save fires ~2 s after any change (debounced).
   ============================================================ */

import { state } from './engine.state.js';

// ── Constants ────────────────────────────────────────────────
const LS_KEY        = 'zengine_project';
const IDB_DB_NAME   = 'ZengineDB';
const IDB_STORE     = 'blobs';
const IDB_ASSET_KEY = 'assets';
const IDB_TILE_KEY  = 'tilesetBrushes';
const PERSIST_VER   = 2;
const DEBOUNCE_MS   = 2000;

// ── Internal state ───────────────────────────────────────────
let _db          = null;   // IDBDatabase handle
let _saveTimer   = null;
let _dirty       = false;
let _initialized = false;

// ── Public API ───────────────────────────────────────────────

/** Call once at engine startup — opens IDB then restores saved data. */
export async function initPersist() {
    if (_initialized) return;
    _initialized = true;
    _db = await _openDB();
    await _restore();
}

/** Mark state as dirty and schedule an auto-save. */
export function markDirty() {
    _dirty = true;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_autoSave, DEBOUNCE_MS);
}

/** Force an immediate save (e.g. before page unload). */
export async function flushSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    await _autoSave();
}

/** Wipe all persisted data (called by newProject). */
export async function clearPersisted() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    if (_db) {
        await _idbPut(IDB_ASSET_KEY, []);
        await _idbPut(IDB_TILE_KEY,  []);
    }
}

// ── IndexedDB helpers ────────────────────────────────────────

function _openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess  = (e) => resolve(e.target.result);
        req.onerror    = (e) => { console.warn('[persist] IDB open failed', e); resolve(null); };
    });
}

function _idbPut(key, value) {
    return new Promise((resolve) => {
        if (!_db) { resolve(); return; }
        try {
            const tx    = _db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            const req   = store.put(value, key);
            req.onsuccess = () => resolve();
            req.onerror   = (e) => { console.warn('[persist] IDB put error', e); resolve(); };
        } catch (e) { console.warn('[persist] IDB tx error', e); resolve(); }
    });
}

function _idbGet(key) {
    return new Promise((resolve) => {
        if (!_db) { resolve(null); return; }
        try {
            const tx    = _db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req   = store.get(key);
            req.onsuccess = (e) => resolve(e.target.result ?? null);
            req.onerror   = () => resolve(null);
        } catch { resolve(null); }
    });
}

// ── Snapshot helpers ─────────────────────────────────────────

/**
 * Take a serialisable snapshot of state.gameObjects for the
 * *currently live* scene (mirrors engine.project.js logic).
 */
function _snapshotObjects() {
    return state.gameObjects.map(obj => {
        if (obj.isLight) {
            return {
                isLight: true, lightType: obj.lightType,
                label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
            };
        }
        if (obj.isTilemap) {
            return {
                isTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
            };
        }
        if (obj.isAutoTilemap) {
            const td = obj.autoTileData;
            return {
                isAutoTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                autoTileData: { ...td, cells: Array.from(td.cells), brushList: td.brushList.slice() },
            };
        }
        if (obj.isText) {
            return {
                isText: true,
                label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                scaleX: obj.scale.x, scaleY: obj.scale.y,
                rotation: obj.rotation,
                textContent:  obj.textContent ?? '',
                textStyle:    JSON.parse(JSON.stringify(obj.textStyle ?? {})),
                visible:      obj.visible !== false,
                alpha:        obj.alpha ?? 1,
                scriptName:   obj.scriptName  ?? null,
                scriptTag:    obj._scriptTag  ?? null,
                scriptGroup:  obj._scriptGroup ?? null,
            };
        }
        return {
            label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
            prefabId: obj.prefabId || null,
            x: obj.x, y: obj.y, scaleX: obj.scale.x, scaleY: obj.scale.y,
            rotation: obj.rotation, unityZ: obj.unityZ || 0,
            tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
            animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
            activeAnimIndex: obj.activeAnimIndex || 0,
            physicsBody:           obj.physicsBody          ?? 'none',
            physicsFriction:       obj.physicsFriction      ?? 0.3,
            physicsRestitution:    obj.physicsRestitution   ?? 0.1,
            physicsDensity:        obj.physicsDensity       ?? 0.001,
            physicsGravityScale:   obj.physicsGravityScale  ?? 1,
            physicsLinearDamping:  obj.physicsLinearDamping ?? 0,
            physicsAngularDamping: obj.physicsAngularDamping ?? 0,
            physicsFixedRotation:  !!obj.physicsFixedRotation,
            physicsIsSensor:       !!obj.physicsIsSensor,
            physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
            physicsCollisionMask:     obj.physicsCollisionMask     ?? 0xFFFFFFFF,
            physicsShape:   obj.physicsShape   ?? 'box',
            physicsSize:    obj.physicsSize    ? JSON.parse(JSON.stringify(obj.physicsSize))    : null,
            physicsPolygon: obj.physicsPolygon ? JSON.parse(JSON.stringify(obj.physicsPolygon)) : null,
            physicsPolygons:obj.physicsPolygons? JSON.parse(JSON.stringify(obj.physicsPolygons)): null,
            _polyUnit:          obj._polyUnit || null,
            _collisionShapeInit: !!obj._collisionShapeInit,
            visible:     obj.visible !== false,
            alpha:       obj.alpha   ?? 1,
            scriptName:  obj.scriptName  ?? null,
            scriptTag:   obj._scriptTag  ?? null,
            scriptGroup: obj._scriptGroup ?? null,
        };
    });
}

/** Capture the active scene's live data into state.scenes[activeSceneIndex].snapshot */
function _flushActiveScene() {
    const idx   = state.activeSceneIndex;
    const scene = state.scenes[idx];
    if (!scene) return;
    scene.snapshot = {
        objects: _snapshotObjects(),
        camX:      state.sceneContainer?.x       ?? 0,
        camY:      state.sceneContainer?.y       ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1,
        camScaleY: state.sceneContainer?.scale.y ?? 1,
        audioSources: state.audioSources.map(s => ({
            id: s.id, assetId: s.assetId, label: s.label,
            x: s.x, y: s.y, range: s.range, volume: s.volume, loop: s.loop,
        })),
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
    };
}

/** Collect current UI layout state from the DOM. */
function _captureUIState() {
    const get = id => document.getElementById(id);
    return {
        gizmoMode:        state.gizmoMode,
        showGrid:         state.showGrid,
        showCollision:    state.showCollision,
        hierarchyWidth:   get('panel-hierarchy')?.style.width  || '',
        inspectorWidth:   get('panel-inspector')?.style.width  || '',
        bottomHeight:     get('panel-bottom')?.style.height    || '',
        // Which bottom tab is active
        activeBottomTab: (() => {
            const tabs = ['assets','scripts','prefabs','console','tileset'];
            for (const t of tabs) {
                const btn = get(`tab-${t}-btn`) || get(`btn-tab-${t}`);
                if (btn?.classList.contains('active')) return t;
            }
            return null;
        })(),
        // Panel visibility toggles
        hierarchyVisible: !(get('panel-hierarchy')?.classList.contains('hidden')),
        inspectorVisible: !(get('panel-inspector')?.classList.contains('hidden')),
        bottomVisible:    !(get('panel-bottom')?.classList.contains('hidden')),
    };
}

// ── Save ─────────────────────────────────────────────────────

async function _autoSave() {
    if (!_initialized) return;
    try {
        _flushActiveScene();

        // — Separate assets & tilesetBrushes (binary-heavy) into IDB —
        const assetsForIDB  = state.assets.map(a => ({ ...a }));         // includes dataURL
        const tilesForIDB   = state.tilesetBrushes.map(b => ({ ...b })); // includes tile dataURLs

        // Strip dataURLs from assets for LS copy (keeps LS small)
        const assetsLean = state.assets.map(({ id, name, type }) => ({ id, name, type }));

        // Build LS payload
        const payload = {
            version:      PERSIST_VER,
            savedAt:      Date.now(),
            assets:       assetsLean,          // no dataURLs
            prefabs:      state.prefabs,
            scripts:      state.scripts,
            scenes:       state.scenes,
            activeScene:  state.activeSceneIndex,
            sceneSettings: state.sceneSettings,
            ui:           _captureUIState(),
        };

        // Write LS (fast, small)
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(payload));
        } catch (e) {
            // LS quota — try without script code bodies as fallback
            console.warn('[persist] LS quota hit, trimming script bodies');
            const payloadThin = { ...payload, scripts: state.scripts.map(s => ({ ...s, code: '' })) };
            try { localStorage.setItem(LS_KEY, JSON.stringify(payloadThin)); } catch (_) {}
        }

        // Write IDB (async, large)
        await _idbPut(IDB_ASSET_KEY, assetsForIDB);
        await _idbPut(IDB_TILE_KEY,  tilesForIDB);

        _dirty = false;
        _logStatus('💾 Auto-saved');
    } catch (err) {
        console.error('[persist] save error', err);
    }
}

// ── Restore ──────────────────────────────────────────────────

async function _restore() {
    let payload;
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;              // nothing saved yet
        payload = JSON.parse(raw);
        if (!payload?.version) return;
    } catch { return; }

    // Restore large blobs from IDB
    const idbAssets = await _idbGet(IDB_ASSET_KEY);
    const idbTiles  = await _idbGet(IDB_TILE_KEY);

    // Merge: start with LS lean list, attach dataURLs from IDB
    if (idbAssets && Array.isArray(idbAssets)) {
        state.assets = idbAssets;
    } else if (payload.assets) {
        state.assets = payload.assets; // fallback (no dataURLs — images won't show)
    }

    state.tilesetBrushes  = (idbTiles && Array.isArray(idbTiles)) ? idbTiles : [];
    state.prefabs         = payload.prefabs   || [];
    state.scripts         = payload.scripts   || [];
    state.scenes          = payload.scenes    || [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    state.activeSceneIndex= payload.activeScene ?? 0;

    if (payload.sceneSettings) {
        state.sceneSettings = Object.assign(
            { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720,
              cameraPreset: 'landscape-desktop', scalingMode: 'fit',
              gravityX: 0, gravityY: 1 },
            payload.sceneSettings
        );
    }

    // Restore UI prefs — done after DOMContentLoaded so elements exist
    if (payload.ui) _scheduleUIRestore(payload.ui);

    _logStatus('📂 Session restored');
}

function _scheduleUIRestore(ui) {
    // Delay so the engine has finished building the DOM
    const apply = () => {
        const get = id => document.getElementById(id);

        // Gizmo mode
        if (ui.gizmoMode) {
            import('./engine.ui.js').then(m => m.setGizmoMode?.(ui.gizmoMode)).catch(()=>{});
        }

        // Grid / collision toggles
        if (ui.showGrid !== undefined) {
            import('./engine.renderer.js').then(m => m.setGridVisible?.(ui.showGrid)).catch(()=>{});
        }
        if (ui.showCollision !== undefined) {
            import('./engine.collision-overlay.js').then(m => m.setCollisionVisible?.(ui.showCollision)).catch(()=>{});
        }

        // Panel sizes
        if (ui.hierarchyWidth) {
            const p = get('panel-hierarchy');
            if (p) p.style.width = ui.hierarchyWidth;
        }
        if (ui.inspectorWidth) {
            const p = get('panel-inspector');
            if (p) p.style.width = ui.inspectorWidth;
        }
        if (ui.bottomHeight) {
            const p = get('panel-bottom');
            if (p) p.style.height = ui.bottomHeight;
        }

        // Panel visibility
        const setVisible = (id, vis) => {
            const el = get(id);
            if (!el) return;
            if (vis) el.classList.remove('hidden');
            else     el.classList.add('hidden');
        };
        if (ui.hierarchyVisible !== undefined) setVisible('panel-hierarchy', ui.hierarchyVisible);
        if (ui.inspectorVisible !== undefined) setVisible('panel-inspector', ui.inspectorVisible);
        if (ui.bottomVisible    !== undefined) setVisible('panel-bottom',    ui.bottomVisible);

        // Active bottom tab
        if (ui.activeBottomTab) {
            const tabIds = [
                `tab-${ui.activeBottomTab}-btn`,
                `btn-tab-${ui.activeBottomTab}`,
            ];
            for (const id of tabIds) {
                const btn = get(id);
                if (btn) { btn.click(); break; }
            }
        }
    };

    // Try after a short delay; engine init may not be done yet
    setTimeout(apply, 600);
}

// ── Status indicator ─────────────────────────────────────────

let _statusTimer = null;
function _logStatus(msg) {
    // Show in title bar or a status element if present
    const el = document.getElementById('persist-status');
    if (el) {
        el.textContent = msg;
        if (_statusTimer) clearTimeout(_statusTimer);
        _statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
    }
}

// ── beforeunload guard ───────────────────────────────────────

window.addEventListener('beforeunload', async () => {
    if (_dirty) {
        // Attempt a synchronous LS save at minimum (IDB is async so best-effort)
        try {
            _flushActiveScene();
            const assetsLean = state.assets.map(({ id, name, type }) => ({ id, name, type }));
            const payload = {
                version: PERSIST_VER, savedAt: Date.now(),
                assets: assetsLean, prefabs: state.prefabs,
                scripts: state.scripts, scenes: state.scenes,
                activeScene: state.activeSceneIndex,
                sceneSettings: state.sceneSettings,
                ui: _captureUIState(),
            };
            localStorage.setItem(LS_KEY, JSON.stringify(payload));
        } catch (_) {}
        // IDB writes fire but may not complete — the debounced save above
        // keeps IDB reasonably up-to-date during normal use.
        await _idbPut(IDB_ASSET_KEY, state.assets);
        await _idbPut(IDB_TILE_KEY,  state.tilesetBrushes);
    }
});
