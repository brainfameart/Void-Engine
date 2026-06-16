/* ============================================================
   Void Engine — engine.project.js  v1.2
   Save / Load entire project as a .zen file.

   A .zen file is a ZIP archive (renamed .zen) containing:
     manifest.json        ← engine version, metadata, counts
     scene_N.json         ← one file per scene (ALL object data)
     assets.json          ← asset manifest (id, name, type, file refs)
     assets/              ← asset binaries extracted from dataURLs
     prefabs.json         ← all prefab definitions
     scripts.json         ← all user scripts with source code
     brushes.json         ← tileset brush definitions (tile refs, not dataURLs)
     brushes/             ← brush tile images extracted from dataURLs

   Everything needed to reconstruct the exact scene on another
   computer with zero cloud dependency.
   ============================================================ */

import { state } from './engine.state.js';
import { markDirty, clearPersisted } from './engine.persist.js';

export const ENGINE_VERSION = '1.0';

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

export async function saveProject() {
    _saveActiveScene();

    const projectName = (state.projectName ?? 'VoidProject')
        .replace(/[^a-zA-Z0-9_\- ]/g, '_');

    try {
        const zip  = await _buildZenArchive(projectName);
        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
        });
        _downloadBlob(blob, `${projectName}.zen`);
        _logConsole(`💾 Project saved as "${projectName}.zen"`, '#4ade80');
    } catch (err) {
        _logConsole(`❌ Save failed: ${err.message}`, '#f87171');
        console.error('[ZenSave]', err);
    }
}

export function loadProject() {
    const input  = document.createElement('input');
    input.type   = 'file';
    input.accept = '.zen,.zip';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const JSZip   = await _loadJSZip();
            const archive = await JSZip.loadAsync(file);

            // ── Manifest ─────────────────────────────────────
            const manifestEntry = archive.file('manifest.json');
            if (!manifestEntry) {
                alert('Not a valid Void Engine project (.zen) — manifest.json missing.');
                return;
            }
            const manifest = JSON.parse(await manifestEntry.async('string'));

            // ── Version warning ───────────────────────────────
            if (manifest.engineVersion && manifest.engineVersion !== ENGINE_VERSION) {
                const savedOlder = _versionOlder(manifest.engineVersion, ENGINE_VERSION);
                const msg = savedOlder
                    ? `⚠️ Version mismatch\n\nSaved with v${manifest.engineVersion}, you have v${ENGINE_VERSION} (newer).\nSome features added after v${manifest.engineVersion} may be missing.\n\nContinue?`
                    : `⚠️ Version mismatch\n\nSaved with v${manifest.engineVersion}, you have v${ENGINE_VERSION} (older).\nFeatures in this project may not exist yet — things may break.\n\nContinue?`;
                if (!confirm(msg)) return;
            }

            // ── Restore assets ────────────────────────────────
            const assetsManifest = JSON.parse(await archive.file('assets.json').async('string'));
            for (const asset of assetsManifest) {
                const entry = archive.file(`assets/${asset.fileName}`);
                if (entry) asset.dataURL = `data:${asset.mime};base64,${await entry.async('base64')}`;
            }

            // ── Restore brush tiles ───────────────────────────
            const brushesManifest = JSON.parse(await archive.file('brushes.json').async('string'));
            for (const brush of brushesManifest) {
                brush.tiles = await Promise.all(brush.tileRefs.map(async (ref) => {
                    if (!ref) return null;
                    const entry = archive.file(`brushes/${ref}`);
                    if (!entry) return null;
                    return `data:image/png;base64,${await entry.async('base64')}`;
                }));
                delete brush.tileRefs; // clean up
            }

            // ── Prefabs & scripts ─────────────────────────────
            const prefabs = JSON.parse(await archive.file('prefabs.json').async('string'));
            const scripts = JSON.parse(await archive.file('scripts.json').async('string'));

            // ── Scenes ────────────────────────────────────────
            const scenes = [];
            for (let i = 0; i < manifest.sceneCount; i++) {
                const entry = archive.file(`scene_${i}.json`);
                if (entry) scenes.push(JSON.parse(await entry.async('string')));
            }

            _applyProject({
                engineVersion:  manifest.engineVersion,
                name:           manifest.projectName,
                assets:         assetsManifest,
                tilesetBrushes: brushesManifest,
                prefabs,
                scripts,
                scenes,
                activeScene:    manifest.activeSceneIndex ?? 0,
            });

            _logConsole(
                `📂 Loaded "${manifest.projectName}" (Void Engine v${manifest.engineVersion ?? '?'})`,
                '#4ade80'
            );
        } catch (err) {
            alert('Failed to load .zen project:\n' + err.message);
            console.error('[ZenLoad]', err);
        }
    };

    input.click();
}

