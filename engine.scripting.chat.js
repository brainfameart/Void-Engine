/* ============================================================
   Zengine — engine.scripting.chat.js
   NPC chat dialog + AI-powered NPC conversation.

   Script API exposed to user scripts (via prelude injection):
     showChat(npcName, onInput, options)       — keyword-matching NPC dialog
     hideChat()                                — close the panel
     chatSay(text)                             — NPC speaks without waiting
     chatPlayer(text)                          — player line (cutscene use)
     aiChat(npcName, description, apiKey, opt) — AI-powered NPC (any OpenAI-compat API)
   ============================================================ */

// ── Chat DOM state ────────────────────────────────────────────
const _chatState = {
    el:           null,
    inputEl:      null,
    logEl:        null,
    sendBtn:      null,
    onSend:       null,   // keyword callback: (input) => string | null
    npcName:      '',
    aiMode:       false,
    aiHistory:    [],     // { role, content }[] — OpenAI multi-turn format
    aiSystem:     '',
    aiApiKey:     '',
    aiEndpoint:   '',
    aiModel:      '',
    aiTyping:     false,
    closeEnabled: true,   // whether the ✕ button closes the panel
};

// ── Build the chat panel DOM (once) ──────────────────────────
function _ensureChatEl() {
    if (_chatState.el) return;

    const panel = document.createElement('div');
    panel.id = '_ze_chat_panel';
    panel.style.cssText = `
        position: fixed;
        bottom: 80px; right: 20px;
        width: 320px;
        background: rgba(10,12,18,0.96);
        border: 1.5px solid #374151;
        border-radius: 14px;
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 13px;
        color: #f1f5f9;
        display: none;
        flex-direction: column;
        z-index: 100000;
        box-shadow: 0 12px 40px rgba(0,0,0,0.7);
        overflow: hidden;
    `;

    panel.innerHTML = `
        <div id="_ze_chat_header" style="padding:10px 14px;background:rgba(20,25,40,0.98);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1f2937;">
            <div style="display:flex;align-items:center;gap:8px;">
                <div id="_ze_chat_ai_badge" style="display:none;background:#1d4ed8;color:#bae6fd;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:.5px;">AI</div>
                <span id="_ze_chat_npc_name" style="font-weight:600;color:#e2e8f0;font-size:14px;">NPC</span>
            </div>
            <button id="_ze_chat_close" style="background:none;border:none;color:#6b7280;font-size:20px;cursor:pointer;padding:0;line-height:1;transition:color .15s;" onmouseover="this.style.color='#e2e8f0'" onmouseout="this.style.color='#6b7280'">✕</button>
        </div>
        <div id="_ze_chat_log" style="padding:10px 12px;min-height:90px;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#374151 transparent;"></div>
        <div id="_ze_chat_typing" style="display:none;padding:4px 14px;color:#6b7280;font-size:11px;font-style:italic;">typing…</div>
        <div style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #1f2937;background:rgba(15,18,28,0.9);">
            <input id="_ze_chat_input" type="text" placeholder="Type something…"
                style="flex:1;background:#111827;border:1px solid #374151;border-radius:8px;padding:7px 11px;color:#f1f5f9;font-size:13px;outline:none;transition:border-color .15s;"
                onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#374151'" />
            <button id="_ze_chat_send"
                style="background:#2563eb;border:none;border-radius:8px;color:#fff;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;transition:background .15s;"
                onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">Send</button>
        </div>
    `;

    document.body.appendChild(panel);
    _chatState.el      = panel;
    _chatState.inputEl = panel.querySelector('#_ze_chat_input');
    _chatState.logEl   = panel.querySelector('#_ze_chat_log');
    _chatState.sendBtn = panel.querySelector('#_ze_chat_send');

    panel.querySelector('#_ze_chat_close').onclick = () => {
        if (_chatState.closeEnabled !== false) _hideChat();
    };

    const doSend = () => {
        const raw = _chatState.inputEl.value.trim();
        if (!raw || _chatState.aiTyping) return;
        _chatState.inputEl.value = '';
        _addMsg(raw, 'player');

        if (_chatState.aiMode) {
            _sendToAI(raw);
        } else if (typeof _chatState.onSend === 'function') {
            try {
                const reply = _chatState.onSend(raw.toLowerCase());
                if (reply != null && reply !== '') {
                    setTimeout(() => _addMsg(String(reply), 'npc'), 350);
                }
            } catch (e) { console.error('[chat] onSend error:', e); }
        }
    };

    _chatState.sendBtn.onclick = doSend;
    _chatState.inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });
}

