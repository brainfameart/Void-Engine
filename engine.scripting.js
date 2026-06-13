import { markDirty } from './engine.persist.js';
/* ============================================================
   engine.scripting.js  —  ENTRY POINT (refactored)
   This file is intentionally small. It owns only the Script
   CRUD functions and the script-panel UI.  Everything else
   lives in the sub-modules imported below.

   Sub-module map:
     engine.scripting.shared.js   — shared state, camera, timers,
                                    message bus, error helpers
     engine.scripting.nav.js      — A* pathfinding + nav-tick
     engine.scripting.proxy.js    — _makeDeferredProxy / _makeProxy
     engine.scripting.sandbox.js  — _buildSandbox / _deepCopyObjectProps
     engine.scripting.runtime.js  — ScriptInstance, drag, joystick,
                                    input handlers, startScripts/stopScripts
     engine.scripting.sandbox-iframe.js — sandboxed iframe execution layer
                                    (blocks DOM access, localStorage, navigation)
     engine.scripting.linter.js     — live as-you-type error detection,
                                    red squiggles, error panel, runtime jump
   ============================================================ */

import { state } from './engine.state.js';
import {
    openScriptEditor, promptCreateScript, promptLoadScript,
} from './engine.scripting.editor.js';

// ── Re-export editor functions so index.html imports work ─────
export {
    openScriptEditor, promptCreateScript, promptLoadScript,
} from './engine.scripting.editor.js';

// ── Re-export runtime public API ──────────────────────────────
export {
    startScripts, stopScripts,
    _logConsolePublic,
    triggerCollision, triggerCollisionEnd, triggerCollisionStay,
    runScriptingApiTests,
} from './engine.scripting.runtime.js';

// ── Re-export shared public API ───────────────────────────────
import { getScript, saveScript } from './engine.scripting.shared.js';
export { clearSceneVars, clearGlobalVars, getScript, saveScript } from './engine.scripting.shared.js';

export async function loadScript(name) {
    return getScript(name);
}

export function refreshScriptUI(go) {
    if (!go) return;
    const badge  = document.getElementById('inspector-script-badge');
    const nameEl = document.getElementById('inspector-script-name');
    if (!badge || !nameEl) return;
    if (go.scriptName) {
        badge.style.display = 'block';
        nameEl.textContent  = go.scriptName + '.js';
    } else {
        badge.style.display = 'none';
        nameEl.textContent  = '—';
    }
}

export function deleteScriptByName(name) {
    const idx = state.scripts.findIndex(s => s.name === name);
    if (idx !== -1) state.scripts.splice(idx, 1);
    markDirty();
    refreshScriptPanel();
}

// ── Script Panel ──────────────────────────────────────────────
export function refreshScriptPanel() {
    const grid = document.getElementById('script-asset-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (state.scripts.length === 0) {
        const e = document.createElement('div');
        e.style.cssText = 'color:#505060;font-size:11px;padding:20px;text-align:center;width:100%;';
        e.textContent = 'No scripts yet';
        grid.appendChild(e);
        return;
    }

    const banner = document.createElement('div');
    banner.style.cssText = 'width:100%;padding:5px 10px;background:#080c12;border-bottom:1px solid #12192a;font-size:9px;color:#2a4a6a;line-height:1.6;';
    banner.innerHTML = '📎 <b style="color:#3a6a9a;">To use:</b> select a sprite → Inspector → Load Script';
    grid.appendChild(banner);

    const defaults    = state.scripts.filter(s => s.isDefault);
    const userScripts = state.scripts.filter(s => !s.isDefault);

    function addSection(label, color, bgColor, scripts) {
        if (!scripts.length) return;
        const hdr = document.createElement('div');
        hdr.style.cssText = `width:100%;padding:4px 10px;color:${color};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;background:${bgColor};border-bottom:1px solid ${color}22;`;
        hdr.textContent = label;
        grid.appendChild(hdr);
        for (const script of scripts) grid.appendChild(_makeScriptCard(script, script.isDefault));
    }

    addSection('⭐ Built-in Scripts', '#3a7a3a', '#060d06', defaults);
    addSection('📝 My Scripts',       '#2a5a8a', '#06080d', userScripts);
}

function _makeScriptCard(script, isDefault) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    item.style.cssText = 'cursor:pointer;position:relative;';
    const stroke = isDefault ? '#4ade80' : '#7cb9f0';
    const bg     = isDefault ? '#060d06' : '#06080d';
    const border = isDefault ? '#1a3a1a' : '#1a2a3a';
    item.innerHTML = `
        <div class="asset-thumb" style="background:${bg};border:1px solid ${border};position:relative;">
            <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:${stroke};stroke-width:1.5;">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            ${isDefault ? '<div style="position:absolute;bottom:1px;left:0;right:0;text-align:center;font-size:7px;color:#3a7a3a;font-weight:700;">BUILT-IN</div>' : ''}
        </div>
        <div class="asset-name" title="${script.name}.js">${script.name.length > 11 ? script.name.slice(0,10)+'…' : script.name}</div>
        ${!isDefault ? '<div class="script-del-btn" style="display:none;position:absolute;top:2px;right:2px;"><button style="background:rgba(24,6,6,.92);border:1px solid #3a1a1a;color:#f87171;border-radius:3px;padding:1px 4px;font-size:10px;cursor:pointer;">✕</button></div>' : ''}
    `;
    if (!isDefault) {
        item.addEventListener('mouseenter', () => item.querySelector('.script-del-btn').style.display = 'block');
        item.addEventListener('mouseleave', () => item.querySelector('.script-del-btn').style.display = 'none');
        item.querySelector('.script-del-btn button')?.addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`Delete script "${script.name}"?`)) deleteScriptByName(script.name);
        });
    }
    item.addEventListener('click', () => openScriptEditor(null, script.name, script.code ?? null));
    return item;
}