export function newProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;

    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;
    state.assets         = [];
    state.tilesetBrushes = [];
    state.prefabs        = [];
    state.scripts        = [];
    state.scenes         = [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];

    import('./engine.defaultscripts.js').then(m => {
        m.injectDefaultScripts(state.scripts);
        import('./engine.scripting.js').then(s => s.refreshScriptPanel());
    });

    state.activeSceneIndex = 0;
    import('./engine.audio.js').then(m => m.clearAudioSources());

    state.sceneSettings = {
        bgColor: 0x282828, gameWidth: 1280, gameHeight: 720,
        cameraPreset: 'landscape-desktop', scalingMode: 'fit',
        gravityX: 0, gravityY: 1,
    };
    if (state.app?.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;

    import('./engine.renderer.js').then(m => m.drawGrid());
    import('./engine.ui.js').then(m => {
        m.syncPixiToInspector();
        m.refreshHierarchy();
        m.refreshAssetPanel();
        m.refreshPrefabPanel();
    });
    import('./engine.scripting.js').then(m => m.refreshScriptPanel());
    import('./engine.scenes.js').then(m => m.initScenes());
    _logConsole('🆕 New project created', '#9bc');
    clearPersisted();
    markDirty();
}

// ─────────────────────────────────────────────────────────────
// BUILD .zen ARCHIVE
// ─────────────────────────────────────────────────────────────