// ── Apply layout / behaviour options to the panel ─────────────
function _applyOptions(opts = {}) {
    const p = _chatState.el;
    if (!p) return;

    // ── Size ──────────────────────────────────────────────────
    if (opts.width != null) {
        p.style.width = typeof opts.width === 'number' ? opts.width + 'px' : opts.width;
    }

    // ── Position ──────────────────────────────────────────────
    // Vertical: bottom (default) or top
    if (opts.top != null) {
        p.style.top    = typeof opts.top === 'number' ? opts.top + 'px' : opts.top;
        p.style.bottom = 'auto';
    } else if (opts.bottom != null) {
        p.style.bottom = typeof opts.bottom === 'number' ? opts.bottom + 'px' : opts.bottom;
        p.style.top    = 'auto';
    }
    // Horizontal: right (default) or left
    if (opts.left != null) {
        p.style.left  = typeof opts.left === 'number' ? opts.left + 'px' : opts.left;
        p.style.right = 'auto';
    } else if (opts.right != null) {
        p.style.right = typeof opts.right === 'number' ? opts.right + 'px' : opts.right;
        p.style.left  = 'auto';
    }

    // ── Chat log height ────────────────────────────────────────
    const maxH = opts.height ?? opts.maxHeight;
    if (maxH != null && _chatState.logEl) {
        _chatState.logEl.style.maxHeight = typeof maxH === 'number' ? maxH + 'px' : maxH;
    }

    // ── Close button ──────────────────────────────────────────
    const closeBtn = p.querySelector('#_ze_chat_close');
    if (closeBtn) {
        if (opts.closeButton === false) {
            closeBtn.style.display = 'none';
            _chatState.closeEnabled = false;
        } else {
            closeBtn.style.display = '';
            _chatState.closeEnabled = true;
        }
    }
}

// ── Render a chat bubble ──────────────────────────────────────
function _addMsg(text, who) {
    if (!_chatState.logEl) return;
    const isNpc = who === 'npc';
    const row = document.createElement('div');
    row.style.cssText = `display:flex;justify-content:${isNpc ? 'flex-start' : 'flex-end'};`;
    const bubble = document.createElement('span');
    bubble.textContent = text;
    bubble.style.cssText = `
        background:${isNpc ? '#1e3a5f' : '#14532d'};
        color:${isNpc ? '#bae6fd' : '#bbf7d0'};
        border-radius:${isNpc ? '0 10px 10px 10px' : '10px 0 10px 10px'};
        padding:6px 11px;
        max-width:85%;
        font-size:13px;
        line-height:1.5;
        word-break:break-word;
        border:1px solid ${isNpc ? '#1d4ed8' : '#166534'};
    `;
    row.appendChild(bubble);
    _chatState.logEl.appendChild(row);
    _chatState.logEl.scrollTop = _chatState.logEl.scrollHeight;
}

// ── AI send — calls any OpenAI-compatible endpoint ────────────
async function _sendToAI(userText) {
    if (_chatState.aiTyping) return;
    _chatState.aiTyping = true;

    _chatState.aiHistory.push({ role: 'user', content: userText });

    const typingEl = _chatState.el?.querySelector('#_ze_chat_typing');
    if (typingEl) typingEl.style.display = 'block';
    if (_chatState.sendBtn) _chatState.sendBtn.disabled = true;
    if (_chatState.inputEl) _chatState.inputEl.disabled = true;

    const endpoint = _chatState.aiEndpoint
        || 'https://api.openai.com/v1/chat/completions';
    const model = _chatState.aiModel || 'gpt-4o-mini';
    const systemPrompt = _chatState.aiSystem
        || `You are ${_chatState.npcName}, an NPC in a video game. Reply in character in 1-3 short sentences. Be immersive and stay in character.`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${_chatState.aiApiKey}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: 300,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ..._chatState.aiHistory,
                ],
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content?.trim() ?? '';

        if (reply) {
            _chatState.aiHistory.push({ role: 'assistant', content: reply });
            // Keep history to last 20 turns to avoid token bloat
            if (_chatState.aiHistory.length > 20) {
                _chatState.aiHistory = _chatState.aiHistory.slice(-20);
            }
            _addMsg(reply, 'npc');
        }
    } catch (e) {
        console.error('[aiChat] API error:', e);
        _addMsg(`(${_chatState.npcName} seems distracted… check your API key and try again.)`, 'npc');
    } finally {
        _chatState.aiTyping = false;
        if (typingEl) typingEl.style.display = 'none';
        if (_chatState.sendBtn) _chatState.sendBtn.disabled = false;
        if (_chatState.inputEl) {
            _chatState.inputEl.disabled = false;
            _chatState.inputEl.focus();
        }
    }
}

