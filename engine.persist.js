/* ============================================================
   Zengine — engine.persist.js
   Auto-saves ALL project state to IndexedDB (no size limit).
   localStorage is used ONLY as a tiny fallback index so the
   engine can detect a saved session on cold start without
   reading the full IDB payload first.

   Storage layout (IndexedDB — "ZengineDB", store "blobs"):
     "project"       — scenes, scripts, prefabs, ui, settings
     "assets"        — asset list with full dataURLs
     "tilesetBrushes"— tileset brush tiles with dataURLs

   No sign-up, no server, works offline, ~unlimited storage.
   Auto-save fires ~2 s after any change (debounced).
   On beforeunload: immediate synchronous IDB flush attempted.
   ============================================================ */

import { state } from './engine.state.js';

// ── Constants ────────────────────────────────────────────────
const LS_SENTINEL   = 'zengine_has_session'; // just a flag, no data
const IDB_DB_NAME   = 'ZengineDB';
const IDB_STORE     = 'blobs';
const IDB_PROJECT   = 'project';
const IDB_ASSET_KEY = 'assets';
const IDB_TILE_KEY  = 'tilesetBrushes';
const PERSIST_VER   = 3;
const DEBOUNCE_MS   = 2000;

// ── Internal state ───────────────────────────────────────────
let _db          = null;
let _saveTimer   = null;
let _dirty       = false;
let _initialized = false;

// ── Public API ───────────────────────────────────────────────

export async function initPersist() {
    if (_initialized) return;
    _initialized = true;
    _db = await _openDB();
    await _restore();
}

export function markDirty() {
    _dirty = true;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_autoSave, DEBOUNCE_MS);
}

export async function flushSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    await _autoSave();
}

export async function clearPersisted() {
    try { localStorage.removeItem(LS_SENTINEL); } catch (_) {}
    await _idbPut(IDB_PROJECT,   null);
    await _idbPut(IDB_ASSET_KEY, []);
    await _idbPut(IDB_TILE_KEY,  []);
}

// ── IndexedDB helpers ────────────────────────────────────────

function _openDB() {
    return new Promise((resolve) => {
        const req = indexedDB.open(IDB_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => {
            console.warn('[persist] IDB open failed — saves disabled', e);
            resolve(null);
        };
    });
}

function _idbPut(key, value) {
    return new Promise((resolve) => {
        if (!_db) { resolve(false); return; }
        try {
            const tx  = _db.transaction(IDB_STORE, 'readwrite');
            const req = tx.objectStore(IDB_STORE).put(value, key);
            req.onsuccess = () => resolve(true);
            req.onerror   = (e) => {
                console.warn('[persist] IDB put error', key, e);
                resolve(false);
            };
        } catch (e) {
            console.warn('[persist] IDB tx error', e);
            resolve(false);
        }
    });
}

function _idbGet(key) {
    return new Promise((resolve) => {
        if (!_db) { resolve(null); return; }
        try {
            const tx  = _db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = (e) => resolve(e.target.result ?? null);
            req.onerror   = () => resolve(null);
        } catch { resolve(null); }
    });
}

// ── Snapshot helpers ─────────────────────────────────────────

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
            animations:       obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
            activeAnimIndex:  obj.activeAnimIndex || 0,
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
            physicsShape:    obj.physicsShape   ?? 'box',
            physicsSize:     obj.physicsSize    ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
            physicsPolygon:  obj.physicsPolygon ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
            physicsPolygons: obj.physicsPolygons? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
            _polyUnit:           obj._polyUnit || null,
            _collisionShapeInit: !!obj._collisionShapeInit,
            visible:     obj.visible !== false,
            alpha:       obj.alpha   ?? 1,
            scriptName:  obj.scriptName  ?? null,
            scriptTag:   obj._scriptTag  ?? null,
            scriptGroup: obj._scriptGroup ?? null,
        };
    });
}