async function _buildZenArchive(projectName) {
    const JSZip = await _loadJSZip();
    const zip   = new JSZip();

    // ── Assets → assets/ folder ───────────────────────────────
    const assetsFolder   = zip.folder('assets');
    const assetManifest  = [];

    for (const asset of (state.assets ?? [])) {
        if (!asset.dataURL) continue;
        try {
            const commaIdx = asset.dataURL.indexOf(',');
            if (commaIdx === -1) continue;
            const header    = asset.dataURL.slice(0, commaIdx);
            const b64       = asset.dataURL.slice(commaIdx + 1);
            const mime      = (header.match(/data:([^;]+)/) ?? [])[1] ?? 'application/octet-stream';
            const ext       = _mimeToExt(mime);
            const safeName  = asset.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
            const fileName  = safeName.includes('.') ? safeName : `${safeName}.${ext}`;

            assetsFolder.file(fileName, b64, { base64: true });
            assetManifest.push({ id: asset.id, name: asset.name, type: asset.type, mime, fileName });
        } catch (_) {}
    }

    // ── Tileset brushes → brushes/ folder ────────────────────
    // Brush tiles are dataURLs — extract them as separate files so
    // manifest.json doesn't bloat to megabytes with many brushes.
    const brushesFolder  = zip.folder('brushes');
    const brushManifest  = [];

    for (const brush of (state.tilesetBrushes ?? [])) {
        const tileRefs = [];
        for (let slot = 0; slot < (brush.tiles?.length ?? 0); slot++) {
            const dataURL = brush.tiles[slot];
            if (!dataURL) { tileRefs.push(null); continue; }
            try {
                const commaIdx = dataURL.indexOf(',');
                const b64      = commaIdx !== -1 ? dataURL.slice(commaIdx + 1) : dataURL;
                const fileName = `${brush.id}_slot${slot}.png`;
                brushesFolder.file(fileName, b64, { base64: true });
                tileRefs.push(fileName);
            } catch (_) { tileRefs.push(null); }
        }
        brushManifest.push({
            id:   brush.id,
            name: brush.name,
            type: brush.type ?? '16-tile',
            tileW: brush.tileW,
            tileH: brush.tileH,
            tileRefs,   // file refs, not dataURLs
        });
    }

    // ── Scenes → scene_N.json ─────────────────────────────────
    const scenes = state.scenes ?? [];
    for (let i = 0; i < scenes.length; i++) {
        zip.file(`scene_${i}.json`, JSON.stringify({
            id:       scenes[i].id,
            name:     scenes[i].name,
            snapshot: scenes[i].snapshot ?? null,
        }, null, 2));
    }

    // ── Manifests ─────────────────────────────────────────────
    zip.file('assets.json',  JSON.stringify(assetManifest,      null, 2));
    zip.file('brushes.json', JSON.stringify(brushManifest,      null, 2));
    zip.file('prefabs.json', JSON.stringify(state.prefabs ?? [], null, 2));
    zip.file('scripts.json', JSON.stringify(state.scripts ?? [], null, 2));

    zip.file('manifest.json', JSON.stringify({
        engineVersion:    ENGINE_VERSION,
        projectVersion:   1,
        projectName,
        savedAt:          new Date().toISOString(),
        sceneCount:       scenes.length,
        activeSceneIndex: state.activeSceneIndex ?? 0,
        assetCount:       assetManifest.length,
        brushCount:       brushManifest.length,
        prefabCount:      (state.prefabs ?? []).length,
        scriptCount:      (state.scripts ?? []).length,
    }, null, 2));

    // ── Readme ────────────────────────────────────────────────
    zip.file('README.txt', [
        `Void Engine Project — "${projectName}"`,
        '='.repeat(50),
        `Saved with Void Engine v${ENGINE_VERSION}`,
        `Date: ${new Date().toLocaleString()}`,
        '',
        'Rename to .zip to inspect contents.',
        '',
        'CONTENTS:',
        '  manifest.json      Version, metadata',
        `  scene_0..N.json    ${scenes.length} scene(s) — objects, physics, scripts, camera`,
        '  assets.json        Asset manifest',
        '  assets/            Images and audio',
        '  brushes.json       Auto-tile brush definitions',
        '  brushes/           Brush tile images',
        '  prefabs.json       Prefab definitions',
        '  scripts.json       User scripts with source code',
        '',
        'Load via: Void Engine → File → Load Project (.zen)…',
    ].join('\n'));

    return zip;
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOT ACTIVE SCENE
// Must stay in sync with _saveCurrentScene() in engine.scenes.js
// ─────────────────────────────────────────────────────────────

function _saveActiveScene() {
    const scene = state.scenes[state.activeSceneIndex];
    if (!scene) return;

    scene.snapshot = {
        objects: state.gameObjects.map(obj => {
            if (obj.isLight) {
                return {
                    isLight: true, lightType: obj.lightType,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    visible: obj.visible !== false, alpha: obj.alpha ?? 1,
                    lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
                };
            }
            if (obj.isTilemap) {
                return {
                    isTilemap: true,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
                };
            }
            if (obj.isAutoTilemap) {
                const td = obj.autoTileData;
                return {
                    isAutoTilemap: true,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    autoTileData: {
                        ...td,
                        cells:          Array.from(td.cells),
                        brushList:      td.brushList.slice(),
                        activeBrushIds: (td.activeBrushIds || []).slice(),
                    },
                };
            }
            if (obj.isText) {
                return {
                    isText: true,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    scaleX: obj.scale.x, scaleY: obj.scale.y, rotation: obj.rotation,
                    textContent:  obj.textContent  ?? '',
                    textStyle:    JSON.parse(JSON.stringify(obj.textStyle ?? {})),
                    visible:      obj.visible !== false,
                    alpha:        obj.alpha ?? 1,
                    scriptName:   obj.scriptName   ?? null,
                    scriptTag:    obj._scriptTag   ?? null,
                    scriptGroup:  obj._scriptGroup ?? null,
                };
            }
            // Sprite / image
            return {
                label:   obj.label,
                isImage: obj.isImage,
                assetId: obj.assetId,
                prefabId: obj.prefabId || null,
                x: obj.x, y: obj.y,
                scaleX: obj.scale.x, scaleY: obj.scale.y,
                rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                animations:      obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
                // Physics
                physicsBody:              obj.physicsBody              ?? 'none',
                physicsFriction:          obj.physicsFriction          ?? 0.3,
                physicsRestitution:       obj.physicsRestitution       ?? 0.1,
                physicsDensity:           obj.physicsDensity           ?? 0.001,
                physicsGravityScale:      obj.physicsGravityScale      ?? 1,
                physicsLinearDamping:     obj.physicsLinearDamping     ?? 0,
                physicsAngularDamping:    obj.physicsAngularDamping    ?? 0,
                physicsFixedRotation:     !!obj.physicsFixedRotation,
                physicsIsSensor:          !!obj.physicsIsSensor,
                physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
                physicsCollisionMask:     obj.physicsCollisionMask     ?? 0xFFFFFFFF,
                physicsShape:             obj.physicsShape             ?? 'box',
                physicsSize:     obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
                physicsPolygon:  obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
                physicsPolygons: obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
                _polyUnit:           obj._polyUnit          || null,
                _collisionShapeInit: !!obj._collisionShapeInit,
                // Visibility
                visible: obj.visible !== false,
                alpha:   obj.alpha   ?? 1,
                // Script
                scriptName:  obj.scriptName   ?? null,
                scriptTag:   obj._scriptTag   ?? null,
                scriptGroup: obj._scriptGroup ?? null,
            };
        }),
        camX:      state.sceneContainer?.x        ?? 0,
        camY:      state.sceneContainer?.y        ?? 0,
        camScaleX: state.sceneContainer?.scale.x  ?? 1,
        camScaleY: state.sceneContainer?.scale.y  ?? 1,
        audioSources: (state.audioSources ?? []).map(s => ({
            id: s.id, assetId: s.assetId, label: s.label,
            x: s.x, y: s.y, range: s.range, volume: s.volume, loop: s.loop,
        })),
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
    };
}

// ─────────────────────────────────────────────────────────────
// APPLY LOADED PROJECT
// ─────────────────────────────────────────────────────────────

function _applyProject(project) {
    if (!project.scenes?.length) {
        alert('Invalid .zen file — no scenes found.');
        return;
    }

    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;

    import('./engine.audio.js').then(m => m.clearAudioSources());

    // Restore everything BEFORE initScenes() so _loadScene can find assets/brushes
    state.assets         = project.assets         || [];
    state.tilesetBrushes = project.tilesetBrushes || [];
    state.prefabs        = project.prefabs        || [];
    state.scripts        = project.scripts        || [];
    if (project.name) state.projectName = project.name;

    const _afterScripts = () => {
        state.scenes           = project.scenes;
        state.activeSceneIndex = project.activeScene ?? 0;

        import('./engine.scenes.js').then(m => {
            m.initScenes();
            if ((project.activeScene ?? 0) > 0) m.switchToScene(project.activeScene);
        });
        import('./engine.ui.js').then(m => {
            m.refreshAssetPanel();
            m.refreshPrefabPanel();
        });
        import('./engine.scripting.js').then(m => m.refreshScriptPanel());
    };

    if (state.scripts.length === 0) {
        import('./engine.defaultscripts.js').then(m => {
            m.injectDefaultScripts(state.scripts);
            _afterScripts();
        });
    } else {
        _afterScripts();
    }

    markDirty();
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

async function _loadJSZip() {
    if (window.JSZip) return window.JSZip;
    await new Promise((resolve, reject) => {
        const s  = document.createElement('script');
        s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Could not load JSZip. Check your internet connection.'));
        document.head.appendChild(s);
    });
    return window.JSZip;
}

function _versionOlder(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0, nb = pb[i] ?? 0;
        if (na < nb) return true;
        if (na > nb) return false;
    }
    return false;
}

function _downloadBlob(blob, filename) {
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function _mimeToExt(mime) {
    return {
        'image/png':'png','image/jpeg':'jpg','image/gif':'gif',
        'image/webp':'webp','image/svg+xml':'svg',
        'audio/mpeg':'mp3','audio/ogg':'ogg','audio/wav':'wav','audio/mp4':'m4a',
    }[mime] ?? 'bin';
}

function _logConsole(msg, color = '#e0e0e0') {
    const el = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!el) return;
    const d = document.createElement('div');
    d.style.color = color; d.textContent = msg;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
}