// ── Public API (called from sandbox prelude) ──────────────────

/**
 * Open a keyword-matching NPC chat dialog.
 * onInput(text) → return the NPC reply string, or null for no reply.
 * options: { width, height, bottom, right, left, top, closeButton }
 */
export function _showChat(npcName, onInput, options = {}) {
    _ensureChatEl();
    _chatState.npcName      = npcName ?? 'NPC';
    _chatState.onSend       = onInput ?? null;
    _chatState.aiMode       = false;
    _chatState.aiHistory    = [];
    _chatState.aiSystem     = '';
    _chatState.aiApiKey     = '';
    _chatState.aiEndpoint   = '';
    _chatState.aiModel      = '';
    _chatState.aiTyping     = false;
    _chatState.closeEnabled = true;
    _chatState.el.querySelector('#_ze_chat_npc_name').textContent = _chatState.npcName;
    _chatState.el.querySelector('#_ze_chat_ai_badge').style.display = 'none';
    if (_chatState.logEl) _chatState.logEl.innerHTML = '';
    _applyOptions(options);
    _chatState.el.style.display = 'flex';
    setTimeout(() => _chatState.inputEl?.focus(), 50);
}

/**
 * Open an AI-powered NPC dialog using any OpenAI-compatible API.
 *
 * @param {string} npcName      — Name shown in the header
 * @param {string} description  — System / persona prompt
 * @param {string} apiKey       — API key (Bearer token)
 * @param {object} options      — {
 *   endpoint, model, badgeText,
 *   width, height, bottom, right, left, top, closeButton
 * }
 *
 * Example:
 *   aiChat("Wizard", "You are Aldric, a cryptic wizard.", "sk-...");
 *   aiChat("Bot", "Helpful assistant.", myKey, {
 *     model: "gpt-4o", badgeText: "GPT", width: 400, closeButton: false
 *   });
 */
export function _aiChat(npcName, description, apiKey, options = {}) {
    _ensureChatEl();
    _chatState.npcName      = npcName ?? 'NPC';
    _chatState.onSend       = null;
    _chatState.aiMode       = true;
    _chatState.aiHistory    = [];
    _chatState.aiSystem     = description ?? '';
    _chatState.aiApiKey     = apiKey ?? '';
    _chatState.aiEndpoint   = options.endpoint ?? '';
    _chatState.aiModel      = options.model ?? '';
    _chatState.aiTyping     = false;
    _chatState.closeEnabled = true;

    _chatState.el.querySelector('#_ze_chat_npc_name').textContent = _chatState.npcName;

    const badge = _chatState.el.querySelector('#_ze_chat_ai_badge');
    badge.textContent     = options.badgeText ?? 'AI';
    badge.style.display   = 'block';

    if (_chatState.logEl) _chatState.logEl.innerHTML = '';
    _applyOptions(options);
    _chatState.el.style.display = 'flex';
    setTimeout(() => _chatState.inputEl?.focus(), 50);
}

/** Close the chat dialog. */
export function _hideChat() {
    if (_chatState.el) _chatState.el.style.display = 'none';
    _chatState.aiMode       = false;
    _chatState.aiHistory    = [];
    _chatState.aiTyping     = false;
    _chatState.closeEnabled = true;
}

/** Add an NPC line without waiting for input (opening line, cutscene). */
export function _chatSay(text)    { _ensureChatEl(); _addMsg(String(text), 'npc'); }

/** Add a player line (cutscene / auto-dialog). */
export function _chatPlayer(text) { _ensureChatEl(); _addMsg(String(text), 'player'); }

/** Hide chat when play mode stops. */
export function stopChat() { _hideChat(); }

// ── Register on window._ze so new Function() sandboxes can reach them ────────
window._ze = window._ze || {};
window._ze.showChat   = _showChat;
window._ze.hideChat   = _hideChat;
window._ze.chatSay    = _chatSay;
window._ze.chatPlayer = _chatPlayer;
window._ze.aiChat     = _aiChat;
window._ze.stopChat   = stopChat;