function _flushActiveScene() {
    const scene = state.scenes[state.activeSceneIndex];
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

function _captureUIState() {
    const get = id => document.getElementById(id);
    return {
        gizmoMode:     state.gizmoMode,
        showGrid:      state.showGrid,
        showCollision: state.showCollision,
        hierarchyWidth:  get('panel-hierarchy')?.style.width  || '',
        inspectorWidth:  get('panel-inspector')?.style.width  || '',
        bottomHeight:    get('panel-bottom')?.style.height    || '',
        activeBottomTab: (() => {
            for (const t of ['assets','scripts','prefabs','console','tileset']) {
                const btn = get(`tab-${t}-btn`) || get(`btn-tab-${t}`);
                if (btn?.classList.contains('active')) return t;
            }
            return null;
        })(),
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

        const projectPayload = {
            version:      PERSIST_VER,
            savedAt:      Date.now(),
            prefabs:      state.prefabs,
            scripts:      state.scripts,
            scenes:       state.scenes,
            activeScene:  state.activeSceneIndex,
            sceneSettings: state.sceneSettings,
            ui:           _captureUIState(),
        };

        // Write everything to IDB — no size limit
        const [ok1, ok2, ok3] = await Promise.all([
            _idbPut(IDB_PROJECT,   projectPayload),
            _idbPut(IDB_ASSET_KEY, state.assets),
            _idbPut(IDB_TILE_KEY,  state.tilesetBrushes),
        ]);

        if (ok1 && ok2 && ok3) {
            // Leave a tiny sentinel in localStorage so _restore() knows IDB has data
            try { localStorage.setItem(LS_SENTINEL, '1'); } catch (_) {}
            _dirty = false;
            _logStatus('💾 Auto-saved');
        } else {
            console.warn('[persist] One or more IDB writes failed');
            _logStatus('⚠️ Save failed');
        }
    } catch (err) {
        console.error('[persist] save error', err);
        _logStatus('⚠️ Save error');
    }
}

// ── Restore ──────────────────────────────────────────────────

async function _restore() {
    // Check sentinel first — if it's missing there's nothing saved yet
    // (Also attempt restore even without sentinel in case LS was cleared but IDB still has data)
    const [project, idbAssets, idbTiles] = await Promise.all([
        _idbGet(IDB_PROJECT),
        _idbGet(IDB_ASSET_KEY),
        _idbGet(IDB_TILE_KEY),
    ]);

    // Nothing in IDB — also try legacy localStorage key for backward compat
    if (!project) {
        await _tryMigrateLegacyLS();
        return;
    }

    if (idbAssets && Array.isArray(idbAssets)) state.assets = idbAssets;
    state.tilesetBrushes   = (idbTiles && Array.isArray(idbTiles)) ? idbTiles : [];
    state.prefabs          = project.prefabs    || [];
    state.scripts          = project.scripts    || [];
    state.scenes           = project.scenes     || [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    state.activeSceneIndex = project.activeScene ?? 0;

    if (project.sceneSettings) {
        state.sceneSettings = Object.assign(
            { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720,
              cameraPreset: 'landscape-desktop', scalingMode: 'fit',
              gravityX: 0, gravityY: 1 },
            project.sceneSettings
        );
    }

    if (project.ui) _scheduleUIRestore(project.ui);
    _logStatus('📂 Session restored');
}

// Migrate old localStorage saves (version 1 & 2) into IDB on first run
async function _tryMigrateLegacyLS() {
    let raw;
    try { raw = localStorage.getItem('zengine_project'); } catch (_) { return; }
    if (!raw) return;

    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return; }
    if (!payload?.version) return;

    console.log('[persist] Migrating legacy localStorage save to IndexedDB…');

    // Legacy: assets might be inline in LS, or in IDB under old key
    const idbAssets = await _idbGet(IDB_ASSET_KEY) || payload.assets || [];
    const idbTiles  = await _idbGet(IDB_TILE_KEY)  || [];

    state.assets          = idbAssets;
    state.tilesetBrushes  = idbTiles;
    state.prefabs         = payload.prefabs    || [];
    state.scripts         = payload.scripts    || [];
    state.scenes          = payload.scenes     || [];
    state.activeSceneIndex= payload.activeScene ?? 0;
    if (payload.sceneSettings) state.sceneSettings = payload.sceneSettings;
    if (payload.ui) _scheduleUIRestore(payload.ui);

    // Immediately re-save to IDB and remove old LS key
    await _autoSave();
    try { localStorage.removeItem('zengine_project'); } catch (_) {}

    _logStatus('📂 Session migrated & restored');
}

function _scheduleUIRestore(ui) {
    const apply = () => {
        const get = id => document.getElementById(id);

        if (ui.gizmoMode) {
            import('./engine.ui.js').then(m => m.setGizmoMode?.(ui.gizmoMode)).catch(()=>{});
        }
        if (ui.showGrid !== undefined) {
            import('./engine.renderer.js').then(m => m.setGridVisible?.(ui.showGrid)).catch(()=>{});
        }
        if (ui.showCollision !== undefined) {
            import('./engine.collision-overlay.js').then(m => m.setCollisionVisible?.(ui.showCollision)).catch(()=>{});
        }

        if (ui.hierarchyWidth) { const p = get('panel-hierarchy'); if (p) p.style.width = ui.hierarchyWidth; }
        if (ui.inspectorWidth) { const p = get('panel-inspector'); if (p) p.style.width = ui.inspectorWidth; }
        if (ui.bottomHeight)   { const p = get('panel-bottom');    if (p) p.style.height = ui.bottomHeight;  }

        const setVisible = (id, vis) => {
            const el = get(id);
            if (!el) return;
            if (vis) el.classList.remove('hidden');
            else     el.classList.add('hidden');
        };
        if (ui.hierarchyVisible !== undefined) setVisible('panel-hierarchy', ui.hierarchyVisible);
        if (ui.inspectorVisible !== undefined) setVisible('panel-inspector', ui.inspectorVisible);
        if (ui.bottomVisible    !== undefined) setVisible('panel-bottom',    ui.bottomVisible);

        if (ui.activeBottomTab) {
            for (const id of [`tab-${ui.activeBottomTab}-btn`, `btn-tab-${ui.activeBottomTab}`]) {
                const btn = get(id);
                if (btn) { btn.click(); break; }
            }
        }
    };
    setTimeout(apply, 600);
}

// ── Status indicator ─────────────────────────────────────────

let _statusTimer = null;
function _logStatus(msg) {
    const el = document.getElementById('persist-status');
    if (el) {
        el.textContent = msg;
        if (_statusTimer) clearTimeout(_statusTimer);
        _statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
    }
}

// ── beforeunload — best-effort final flush ───────────────────

window.addEventListener('beforeunload', () => {
    if (!_dirty) return;
    // IDB writes are async but fire-and-forget here — the debounced
    // save during normal editing keeps IDB up-to-date, so this is
    // just a last-resort attempt for unsaved changes in the last 2s.
    _flushActiveScene();
    _idbPut(IDB_PROJECT,   {
        version: PERSIST_VER, savedAt: Date.now(),
        prefabs: state.prefabs, scripts: state.scripts,
        scenes: state.scenes, activeScene: state.activeSceneIndex,
        sceneSettings: state.sceneSettings, ui: _captureUIState(),
    });
    _idbPut(IDB_ASSET_KEY, state.assets);
    _idbPut(IDB_TILE_KEY,  state.tilesetBrushes);
    try { localStorage.setItem(LS_SENTINEL, '1'); } catch (_) {}
});
