/* ============================================================
   engine.scripting.sandbox.js
   _buildSandbox        — builds the full scripting API object
                          injected into user scripts as `this`
   _deepCopyObjectProps — copies designer properties when
                          spawning/cloning objects
   ============================================================ */

import { state } from './engine.state.js';
import {
    navCanSee, navInFOV, navGetLastKnownPos, navIsStuck,
} from './pathfindlogic.js';
import {
    _logConsole, _instances,
    _sceneVars, _globalVars,
    _tagRegistry, _groupRegistry,
    _debugLines, _isOverlapping,
    _nextRepeatId, _scriptFnCache,
    _friendlyScriptError,
    _newScriptInstance,
    getScript,
    _registerInstance,
    _scheduleTimer,
    _sendMessageToTag, _broadcastToTag, _broadcastToGroup, _broadcastGlobal,
    _camera,
} from './engine.scripting.shared.js';
import { _makeDeferredProxy, _makeProxy } from './engine.scripting.proxy.js';
import {
    _navStartWalk, _navStartFollow, _navStop,
    _navStartFlee, _navStartWander,
} from './engine.scripting.nav.js';

function _buildSandbox(obj, instRef) {
    const _keys         = new Set();
    const _keysJustDown = new Set();
    const _keysJustUp   = new Set();
    const _mouse        = { x: 0, y: 0, screenX: 0, screenY: 0, down: false, justDown: false, justUp: false };

    // Per-object velocity — integrated each frame.
    // Seeded from _spawnVx/_spawnVy when set by a spawnObject callback BEFORE this
    // ScriptInstance is constructed, so bullets/clones start moving immediately.
    const _vel = { x: obj._spawnVx ?? 0, y: obj._spawnVy ?? 0 };
    // Per-sandbox tween queue, repeat timers, key handlers, and forever callbacks
    const _tweens          = [];
    const _repeats         = [];
    const _foreverCbs      = [];  // callbacks registered via forever()
    const _keyDownHandlers = new Map();
    const _keyUpHandlers   = new Map();
    // Hammer.js gesture handlers
    const _swipeHandlers      = new Map(); // direction → fn
    let   _pinchHandler       = null;  // fn(scale)  — raw Hammer scale (1.0 = start)
    let   _pinchInHandler     = null;  // fn(scale)  — fingers spreading apart (zoom in)
    let   _pinchOutHandler    = null;  // fn(scale)  — fingers closing together (zoom out)
    let   _tapHandler         = null;  // fn()
    let   _doubleTapHandler   = null;  // fn()
    let   _longPressHandler   = null;  // fn()
    let   _rotateHandler      = null;  // fn(degrees) — two-finger rotation delta
    const _multiSwipeHandlers = new Map(); // direction → fn  (two-finger swipe)
    let   _touchStartHandler  = null;  // fn(touches)
    let   _touchEndHandler    = null;  // fn(touches)
    let   _tiltHandler        = null;  // fn(tiltX, tiltY) — device gyro
    let   _lastTiltX          = 0;
    let   _lastTiltY          = 0;
    let   _lastPinchScale     = 1; // tracks prev scale so we can derive pinchIn/pinchOut direction
    // Cache for drawText() calls — keyed by id so onUpdate calls update existing
    // nodes instead of creating duplicates every frame.
    const _drawTextCache   = new Map();

    const api = {

        // ── IDENTITY ─────────────────────────────────────────
        /** This object's name/label */
        get name()  { return obj.label; },

        /** This object's tag (used for messaging and findWithTag) */
        get tag()   { return obj._scriptTag  ?? ''; },
        set tag(v)  { obj._scriptTag = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        /** This object's group */
        get group() { return obj._scriptGroup ?? ''; },
        set group(v){ obj._scriptGroup = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        // ── POSITION — this.x, this.y ─────────────────────────
        /** World X position of this object */
        get x()  { return  obj.x  / 100; },
        set x(v) {
            if (obj.physicsImmovable) return;
            obj.x = v * 100;
            // For kinematic bodies: a direct x= write is a teleport-style move.
            // Reset prevX so stepPhysics picks it up as a delta from the NEW position
            // and doesn't double-apply it alongside velocity.
            if (obj.physicsBody === 'kinematic') obj._kinematicPrevX = obj.x;
        },
        /** World Y position of this object */
        get y()  { return -obj.y  / 100; },
        set y(v) {
            if (obj.physicsImmovable) return;
            obj.y = -v * 100;
            if (obj.physicsBody === 'kinematic') obj._kinematicPrevY = obj.y;
        },

        // ── VELOCITY ─────────────────────────────────────────
        // For dynamic bodies, the getter reads the ACTUAL physics body velocity
        // (converted back to world units/sec, +Y=up) so that console.log(velocityY)
        // and `if (isOnGround()) velocityY = 0` always see the real value.
        // The setter still writes into _vel so the physics step picks it up.
        /** Horizontal velocity in world units/second (auto-applied each frame) */
        get velocityX() {
            if (obj.physicsBody === 'dynamic' && obj._physicsBody)
                return  (obj._physicsBody.getLinearVelocity()?.x ?? 0) / 100;
            return _vel.x;
        },
        set velocityX(v) { _vel.x = v; obj._velDirty = true; obj._velSetX = true; },
        /** Vertical velocity in world units/second (auto-applied each frame, +Y=up) */
        get velocityY() {
            if (obj.physicsBody === 'dynamic' && obj._physicsBody)
                return -(obj._physicsBody.getLinearVelocity()?.y ?? 0) / 100;
            return _vel.y;
        },
        set velocityY(v) { _vel.y = v; obj._velDirty = true; obj._velSetY = true; },
        /** Short alias for velocityX */
        get vx() {
            if (obj.physicsBody === 'dynamic' && obj._physicsBody)
                return  (obj._physicsBody.getLinearVelocity()?.x ?? 0) / 100;
            return _vel.x;
        },
        set vx(v) { _vel.x = v; obj._velDirty = true; obj._velSetX = true; },
        /** Short alias for velocityY */
        get vy() {
            if (obj.physicsBody === 'dynamic' && obj._physicsBody)
                return -(obj._physicsBody.getLinearVelocity()?.y ?? 0) / 100;
            return _vel.y;
        },
        set vy(v) { _vel.y = v; obj._velDirty = true; obj._velSetY = true; },

        /** Set both velocity components at once */
        setVelocity(vx, vy) { _vel.x = vx; _vel.y = vy; obj._velDirty = true; obj._velSetX = true; obj._velSetY = true; },
        /** Stop all movement */
        stopMovement() { _vel.x = 0; _vel.y = 0; },
        /** Bounce velocityX (e.g. hit a wall) */
        bounceX() { _vel.x = -_vel.x; },
        /** Bounce velocityY (e.g. hit a floor) */
        bounceY() { _vel.y = -_vel.y; },

        // ── INTERNAL SHARED STATE (used by ScriptInstance.update and forever()) ──
        /** Direct access to the velocity vector — used by proxy and forever() */
        get _vel()        { return _vel; },
        /** Direct access to the forever-loop callback list */
        get _foreverCbs() { return _foreverCbs; },

        // ── INTERNAL vel for runtime ─────────────────────
        _vel,
        // Raw PIXI container — used by say() / think() speech bubbles (addChild)
        _ref: obj,
        /** True if this object was spawned by cloneSelf/cloneObject at runtime */
        get isClone() { return !!obj._isClone; },
        // Scene references for prelude helpers (drawText etc) that can't access `state` directly
        get _sc()          { return state.sceneContainer; },
        get _gameObjects() { return state.gameObjects; },
        // drawText cache — shared between the prelude's drawText() and the sandbox closure
        get _drawTextCache() { return _drawTextCache; },
        // ANY-key helpers
        _anyKeyDown()     { return _keys.size > 0; },
        _anyKeyJustDown() { return _keysJustDown.size > 0; },
        _anyKeyJustUp()   { return _keysJustUp.size > 0; },

        // ── ROTATION / SCALE ─────────────────────────────────
        /** This object's rotation in degrees */
        get rotation()   { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v)  {
            obj.rotation = -(v * Math.PI / 180);
            if (obj.spriteGraphic) obj.spriteGraphic.rotation = obj.rotation;
        },
        get scaleX()     { return obj.scale?.x ?? 1; },
        set scaleX(v)    {
            if (!obj.scale) obj.scale = { x: 1, y: 1 };
            obj.scale.x = +v;
            if (obj.spriteGraphic) obj.spriteGraphic.scale.x = +v;
        },
        get scaleY()     { return obj.scale?.y ?? 1; },
        set scaleY(v)    {
            if (!obj.scale) obj.scale = { x: 1, y: 1 };
            obj.scale.y = +v;
            if (obj.spriteGraphic) obj.spriteGraphic.scale.y = +v;
        },
        /** Width in world units */
        get width()      { return (obj.spriteGraphic?.width  ?? 100) / 100; },
        /** Height in world units */
        get height()     { return (obj.spriteGraphic?.height ?? 100) / 100; },

        // ── DISPLAY ───────────────────────────────────────────
        get visible()    { return obj.visible; },
        set visible(v)   { obj.visible = !!v; if (obj.spriteGraphic) obj.spriteGraphic.visible = !!v; },
        get alpha()      { return obj.alpha; },
        set alpha(v)     { obj.alpha = Math.max(0, Math.min(1, v)); if (obj.spriteGraphic) obj.spriteGraphic.alpha = obj.alpha; },

        // ── MOVEMENT HELPERS ─────────────────────────────────
        /** Move by (dx, dy) world units this frame.
         *  For kinematic bodies, accumulates into the AABB sweep so
         *  the move is collision-resolved — no more tunneling through walls. */
        move(dx, dy) {
            if (obj.physicsImmovable) return;
            if (obj.physicsBody === 'kinematic') {
                // Accumulate into pending delta; stepPhysics will sweep it
                if (!obj._pendingKinematicDelta) obj._pendingKinematicDelta = { x: 0, y: 0 };
                obj._pendingKinematicDelta.x +=  dx * 100;
                obj._pendingKinematicDelta.y -= dy * 100;
            } else {
                obj.x += dx * 100;
                obj.y -= dy * 100;
            }
        },
        moveTo(x, y) {
            if (obj.physicsImmovable) return;
            // moveTo is a teleport — goes direct even on kinematic
            // (intentional: respawn, warp, etc.)
            obj.x =  x * 100;
            obj.y = -y * 100;
            if (obj.physicsBody === 'kinematic') {
                // Reset prev so next frame doesn't treat this as a large velocity
                obj._kinematicPrevX = obj.x;
                obj._kinematicPrevY = obj.y;
            }
        },
        /** Rotate to face a world point */
        lookAt(tx, ty) {
            obj.rotation = -Math.atan2(-((-ty*100) - obj.y), (tx*100) - obj.x);
        },
        /** Move forward along current rotation direction (sweep-resolved for kinematic) */
        moveForward(speed) {
            const r  = -obj.rotation;
            const dx = Math.cos(r) * speed * 100;
            const dy = Math.sin(r) * speed * 100;
            if (obj.physicsBody === 'kinematic') {
                if (!obj._pendingKinematicDelta) obj._pendingKinematicDelta = { x: 0, y: 0 };
                obj._pendingKinematicDelta.x += dx;
                obj._pendingKinematicDelta.y -= dy;
            } else {
                obj.x += dx;
                obj.y -= dy;
            }
        },
        flipX() {
            if (!obj.scale) obj.scale = { x: 1, y: 1 };
            obj.scale.x *= -1;
            if (obj.spriteGraphic) obj.spriteGraphic.scale.x = obj.scale.x;
        },
        flipY() {
            if (!obj.scale) obj.scale = { x: 1, y: 1 };
            obj.scale.y *= -1;
            if (obj.spriteGraphic) obj.spriteGraphic.scale.y = obj.scale.y;
        },

        // ── PHYSICS BODY ─────────────────────────────────────
        physics: {
            /** Apply a continuous force (world units). Call every frame for sustained push. Dynamic only. */
            applyForce(fx, fy) {
                if (window.planck && obj._physicsBody)
                    obj._physicsBody.applyForce(window.planck.Vec2(fx, -fy), obj._physicsBody.getWorldCenter(), true);
            },
            /**
             * Apply an instantaneous impulse (velocity change). Dynamic only.
             * ix/iy in world units/sec. +Y = up.
             */
            applyImpulse(ix, iy) {
                if (window.planck && obj._physicsBody) {
                    const b   = obj._physicsBody;
                    const vel = b.getLinearVelocity();
                    b.setLinearVelocity(window.planck.Vec2(
                        vel.x + ix * 100 / (b.getMass() || 1),
                        vel.y - iy * 100 / (b.getMass() || 1),
                    ));
                }
            },
            /** Set physics body velocity directly (world units/sec, +Y=up). Dynamic bodies only. */
            setVelocity(vx, vy) {
                if (window.planck && obj._physicsBody && obj.physicsBody === 'dynamic')
                    obj._physicsBody.setLinearVelocity(window.planck.Vec2(vx * 100, -vy * 100));
            },
            /**
             * Read this body's actual velocity X in world units/sec.
             * Works for both dynamic and kinematic bodies.
             */
            get velX() {
                if (obj.physicsBody === 'kinematic')
                    return  (obj._kinematicActualVx ?? 0) / 100;
                return  (obj._physicsBody?.getLinearVelocity()?.x ?? 0) / 100;
            },
            /**
             * Read this body's actual velocity Y in world units/sec (+Y = up).
             * Works for both dynamic and kinematic bodies.
             */
            get velY() {
                if (obj.physicsBody === 'kinematic')
                    return -(obj._kinematicActualVy ?? 0) / 100;
                return -(obj._physicsBody?.getLinearVelocity()?.y ?? 0) / 100;
            },
            /**
             * True when this body is resting on a floor this frame. Works for Kinematic and Dynamic.
             * Use this to stop gravity from accumulating: if (isOnGround()) velocityY = 0;
             */
            get isOnGround()  { return !!obj._isOnGround; },
            /** True when this body bumped a ceiling this frame (Kinematic and Dynamic). */
            get isOnCeiling() { return !!obj._isOnCeiling; },
            /** True when this body is pressed against a wall this frame (Kinematic and Dynamic). */
            get isOnWall()    { return !!obj._isOnWall; },
            /** Lock this body completely — nothing can move it, including scripts. */
            setImmovable(val) {
                obj.physicsImmovable = !!val;
                import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
            },
            /** Returns true if this body is currently locked immovable. */
            get immovable() { return !!obj.physicsImmovable; },
            /** Zero the physics body velocity (dynamic) or stop kinematic movement. */
            stop() {
                if (obj.physicsBody === 'kinematic') {
                    obj._kinematicVx = 0;
                    obj._kinematicVy = 0;
                    obj._pendingKinematicDelta = { x: 0, y: 0 };
                } else if (window.planck && obj._physicsBody) {
                    obj._physicsBody.setLinearVelocity(window.planck.Vec2(0, 0));
                }
            },
            /**
             * Set the angular (spin) velocity of this dynamic body (degrees/sec).
             * Matches the units of setRotation/getRotation. Dynamic only.
             * Positive = clockwise, negative = counter-clockwise.
             *   physics.setAngularVelocity(180)  → spin at 180°/sec clockwise
             *   physics.setAngularVelocity(-90)  → spin counter-clockwise
             *   physics.setAngularVelocity(0)    → stop spinning
             */
            setAngularVelocity(degsPerSec) {
                if (window.planck && obj._physicsBody && obj.physicsBody === 'dynamic')
                    obj._physicsBody.setAngularVelocity(degsPerSec * Math.PI / 180);
            },
            /**
             * Apply a one-time angular (spin) impulse to this dynamic body.
             * Positive = clockwise kick, negative = counter-clockwise.
             * Dynamic only.
             *   physics.applyAngularImpulse(5)   → spin kick clockwise
             *   physics.applyAngularImpulse(-3)  → spin kick counter-clockwise
             */
            applyAngularImpulse(impulse) {
                if (window.planck && obj._physicsBody && obj.physicsBody === 'dynamic')
                    obj._physicsBody.applyAngularImpulse(impulse, true);
            },
            /**
             * Read the current angular velocity in radians/sec.
             * Positive = clockwise. Dynamic only.
             */
            get angularVelocity() {
                if (window.planck && obj._physicsBody && obj.physicsBody === 'dynamic')
                    return obj._physicsBody.getAngularVelocity();
                return 0;
            },
        },

        // ── ANIMATION ────────────────────────────────────────
        playAnimation(name) {
            const anims = obj.animations;
            if (!anims?.length) {
                _logConsole(`[Script on "${obj.label}"] playAnimation("${name}"): object has no animations`, '#facc15');
                return;
            }
            const idx = anims.findIndex(a => a.name === name);
            if (idx < 0) {
                _logConsole(`[Script on "${obj.label}"] playAnimation("${name}"): animation not found. Available: ${anims.map(a=>a.name).join(', ')}`, '#facc15');
                return;
            }
            const changed = obj.activeAnimIndex !== idx;
            obj.activeAnimIndex = idx;

            const existing = obj._animSprite;
            if (!changed && existing?.play) {
                // Same animation already active — just resume if paused, no rebuild needed
                if (!existing.playing) existing.gotoAndPlay(0);
                return;
            }

            // Guard: if a switch is already in-flight, skip to avoid duplicate rebuilds
            if (obj._animSwitchPending) return;
            obj._animSwitchPending = true;

            // Swap to the new animation. reapplyAnimationToObject replaces
            // spriteGraphic in-place — it does NOT create a new game object.
            import('./engine.animator.js').then(({ reapplyAnimationToObject }) => {
                obj._animSwitchPending = false;
                reapplyAnimationToObject(obj);
                const s = obj._animSprite;
                if (s?.play) s.gotoAndPlay(0);
            }).catch(() => { obj._animSwitchPending = false; });
        },
        stopAnimation() {
            const s = obj._animSprite ?? obj.spriteGraphic;
            try { if (s?.stop) s.stop(); } catch(_) {}
        },
        pauseAnimation() {
            const s = obj._animSprite ?? obj.spriteGraphic;
            try { if (s?.stop) s.stop(); } catch(_) {}
        },
        /** Name of the currently playing animation, or null */
        get currentAnimation() { return obj.animations?.[obj.activeAnimIndex ?? 0]?.name ?? null; },
        /** True if an animation is currently playing */
        get isPlayingAnimation() {
            return !!(obj._animSprite?.playing || obj._runtimeSprite?.playing);
        },

        // ── INPUT ────────────────────────────────────────────
        input: {
            isKeyDown:        k => _keys.has(k.toLowerCase()),
            isKeyJustDown:    k => _keysJustDown.has(k.toLowerCase()),
            isKeyJustUp:      k => _keysJustUp.has(k.toLowerCase()),
            get mouseX()      { return _mouse.x / 100; },
            get mouseY()      { return -_mouse.y / 100; },
            /** Mouse/finger position in raw screen pixels (matches clientX/clientY) */
            get screenMouseX() { return _mouse.screenX; },
            get screenMouseY() { return _mouse.screenY; },
            /** Mouse position in world units */
            get worldMouseX() { return _mouse.x / 100; },
            get worldMouseY() { return -_mouse.y / 100; },
            get mouseDown()   { return _mouse.down; },
            get mouseJustDown(){ return _mouse.justDown; },
            get mouseJustUp() { return _mouse.justUp; },
            /** All active touch points as an array of {id, x, y, screenX, screenY} in world units */
            get touches()     { return _activeTouches; },
            /** Number of fingers currently on screen */
            get touchCount()  { return _activeTouches.length; },
            /** Horizontal axis from A/D or arrow keys: -1, 0, or 1 */
            get axisH() {
                return ((_keys.has('d')||_keys.has('arrowright'))?1:0)
                      -((_keys.has('a')||_keys.has('arrowleft') )?1:0);
            },
            /** Vertical axis from W/S or arrow keys: -1, 0, or 1 */
            get axisV() {
                return ((_keys.has('w')||_keys.has('arrowup')   )?1:0)
                      -((_keys.has('s')||_keys.has('arrowdown')  )?1:0);
            },
        },

        // ── SCENE QUERIES ────────────────────────────────────
        /** Find an object by its exact label/name */
        find(label) {
            const f = state.gameObjects.find(o => o.label === label);
            return f ? _makeProxy(f) : null;
        },
        /** Find the FIRST object with a given tag */
        findWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set || !set.size) return null;
            const [first] = set;
            return _makeProxy(first.obj);
        },
        /** Find ALL objects with a given tag → array of proxies */
        findAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },
        /** Find ALL objects in a group → array of proxies */
        findAllInGroup(grp) {
            const set = _groupRegistry.get(grp);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },

        // ── OVERLAP DETECTION (no physics body needed) ───────
        /**
         * Check if this object overlaps another right now (AABB).
         * Works on any object — no physics body required.
         * Example: if (this.overlaps(this.find("Coin"))) { ... }
         */
        overlaps(other) {
            return _isOverlapping(obj, other?._ref ?? other);
        },
        /**
         * Check if this object overlaps any object with a given tag.
         * Returns the first overlapping object's proxy, or null.
         */
        overlapsTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return null;
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) return _makeProxy(inst.obj);
            }
            return null;
        },
        /**
         * Get ALL objects with tag that this object overlaps right now.
         */
        overlapsAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            const result = [];
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) result.push(_makeProxy(inst.obj));
            }
            return result;
        },

        // ── DESTROY ──────────────────────────────────────────
        destroySelf()     { obj._markedForDestroy = true; },
        destroy(other)    { if (other?._ref) other._ref._markedForDestroy = true; },
        /** Destroy this object after a delay in seconds. */
        destroyAfter(secs) {
            _scheduleTimer(secs, () => { obj._markedForDestroy = true; }, 'destroyAfter', obj.label);
        },
        /** Returns true if this object is a runtime clone (spawned by cloneSelf/cloneObject). */
        get isClone() { return obj._isClone === true; },

        // ── MESSAGING ────────────────────────────────────────
        /**
         * Send to FIRST object with this tag.
         * Example: this.sendMessage("Enemy", "takeDamage", 10)
         */
        sendMessage(tag, msg, data)      { _sendMessageToTag(String(tag), String(msg), data); },
        /** Send a message to every scripted object in the scene. */
        broadcastMessage(msg, data)      { _broadcastGlobal(String(msg), data); },
        /**
         * Send to ALL objects with this tag.
         * Example: this.broadcast("Enemy", "freeze")
         */
        broadcast(tag, msg, data)        { _broadcastToTag(String(tag), String(msg), data); },
        /**
         * Send to all objects in a group.
         */
        broadcastGroup(grp, msg, data)   { _broadcastToGroup(String(grp), String(msg), data); },
        /**
         * Send to every scripted object in the scene.
         */
        broadcastAll(msg, data)          { _broadcastGlobal(String(msg), data); },

        // ── SCENE MANAGEMENT ─────────────────────────────────
        /**
         * Switch scenes. Optionally play a transition effect.
         * gotoScene("Level2")               — instant switch
         * gotoScene(1)                       — by index
         * gotoScene("Level2", "fade")        — fade to black
         * gotoScene("Level2", "fadewhite")   — fade to white
         * gotoScene("Level2", "slide-left")  — slide left
         * gotoScene("Level2", "slide-right") — slide right
         * gotoScene("Level2", "zoom")        — zoom in/out
         */
        gotoScene(nameOrIndex, transition = null) {
            let idx = -1;
            if (typeof nameOrIndex === 'number') {
                idx = nameOrIndex;
            } else {
                idx = state.scenes.findIndex(s => s.name === String(nameOrIndex));
                if (idx === -1) {
                    _logConsole(`[Script] gotoScene("${nameOrIndex}") — not found. Available: ${state.scenes.map(s=>'"'+s.name+'"').join(', ')}`, '#f87171');
                    return;
                }
            }
            if (idx < 0 || idx >= state.scenes.length) {
                _logConsole(`[Script] gotoScene(${idx}) — index out of range (0–${state.scenes.length-1})`, '#f87171');
                return;
            }
            if (state.isPlaying) {
                // Use playModeGotoScene — switches scene while STAYING in play mode,
                // never touching the editor. No flash, no stopPlayMode, no enterPlayMode.
                if (transition) {
                    const t = String(transition);
                    import('./engine.transitions.js').then(tm => {
                        tm.transitionOut(t, 0.5).then(() => {
                            import('./engine.scenes.js').then(sm => {
                                sm.playModeGotoScene(idx, () => tm.transitionIn(t, 0.5));
                            });
                        });
                    });
                } else {
                    import('./engine.scenes.js').then(sm => sm.playModeGotoScene(idx, null));
                }
            } else {
                import('./engine.scenes.js').then(m => m.switchToScene(idx));
            }
        },
        /** Get the name of the current scene */
        get currentScene() { return state.scenes[state.activeSceneIndex]?.name ?? ''; },
        /** Get the index of the current scene */
        get currentSceneIndex() { return state.activeSceneIndex; },
        /** Get total number of scenes */
        get sceneCount() { return state.scenes.length; },
        /** Get the name of a scene by index */
        getSceneName(i) { return state.scenes[i]?.name ?? ''; },

        /**
         * Pause or unpause the current scene from a script.
         * pauseScene()       → pauses  (same as pressing ⏸)
         * pauseScene(false)  → resumes
         * pauseScene(true)   → pauses
         */
        pauseScene(shouldPause = true) {
            if (!state.isPlaying) return;
            if (shouldPause === state.isPaused) return; // already in requested state
            import('./engine.playmode.js').then(m => m.pausePlayMode());
        },

        /**
         * Restart the current scene from scratch — stops all scripts and physics,
         * then reloads the scene snapshot exactly as it was when Play started,
         * without leaving play mode. Great for "Retry" buttons.
         */
        restartScene() {
            if (!state.isPlaying) return;
            const currentIdx = state.activeSceneIndex;
            import('./engine.scenes.js').then(sm => sm.playModeGotoScene(currentIdx));
            _logConsole(`↺ Scene restarted: "${state.scenes[currentIdx]?.name}"`, '#4ade80');
        },

        // ── CAMERA ───────────────────────────────────────────
        camera: _camera,

        // ── SCENE VARIABLES ──────────────────────────────────
        /** Shared across all scripts in this scene. Resets on scene change. */
        get sceneVar() { return _sceneVars; },
        /** Scene canvas settings — gameWidth, gameHeight, scalingMode, bgColor, etc. */
        get sceneSettings() { return state.sceneSettings ?? {}; },

        // ── GLOBAL VARIABLES ─────────────────────────────────
        /**
         * Shared across ALL scripts in ALL scenes. Persists until Play stops.
         * Example:  globalVar.score = 0;   globalVar.score += 10;
         * Any script can read/write the same values.
         */
        get globalVar() { return _globalVars; },


        // ── GAME SAVE (persistent across page refresh) ────────
        /**
         * GameSave  — store and retrieve player progress that
         * survives page refresh, browser close, and re-open.
         *
         * Small values (strings, numbers, objects) → localStorage (sync, instant).
         * Large values (>= 128 KB serialised) or binary (ArrayBuffer / Blob)
         * → IndexedDB automatically (async, no size limit).
         * If localStorage is full it also falls back to IDB automatically.
         * You never need to think about which backend is used.
         *
         * All data is namespaced to a slot so multiple save
         * files can coexist (slot defaults to "default").
         *
         * Sync quick reference (small data — returns value directly):
         *   GameSave.set("score", 42)
         *   GameSave.get("score", 0)       // 0 = default if not found
         *   GameSave.has("score")          // → true / false
         *   GameSave.delete("score")
         *   GameSave.setAll({ score:42, level:3 })
         *   GameSave.getAll()              // → plain object (LS keys only)
         *   GameSave.increment("score", 5) // → new value
         *   GameSave.clear()               // wipe entire slot (both LS + IDB)
         *   GameSave.slot("file2").set("score", 0)  // named slots
         *
         * Async (needed for large / binary data — returns a Promise):
         *   await GameSave.setBig("mapData", hugeArrayBuffer)
         *   const buf = await GameSave.getBig("mapData", null)
         *   await GameSave.deleteBig("mapData")
         *   const keys = await GameSave.listBigKeys()
         */
        GameSave: (() => {
            const _LS_PREFIX  = '__zgsave__';
            const _IDB_DB     = 'ZengineSaveDB';
            const _IDB_STORE  = 'saves';
            // Values larger than this threshold go to IDB automatically
            const _BIG_BYTES  = 128 * 1024; // 128 KB

            // ── IndexedDB helpers (shared across all slots) ───
            let _idb = null;
            function _openSaveDB() {
                if (_idb) return Promise.resolve(_idb);
                return new Promise((resolve) => {
                    const req = indexedDB.open(_IDB_DB, 1);
                    req.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains(_IDB_STORE)) {
                            db.createObjectStore(_IDB_STORE);
                        }
                    };
                    req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
                    req.onerror   = ()  => { resolve(null); };
                });
            }
            function _idbPut(key, value) {
                return _openSaveDB().then(db => new Promise((resolve) => {
                    if (!db) { resolve(false); return; }
                    try {
                        const tx  = db.transaction(_IDB_STORE, 'readwrite');
                        const req = tx.objectStore(_IDB_STORE).put(value, key);
                        req.onsuccess = () => resolve(true);
                        req.onerror   = () => resolve(false);
                    } catch { resolve(false); }
                }));
            }
            function _idbGet(key) {
                return _openSaveDB().then(db => new Promise((resolve) => {
                    if (!db) { resolve(null); return; }
                    try {
                        const tx  = db.transaction(_IDB_STORE, 'readonly');
                        const req = tx.objectStore(_IDB_STORE).get(key);
                        req.onsuccess = (e) => resolve(e.target.result ?? null);
                        req.onerror   = () => resolve(null);
                    } catch { resolve(null); }
                }));
            }
            function _idbDelete(key) {
                return _openSaveDB().then(db => new Promise((resolve) => {
                    if (!db) { resolve(false); return; }
                    try {
                        const tx  = db.transaction(_IDB_STORE, 'readwrite');
                        const req = tx.objectStore(_IDB_STORE).delete(key);
                        req.onsuccess = () => resolve(true);
                        req.onerror   = () => resolve(false);
                    } catch { resolve(false); }
                }));
            }
            function _idbAllKeys(prefix) {
                return _openSaveDB().then(db => new Promise((resolve) => {
                    if (!db) { resolve([]); return; }
                    try {
                        const tx  = db.transaction(_IDB_STORE, 'readonly');
                        const req = tx.objectStore(_IDB_STORE).getAllKeys();
                        req.onsuccess = (e) => resolve(
                            (e.target.result || []).filter(k => k.startsWith(prefix))
                        );
                        req.onerror = () => resolve([]);
                    } catch { resolve([]); }
                }));
            }

            // ── LS helpers ────────────────────────────────────
            function _lsLoad(slot) {
                try { return JSON.parse(localStorage.getItem(_LS_PREFIX + slot) || 'null') || {}; }
                catch { return {}; }
            }
            function _lsSave(slot, data) {
                try {
                    localStorage.setItem(_LS_PREFIX + slot, JSON.stringify(data));
                    return true;
                } catch { return false; }
            }

            // ── Decide if a value is "big" ────────────────────
            function _isBig(value) {
                if (value instanceof ArrayBuffer) return true;
                if (value instanceof Blob)        return true;
                if (typeof value === 'string' && value.length >= _BIG_BYTES) return true;
                if (typeof value === 'object' && value !== null) {
                    try {
                        return JSON.stringify(value).length >= _BIG_BYTES;
                    } catch { return true; }
                }
                return false;
            }

            // ── IDB key format: "slot::key" ───────────────────
            function _idbKey(slot, key) { return slot + '::' + key; }

            // ── Slot factory ──────────────────────────────────
            function _makeSlot(slotName) {
                return {
                    /**
                     * Save a key. Small values save synchronously to localStorage.
                     * Large values (>= 128 KB) or binary automatically use IDB
                     * and return a Promise — await it if you need to know when done.
                     * If localStorage is full, also falls back to IDB automatically.
                     */
                    set(key, value) {
                        if (_isBig(value)) {
                            // Big / binary — go straight to IDB
                            return _idbPut(_idbKey(slotName, key), value).then(ok => {
                                if (!ok) _logConsole(`GameSave.set("${key}"): IDB write failed`, '#f87171');
                            });
                        }
                        // Small — try localStorage first
                        const d = _lsLoad(slotName);
                        d[key] = value;
                        const ok = _lsSave(slotName, d);
                        if (!ok) {
                            // LS full — spill to IDB
                            _logConsole(`GameSave: localStorage full, saving "${key}" to IDB`, '#facc15');
                            return _idbPut(_idbKey(slotName, key), value).then(iok => {
                                if (!iok) _logConsole(`GameSave.set("${key}"): IDB fallback also failed`, '#f87171');
                            });
                        }
                    },

                    /**
                     * Read a key synchronously from localStorage.
                     * If the key was stored in IDB (big/binary/spill), use getBig() instead.
                     */
                    get(key, defaultValue = null) {
                        const d = _lsLoad(slotName);
                        return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : defaultValue;
                    },

                    /**
                     * Async get — checks IDB first, then localStorage.
                     * Use this when you don't know which backend was used,
                     * or when dealing with large / binary values.
                     *   const data = await GameSave.getAny("key", null)
                     */
                    async getAny(key, defaultValue = null) {
                        const idbVal = await _idbGet(_idbKey(slotName, key));
                        if (idbVal !== null) return idbVal;
                        const d = _lsLoad(slotName);
                        return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : defaultValue;
                    },

                    /**
                     * Async set for large / binary values — always writes to IDB.
                     * Equivalent to set() but always async and always IDB.
                     *   await GameSave.setBig("screenshot", arrayBuffer)
                     */
                    async setBig(key, value) {
                        const ok = await _idbPut(_idbKey(slotName, key), value);
                        if (!ok) _logConsole(`GameSave.setBig("${key}"): IDB write failed`, '#f87171');
                        return ok;
                    },

                    /**
                     * Async get for large / binary values from IDB.
                     *   const buf = await GameSave.getBig("screenshot", null)
                     */
                    async getBig(key, defaultValue = null) {
                        const v = await _idbGet(_idbKey(slotName, key));
                        return v !== null ? v : defaultValue;
                    },

                    /**
                     * Async delete a large / binary value from IDB.
                     */
                    async deleteBig(key) {
                        return _idbDelete(_idbKey(slotName, key));
                    },

                    /**
                     * List all keys stored in IDB for this slot.
                     *   const keys = await GameSave.listBigKeys()
                     */
                    async listBigKeys() {
                        const prefix = slotName + '::';
                        const keys = await _idbAllKeys(prefix);
                        return keys.map(k => k.slice(prefix.length));
                    },

                    /** Returns true if the key exists in localStorage. */
                    has(key) {
                        return Object.prototype.hasOwnProperty.call(_lsLoad(slotName), key);
                    },

                    /** Remove a single key from localStorage. */
                    delete(key) {
                        const d = _lsLoad(slotName);
                        delete d[key];
                        _lsSave(slotName, d);
                    },

                    /** Save multiple small keys at once from a plain object. */
                    setAll(obj) {
                        const d = _lsLoad(slotName);
                        Object.assign(d, obj);
                        const ok = _lsSave(slotName, d);
                        if (!ok) _logConsole('GameSave.setAll: localStorage full — some keys not saved', '#f87171');
                    },

                    /** Return every small (localStorage) key/value in this slot. */
                    getAll() { return { ..._lsLoad(slotName) }; },

                    /** Increment a numeric key by amount (default 1). */
                    increment(key, amount = 1) {
                        const d = _lsLoad(slotName);
                        d[key] = (typeof d[key] === 'number' ? d[key] : 0) + amount;
                        _lsSave(slotName, d);
                        return d[key];
                    },

                    /** Wipe all data in this slot — both localStorage and IDB. */
                    async clear() {
                        localStorage.removeItem(_LS_PREFIX + slotName);
                        const prefix = slotName + '::';
                        const keys = await _idbAllKeys(prefix);
                        await Promise.all(keys.map(k => _idbDelete(k)));
                    },

                    /** Switch to a different named slot. */
                    slot(name) { return _makeSlot(String(name)); },

                    /** The slot name this handle points to. */
                    get slotName() { return slotName; },

                    /** List all slot names that have data in localStorage. */
                    listSlots() {
                        const slots = [];
                        for (let i = 0; i < localStorage.length; i++) {
                            const k = localStorage.key(i);
                            if (k && k.startsWith(_LS_PREFIX)) slots.push(k.slice(_LS_PREFIX.length));
                        }
                        return slots;
                    },
                };
            }
            return _makeSlot('default');
        })(),

        // ── SOUND ─────────────────────────────────────────────
        /**
         * Play a sound asset by name.
         * soundPlay("Jump", { x:0, y:0, loop:false, range:400, volume:1.0 })
         */
        soundPlay(assetName, opts = {}) {
            const asset = state.assets.find(a => a.label === assetName || a.name === assetName);
            if (!asset) { _logConsole(`soundPlay: asset "${assetName}" not found`, '#facc15'); return; }
            import('./engine.audio.js').then(m => {
                m._playScriptSound(asset, {
                    x:      (opts.x ?? obj.x / 100),
                    y:      (opts.y ?? -obj.y / 100),
                    loop:   opts.loop   ?? false,
                    range:  opts.range  ?? 400,
                    volume: opts.volume ?? 1.0,
                    id:     assetName,
                });
            });
        },
        /**
         * Stop a specific sound by name.
         * soundStop("Jump")
         */
        soundStop(assetName) {
            import('./engine.audio.js').then(m => m._stopScriptSound(assetName));
        },
        /** Stop all currently playing sounds */
        soundStopAll() {
            import('./engine.audio.js').then(m => m._stopAllScriptSounds());
        },

        // ── TIMERS ────────────────────────────────────────────
        /**
         * Wait a number of seconds then call a function.
         * Works inside onUpdate — call once and it schedules itself.
         * Example:  wait(2, () => { log("2 seconds passed!"); });
         */
        wait(seconds, fn) {
            _scheduleTimer(seconds, fn, this.name ?? 'wait()', obj?.label ?? '?');
        },

        // ── PHYSICS CONTROL FROM SCRIPT ───────────────────────
        /**
         * Change this object's physics body type at runtime.
         * setPhysicsType("static") | "kinematic" | "dynamic" | "none"
         * static    = immovable, infinite mass, not affected by any force.
         * kinematic = script-controlled, no gravity, pushes dynamic bodies.
         * dynamic   = full physics (gravity + forces + collisions).
         */
        setPhysicsType(type) {
            obj.physicsBody = type;
            // Rebuild the physics body at runtime if physics is running
            if (state.isPlaying) {
                import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
            }
        },
        /**
         * Lock rotation so physics torque/forces cannot spin this dynamic body.
         * You can still rotate it manually with setRotation() or this.rotation=.
         *   lockRotation()
         */
        lockRotation() {
            obj.physicsFixedRotation = true;
            if (obj._physicsBody) obj._physicsBody.setFixedRotation(true);
        },
        /**
         * Unlock rotation — physics can spin this body again.
         *   unlockRotation()
         */
        unlockRotation() {
            obj.physicsFixedRotation = false;
            if (obj._physicsBody) obj._physicsBody.setFixedRotation(false);
        },
        /**
         * Set rotation lock on/off in one call.
         *   setRotationLocked(true)   — same as lockRotation()
         *   setRotationLocked(false)  — same as unlockRotation()
         */
        setRotationLocked(locked) {
            obj.physicsFixedRotation = !!locked;
            if (obj._physicsBody) obj._physicsBody.setFixedRotation(!!locked);
        },
        /**
         * Enable or disable collision detection for this object.
         * setCollision(false) — object passes through everything (sensor).
         */
        setCollision(enabled) {
            obj.physicsIsSensor = !enabled;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) f.setSensor(!enabled);
            }
        },
        /**
         * Make this object a sensor (detects overlaps but no physical response).
         */
        setSensor(v) {
            obj.physicsIsSensor = !!v;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) f.setSensor(!!v);
            }
        },
        /**
         * Set which collision category layer this object belongs to.
         * setCollisionCategory(2)
         */
        setCollisionCategory(cat) {
            obj.physicsCollisionCategory = cat;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) {
                    const fd = f.getFilterData();
                    f.setFilterData({ ...fd, categoryBits: cat & 0xFFFF });
                }
            }
        },
        /**
         * Set which categories this object collides with (bitmask).
         * setCollisionMask(-1) = collide with everything (default)
         * setCollisionMask(0)  = collide with nothing
         */
        setCollisionMask(mask) {
            obj.physicsCollisionMask = mask;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) {
                    const fd = f.getFilterData();
                    f.setFilterData({ ...fd, maskBits: mask >>> 0 & 0xFFFF });
                }
            }
        },

        // ── SPRITE TINT ───────────────────────────────────────
        /**
         * Get or set this object's tint colour (hex string).
         * this.tint = "#ff0000"  — red tint
         * this.tint = 0x00ff00   — green tint (hex number)
         * this.tint = "#ffffff"  — remove tint (white = no effect)
         */
        get tint() {
            const s = obj._runtimeSprite || obj._animSprite || obj.spriteGraphic;
            const t = s?.tint;
            return t !== undefined ? '#' + t.toString(16).padStart(6, '0') : '#ffffff';
        },
        set tint(v) {
            const hex = typeof v === 'string'
                ? parseInt(v.replace('#',''), 16)
                : (v ?? 0xffffff);
            obj._scriptTint = hex;
            const active = obj._runtimeSprite || obj._animSprite || obj.spriteGraphic;
            if (active) active.tint = hex;
            if (obj.spriteGraphic && obj.spriteGraphic !== active) obj.spriteGraphic.tint = hex;
        },
        /** Set tint — same as this.tint = v. setTint("#ff0000") or setTint(0xff0000). */
        setTint(v) {
            const hex = typeof v === 'string'
                ? parseInt(v.replace('#',''), 16)
                : (v ?? 0xffffff);
            obj._scriptTint = hex;
            const active = obj._runtimeSprite || obj._animSprite || obj.spriteGraphic;
            if (active) active.tint = hex;
            if (obj.spriteGraphic && obj.spriteGraphic !== active) obj.spriteGraphic.tint = hex;
        },
        /** Get tint as hex string. */
        getTint() {
            const s = obj._runtimeSprite || obj._animSprite || obj.spriteGraphic;
            return s ? '#' + (s.tint ?? 0xffffff).toString(16).padStart(6, '0') : '#ffffff';
        },
        /** Remove tint (reset to white / no colour effect). */
        clearTint() {
            obj._scriptTint = 0xffffff;
            const active = obj._runtimeSprite || obj._animSprite || obj.spriteGraphic;
            if (active) active.tint = 0xffffff;
            if (obj.spriteGraphic && obj.spriteGraphic !== active) obj.spriteGraphic.tint = 0xffffff;
        },

        // ── DISTANCE ─────────────────────────────────────────
        /**
         * Get the distance from this object to another position or object.
         * distanceTo(other)         — proxy from find/findWithTag
         * distanceTo(x, y)          — world coordinates
         * distanceTo("player")      — tag name (finds first object with that tag)
         */
        distanceTo(targetOrX, y) {
            let tx, ty;
            if (typeof targetOrX === 'string') {
                const found = _tagRegistry.get(targetOrX);
                if (!found || !found.size) return Infinity;
                const [first] = found;
                tx = first.obj.x / 100;
                ty = -first.obj.y / 100;
            } else if (targetOrX && typeof targetOrX === 'object' && '_ref' in targetOrX) {
                tx = targetOrX.x;
                ty = targetOrX.y;
            } else if (typeof targetOrX === 'number') {
                tx = targetOrX;
                ty = y ?? 0;
            } else {
                return Infinity;
            }
            const ox = obj.x / 100;
            const oy = -obj.y / 100;
            return Math.sqrt((tx - ox) ** 2 + (ty - oy) ** 2);
        },

        // ── TIME ─────────────────────────────────────────────
        /** Total seconds since Play was pressed */
        get time()    { return performance.now() / 1000; },
        get elapsed() { return performance.now() / 1000; },

        // ── MATH ─────────────────────────────────────────────
        math: {
            lerp:    (a,b,t)      => a + (b-a) * Math.max(0,Math.min(1,t)),
            clamp:   (v,lo,hi)    => Math.max(lo, Math.min(hi,v)),
            dist:    (x1,y1,x2,y2) => Math.sqrt((x2-x1)**2+(y2-y1)**2),
            rand:    (mn,mx)      => Math.random()*(mx-mn)+mn,
            randInt: (mn,mx)      => Math.floor(Math.random()*(mx-mn+1))+mn,
            sign:    v            => Math.sign(v),
            toRad:   d            => d * Math.PI / 180,
            toDeg:   r            => r * 180 / Math.PI,
            map:     (v,a1,b1,a2,b2) => a2 + (b2-a2)*((v-a1)/(b1-a1)),
            wrap:    (v,mn,mx)    => ((v-mn)%(mx-mn)+(mx-mn))%(mx-mn)+mn,
            sin:  Math.sin,  cos:  Math.cos,  tan:   Math.tan,
            abs:  Math.abs,  sqrt: Math.sqrt, pow:   Math.pow,
            atan2:Math.atan2,floor:Math.floor,ceil:  Math.ceil,
            round:Math.round,PI:   Math.PI,   max:   Math.max,  min: Math.min,
        },

        // ── DEBUG ─────────────────────────────────────────────
        log(...a)   { _logConsole(`[${obj.label}] ${a.map(String).join(' ')}`, '#9bc');    },
        warn(...a)  { _logConsole(`[${obj.label}] ⚠ ${a.map(String).join(' ')}`, '#facc15'); },
        error(...a) { _logConsole(`[${obj.label}] ✖ ${a.map(String).join(' ')}`, '#f87171'); },

        // ── PER-OBJECT STORE (lives only during play session) ─
        store: (() => {
            const d = {};
            return {
                set(k, v)   { d[k] = v; },
                get(k, def) { return k in d ? d[k] : def; },
                has(k)      { return k in d; },
                del(k)      { delete d[k]; },
            };
        })(),

        // ── TWEEN — animate properties over time ─────────────
        /**
         * Animate this object's properties smoothly over time.
         * tween({ alpha:0 }, 0.5)
         * tween({ x:5, scaleX:2 }, 1, "easeOut")
         * tween({ rotation:360 }, 2, "linear", () => log("done"))
         *
         * Supported props: x, y, alpha, scaleX, scaleY, rotation, scale
         * Easings: "linear","easeIn","easeOut","easeInOut","easeInCubic","easeOutCubic",
         *          "elastic","elasticOut","bounce","steps2","steps4"
         */
        tween(props, duration = 0.3, easing = 'linear', onComplete = null) {
            if (!props || typeof props !== 'object') return;
            const entries = [];
            for (const [key, to] of Object.entries(props)) {
                let from;
                switch (key) {
                    case 'x':        from = api.x;        break;
                    case 'y':        from = api.y;        break;
                    case 'alpha':    from = api.alpha;    break;
                    case 'scaleX':   from = api.scaleX;   break;
                    case 'scaleY':   from = api.scaleY;   break;
                    case 'rotation': from = api.rotation; break;
                    case 'scale':    from = api.scaleX;   break;
                    default: continue;
                }
                entries.push({ key, from: Number(from), to: Number(to) });
            }
            if (entries.length > 0)
                _tweens.push({ entries, duration: Math.max(0, duration), elapsed: 0, easing: String(easing), onComplete });
        },

        // ── REPEAT TIMERS ─────────────────────────────────────
        /**
         * Call a function repeatedly every `interval` seconds.
         * Returns an ID you can pass to cancelRepeat().
         * var id = repeat(1.5, () => { spawnEnemy(); })
         */
        repeat(interval, fn) {
            const id = _nextRepeatId();
            _repeats.push({ id, interval: Math.max(0.016, interval), elapsed: Math.max(0.016, interval), fn });
            return id;
        },
        /** Cancel a repeating timer returned by repeat(). */
        cancelRepeat(id) {
            const idx = _repeats.findIndex(r => r.id === id);
            if (idx !== -1) _repeats.splice(idx, 1);
        },

        // ── SPAWN OBJECT ──────────────────────────────────────
        /**
         * Create a new object from an asset at a world position.
         * spawnObject("Bullet", x, y)
         * spawnObject("Bullet", x, y, (obj) => { obj.velocityX = 10; })
         * spawnObject("enemy", x, y)  — can also match by tag
         * The callback receives a proxy to the new object.
         * Spawned object will run its attached script automatically.
         */
        spawnObject(assetName, wx, wy, onSpawned = null) {
            // Find by asset label, asset name, asset id, OR by object label in scene (as template)
            let asset = state.assets.find(a => a.label === assetName || a.name === assetName || a.id === assetName);
            // Also allow cloning any existing game object by label as a template
            let templateObj = null;
            let prefabTemplate = null;
            if (!asset) {
                // Try scene object by label
                templateObj = state.gameObjects.find(o => o.label === assetName);
                if (!templateObj) {
                    // Try by tag — use first instance of that tag
                    const tagged = [...(_tagRegistry.get(assetName) ?? [])];
                    if (tagged.length) templateObj = tagged[0].obj;
                }
                // Try prefab by name (case-insensitive)
                if (!templateObj && state.prefabs?.length) {
                    prefabTemplate = state.prefabs.find(p =>
                        p.name === assetName ||
                        p.name?.toLowerCase() === assetName?.toLowerCase() ||
                        p.id === assetName
                    );
                    if (prefabTemplate) {
                        asset = state.assets.find(a => a.id === prefabTemplate.assetId);
                        if (!asset) {
                            _logConsole(`spawnObject: prefab "${assetName}" has no asset`, '#facc15');
                            return null;
                        }
                    }
                }
                if (!templateObj && !prefabTemplate) {
                    _logConsole(`spawnObject: "${assetName}" not found as asset, object, tag, or prefab`, '#facc15');
                    return null;
                }
                if (!asset) {
                    asset = state.assets.find(a => a.id === templateObj.assetId);
                    if (!asset) { _logConsole(`spawnObject: template "${assetName}" has no asset`, '#facc15'); return null; }
                }
            }

            const dp = _makeDeferredProxy(wx, wy);
            import('./engine.objects.js').then(({ createImageObject }) => {
                const newObj = createImageObject(asset, wx * 100, -wy * 100, { silent: true });
                if (!newObj) return;
                if (newObj._gizmoContainer) newObj._gizmoContainer.visible = false;

                // Deep-copy all properties from template or prefab if found
                if (templateObj) {
                    _deepCopyObjectProps(templateObj, newObj);
                } else if (prefabTemplate) {
                    // Apply prefab data: script, tag, physics settings, etc.
                    if (prefabTemplate.scriptName)  newObj.scriptName  = prefabTemplate.scriptName;
                    if (prefabTemplate.scriptTag)   newObj._scriptTag  = prefabTemplate.scriptTag;
                    if (prefabTemplate.physicsBody && prefabTemplate.physicsBody !== 'none') {
                        newObj.physicsBody          = prefabTemplate.physicsBody;
                        newObj.physicsFriction      = prefabTemplate.physicsFriction      ?? 0.3;
                        newObj.physicsRestitution   = prefabTemplate.physicsRestitution   ?? 0.1;
                        newObj.physicsDensity       = prefabTemplate.physicsDensity       ?? 0.001;
                        newObj.physicsGravityScale  = prefabTemplate.physicsGravityScale  ?? 1;
                        newObj.physicsLinearDamping = prefabTemplate.physicsLinearDamping ?? 0;
                        newObj.physicsFixedRotation = !!prefabTemplate.physicsFixedRotation;
                    }
                    if (prefabTemplate.animations?.length) {
                        newObj.animations      = JSON.parse(JSON.stringify(prefabTemplate.animations));
                        newObj.activeAnimIndex = prefabTemplate.activeAnimIndex || 0;
                    }
                    newObj.prefabId = prefabTemplate.id;
                }

                // Run onSpawned callback first (lets caller override position/velocity/etc.)
                if (onSpawned) {
                    try { onSpawned(_makeProxy(newObj)); }
                    catch (e) {
                        const friendly = _friendlyScriptError(e, null, 'spawnObject callback', newObj?.label ?? '?', 'onSpawned');
                        for (const line of friendly) _logConsole(line, '#f87171');
                        import('./engine.console.js').then(m => m.recordPlayError());
                    }
                }

                // Resolve deferred proxy so any queued property writes are applied
                dp._resolve(newObj);

                // Auto-start the object's script if it has one and play mode is running
                if (newObj.scriptName && window._zState?.isPlaying) {
                    const rec = getScript(newObj.scriptName);
                    if (rec?.code) {
                        try {
                            const inst = _newScriptInstance(newObj, newObj.scriptName, rec.code);
                            _instances.push(inst);
                            inst.start();
                        } catch(e) {
                            const friendly = _friendlyScriptError(e, null, newObj.scriptName, newObj.label, 'spawn-start');
                            for (const line of friendly) _logConsole(line, '#f87171');
                        }
                    }
                }
            }).catch(e => {
                _logConsole(`spawnObject("${assetName}"): module load failed — ${e?.message ?? e}`, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            });
            return dp;
        },

        /**
         * Clone THIS object at a given position — a perfect copy of yourself.
         * Copies all properties: scale, rotation, alpha, physics, tags, AND your script.
         * The clone runs its own independent copy of the script immediately.
         *
         *   cloneSelf(5, 0)                          — clone self at world (5, 0)
         *   cloneSelf(getX(), getY(), (c) => {        — clone at same spot, push it right
         *     c.velocityX = 5;
         *   })
         *   cloneSelf(getX() + 2, getY())             — spawn 2 units to the right
         */
        /**
         * Pass initial opts as 3rd arg (object), callback as 4th.
         * Backward-compatible: 3rd arg can still be the callback function.
         *   cloneSelf(x, y, { speed:5, damage:2 }, (c) => { ... })
         *   cloneSelf(x, y, (c) => { c.velocityX = 3 })  — old style still works
         */
        cloneSelf(wx, wy, optsOrCb = null, onSpawnedArg = null) {
            let onSpawned = onSpawnedArg;
            let initOpts  = null;
            if (typeof optsOrCb === 'function') { onSpawned = optsOrCb; }
            else if (optsOrCb && typeof optsOrCb === 'object') { initOpts = optsOrCb; }
            const asset = state.assets.find(a => a.id === obj.assetId);
            if (!asset) {
                _logConsole(`cloneSelf: object "${obj.label}" has no asset to clone from`, '#facc15');
                return null;
            }
            // Guard: max 128 runtime clones to prevent accidental infinite cascades
            const liveClones = state.gameObjects.filter(o => o._isClone).length;
            if (liveClones >= 128) {
                _logConsole(`cloneSelf: clone limit (128) reached — call destroySelf() on old clones first`, '#f87171');
                return null;
            }
            const dp = _makeDeferredProxy(wx, wy);
            import('./engine.objects.js').then(({ createImageObject }) => {
                const newObj = createImageObject(asset, wx * 100, -wy * 100, { silent: true });
                if (!newObj) return;
                if (newObj._gizmoContainer) newObj._gizmoContainer.visible = false;
                _deepCopyObjectProps(obj, newObj);
                // Track which original spawned this clone
                newObj._cloneSource = obj;
                newObj._cloneId     = (obj._cloneCounter = (obj._cloneCounter ?? 0) + 1);
                // Apply initial opts (set via cloneSelf(x,y,{speed:5},cb))
                if (initOpts) Object.assign(newObj._opts, initOpts);

                if (onSpawned) {
                    try { onSpawned(_makeProxy(newObj)); }
                    catch (e) {
                        const friendly = _friendlyScriptError(e, null, 'cloneSelf callback', newObj?.label ?? '?', 'onSpawned');
                        for (const line of friendly) _logConsole(line, '#f87171');
                    }
                }

                // Resolve deferred proxy — applies any queued property writes
                dp._resolve(newObj);

                if (newObj.scriptName && window._zState?.isPlaying) {
                    const rec = getScript(newObj.scriptName);
                    if (rec?.code) {
                        try {
                            const inst = _newScriptInstance(newObj, newObj.scriptName, rec.code);
                            _instances.push(inst);
                            inst.start();
                        } catch(e) {
                            const friendly = _friendlyScriptError(e, null, newObj.scriptName, newObj.label, 'cloneSelf-start');
                            for (const line of friendly) _logConsole(line, '#f87171');
                        }
                    }
                }
            }).catch(e => {
                _logConsole(`cloneSelf: module load failed — ${e?.message ?? e}`, '#f87171');
            });
            return dp;
        },

        /**
         * Clone THIS object at its current position — shorthand for cloneSelf(x, y).
         * cloneInPlace()
         * cloneInPlace((c) => { c.velocityX = 5; })
         */
        cloneInPlace(onSpawned = null) {
            return this.cloneSelf(obj.x / 100, -(obj.y / 100), onSpawned);
        },

        /**
         * Clone any object by name or tag at a given position.
         * Works exactly like spawnObject but always uses the first matching instance
         * as the template — so it copies that instance's current scale, physics, tags, script.
         *
         *   cloneObject("Enemy", 5, 0)
         *   cloneObject("enemy", 5, 0, (c) => { c.velocityX = 3; })
         *   cloneObject(find("Boss"), 0, 0)   — pass a proxy directly
         */
        cloneObject(nameOrProxy, wx, wy, onSpawned = null) {
            let templateObj = null;
            if (nameOrProxy && nameOrProxy._ref) {
                // Received a proxy directly
                templateObj = nameOrProxy._ref;
            } else if (typeof nameOrProxy === 'string') {
                templateObj = state.gameObjects.find(o => o.label === nameOrProxy);
                if (!templateObj) {
                    const tagged = [...(_tagRegistry.get(nameOrProxy) ?? [])];
                    if (tagged.length) templateObj = tagged[0].obj;
                }
            }
            if (!templateObj) {
                _logConsole(`cloneObject: "${nameOrProxy}" not found`, '#facc15');
                return null;
            }
            const asset = state.assets.find(a => a.id === templateObj.assetId);
            if (!asset) { _logConsole(`cloneObject: template has no asset`, '#facc15'); return null; }

            const dp = _makeDeferredProxy(wx, wy);
            import('./engine.objects.js').then(({ createImageObject }) => {
                const newObj = createImageObject(asset, wx * 100, -wy * 100, { silent: true });
                if (!newObj) return;
                if (newObj._gizmoContainer) newObj._gizmoContainer.visible = false;
                _deepCopyObjectProps(templateObj, newObj);

                if (onSpawned) {
                    try { onSpawned(_makeProxy(newObj)); }
                    catch (e) {
                        const friendly = _friendlyScriptError(e, null, 'cloneObject callback', newObj?.label ?? '?', 'onSpawned');
                        for (const line of friendly) _logConsole(line, '#f87171');
                    }
                }

                // Resolve deferred proxy — applies any queued property writes
                dp._resolve(newObj);

                if (newObj.scriptName && window._zState?.isPlaying) {
                    const rec = getScript(newObj.scriptName);
                    if (rec?.code) {
                        try {
                            const inst = _newScriptInstance(newObj, newObj.scriptName, rec.code);
                            _instances.push(inst);
                            inst.start();
                        } catch(e) {
                            const friendly = _friendlyScriptError(e, null, newObj.scriptName, newObj.label, 'cloneObject-start');
                            for (const line of friendly) _logConsole(line, '#f87171');
                        }
                    }
                }
            }).catch(e => {
                _logConsole(`cloneObject: module load failed — ${e?.message ?? e}`, '#f87171');
            });
            return dp;
        },

        // ── RAYCAST (AABB slab method) ────────────────────────
        /**
         * Cast a ray from (x1,y1) to (x2,y2) and return the FIRST object hit.
         * Uses the correct AABB slab intersection test.
         *
         * raycast(0, 0, 10, 0)            — hit any object
         * raycast(0, 0, 10, 0, "enemy")   — hit only "enemy" tagged objects
         * Returns: { hit, point:{x,y}, normal:{x,y}, distance } or null
         */
        // ── Tilemap/AutoTilemap AABB per-tile raycast ────────────────────────────
        _raycastTilemapHits(px1, py1, px2, py2, rdx, rdy, rlen, tmObj) {
            let tileW, tileH, cols, rows, tileCount, isFilled;
            if (tmObj.isTilemap && tmObj.tilemapData) {
                const d = tmObj.tilemapData;
                ({ tileW, tileH, cols, rows } = d);
                const tiles = d.tiles;
                if (!tiles || cols <= 0 || rows <= 0) return [];
                tileCount = cols * rows;
                isFilled  = i => tiles[i] >= 0;
            } else if (tmObj.isAutoTilemap && tmObj.autoTileData) {
                const d = tmObj.autoTileData;
                ({ tileW, tileH, cols, rows } = d);
                const cells = d.cells;
                if (!cells || cols <= 0 || rows <= 0) return [];
                tileCount = cols * rows;
                isFilled  = i => Array.isArray(cells[i]) && cells[i].length > 0;
            } else {
                return [];
            }
            const tw = tileW * Math.abs(tmObj.scale?.x ?? 1);
            const th = tileH * Math.abs(tmObj.scale?.y ?? 1);
            const ox = tmObj.x, oy = tmObj.y;
            const hits = [];
            for (let i = 0; i < tileCount; i++) {
                if (!isFilled(i)) continue;
                const col = i % cols, row = Math.floor(i / cols);
                const left = ox + col*tw, right = left+tw;
                const top  = oy + row*th, bottom = top+th;
                const invDx = rdx !== 0 ? 1/rdx : Infinity;
                const invDy = rdy !== 0 ? 1/rdy : Infinity;
                let tx1=(left-px1)*invDx, tx2=(right-px1)*invDx;
                let ty1=(top-py1)*invDy,  ty2=(bottom-py1)*invDy;
                if (tx1>tx2){const s=tx1;tx1=tx2;tx2=s;}
                if (ty1>ty2){const s=ty1;ty1=ty2;ty2=s;}
                const tmin=Math.max(tx1,ty1), tmax=Math.min(tx2,ty2);
                if (tmin>tmax||tmax<0||tmin>1) continue;
                const t=Math.max(0,tmin);
                let nx=0, ny=0;
                if (tx1>ty1){nx=rdx<0?1:-1;}else{ny=rdy<0?1:-1;}
                const hx=px1+t*rdx, hy=py1+t*rdy;
                hits.push({ isTile:true, tmObj, tileRow:row, tileCol:col,
                    tileIndex: tmObj.isTilemap ? tmObj.tilemapData.tiles[i] : i,
                    point:{x:hx/100,y:-hy/100}, normal:{x:nx,y:-ny},
                    distance:t*rlen/100, fraction:t, t });
            }
            hits.sort((a,b)=>a.t-b.t);
            return hits;
        },

        raycast(x1, y1, x2, y2, tag = null) {
            // tag='colliders' → only physics bodies + tilemaps (skip backgrounds/decorations)
            const px1=x1*100, py1=-y1*100, px2=x2*100, py2=-y2*100;
            const rdx=px2-px1, rdy=py2-py1;
            const rlen=Math.sqrt(rdx*rdx+rdy*rdy);
            if (rlen===0) return null;
            const collidersOnly = tag==='colliders';
            const useTag = !collidersOnly && tag!=null;
            const passes = o => {
                if (!o.visible||o===obj) return false;
                if (collidersOnly) return (o.physicsBody??'none')!=='none'||o.isTilemap||o.isAutoTilemap;
                if (useTag) return (o._scriptTag??'')===String(tag);
                return true;
            };
            let candidates = useTag
                ? [...(_tagRegistry.get(tag)||[])].map(i=>i.obj)
                : state.gameObjects;
            if (useTag || collidersOnly) {
                // Include tilemaps/autotilemaps that pass the filter
                for (const o of state.gameObjects)
                    if ((o.isTilemap||o.isAutoTilemap)&&passes(o)&&!candidates.includes(o))
                        candidates.push(o);
            }
            let best=null, bestT=1.0001, bestNx=0, bestNy=0;
            let bestIsTile=false, bestTileData=null;
            for (const o of candidates) {
                if (!passes(o)) continue;
                if (o.isTilemap||o.isAutoTilemap) {
                    const hs=this._raycastTilemapHits(px1,py1,px2,py2,rdx,rdy,rlen,o);
                    if (hs.length>0&&hs[0].t<bestT) {
                        const h=hs[0]; bestT=h.t; best=o;
                        bestNx=h.normal.x; bestNy=-h.normal.y;
                        bestIsTile=true; bestTileData=h;
                    }
                    continue;
                }
                const bb=_getAABB(o);
                const iDx=rdx!==0?1/rdx:Infinity, iDy=rdy!==0?1/rdy:Infinity;
                let tx1=(bb.left-px1)*iDx, tx2=(bb.right-px1)*iDx;
                let ty1=(bb.top-py1)*iDy,  ty2=(bb.bottom-py1)*iDy;
                if(tx1>tx2){const s=tx1;tx1=tx2;tx2=s;}
                if(ty1>ty2){const s=ty1;ty1=ty2;ty2=s;}
                const tmin=Math.max(tx1,ty1),tmax=Math.min(tx2,ty2);
                if(tmin>tmax||tmax<0||tmin>1) continue;
                const t=Math.max(0,tmin);
                if(t<bestT){
                    bestT=t; best=o; bestIsTile=false;
                    if(tx1>ty1){bestNx=rdx<0?1:-1;bestNy=0;}
                    else{bestNx=0;bestNy=rdy<0?1:-1;}
                }
            }
            if(window._zeGizmos?.raycasts){
                const gz=window._zeGizmos, col=gz.raycastColor??'#00ff44';
                const dur=gz.raycastDuration??0.12, wid=gz.raycastWidth??2;
                const ex=best?px1+bestT*rdx:px2, ey=best?py1+bestT*rdy:py2;
                _debugLines.push({x1,y1,x2:ex/100,y2:-ey/100,color:col,remaining:dur,width:wid,alpha:0.92});
                if(best)_debugLines.push({x1:ex/100,y1:-ey/100,x2:ex/100,y2:-ey/100,circle:0.07,color:'#fff',remaining:dur,width:3,alpha:1});
            }
            if(!best) return null;
            const hx=px1+bestT*rdx, hy=py1+bestT*rdy;
            const result=_makeProxy(best);
            result._rayHit={
                point:{x:hx/100,y:-hy/100}, normal:{x:bestNx,y:-bestNy},
                distance:bestT*rlen/100, fraction:bestT,
                isTile:bestIsTile,
                tile:bestTileData?{row:bestTileData.tileRow,col:bestTileData.tileCol,index:bestTileData.tileIndex}:null,
            };
            // Flat shortcuts — hit.point.x, hit.normal.x, hit.distance, hit.isTile
            result.point    = result._rayHit.point;
            result.normal   = result._rayHit.normal;
            result.distance = result._rayHit.distance;
            result.fraction = result._rayHit.fraction;
            result.isTile   = result._rayHit.isTile;
            result.tile     = result._rayHit.tile;
            // hit.sprite is an alias for the proxy — hit.sprite.takeDamage(10), hit.sprite.name, etc.
            result.sprite   = result;
            return result;
        },

        raycastAll(x1, y1, x2, y2, tag = null) {
            const px1=x1*100,py1=-y1*100,px2=x2*100,py2=-y2*100;
            const rdx=px2-px1,rdy=py2-py1;
            const rlen=Math.sqrt(rdx*rdx+rdy*rdy);
            if(rlen===0) return [];
            const collidersOnly=tag==='colliders';
            const useTag=!collidersOnly&&tag!=null;
            const passes=o=>{
                if(!o.visible||o===obj)return false;
                if(collidersOnly)return(o.physicsBody??'none')!=='none'||o.isTilemap||o.isAutoTilemap;
                if(useTag)return(o._scriptTag??'')===String(tag);
                return true;
            };
            let candidates=useTag?[...(_tagRegistry.get(tag)||[])].map(i=>i.obj):state.gameObjects;
            if(useTag||collidersOnly){
                for(const o of state.gameObjects)
                    if((o.isTilemap||o.isAutoTilemap)&&passes(o)&&!candidates.includes(o))
                        candidates.push(o);
            }
            const hits=[];
            for(const o of candidates){
                if(!passes(o)) continue;
                if(o.isTilemap||o.isAutoTilemap){
                    const hs=this._raycastTilemapHits(px1,py1,px2,py2,rdx,rdy,rlen,o);
                    for(const h of hs){
                        const r=_makeProxy(o);
                        r._rayHit={point:h.point,normal:h.normal,distance:h.distance,fraction:h.t,isTile:true,tile:{row:h.tileRow,col:h.tileCol,index:h.tileIndex}};
                        r.point=r._rayHit.point; r.normal=r._rayHit.normal; r.distance=r._rayHit.distance;
                        r.fraction=r._rayHit.fraction; r.isTile=true; r.tile=r._rayHit.tile; r.sprite=r;
                        hits.push({proxy:r,t:h.t});
                    }
                    continue;
                }
                const bb=_getAABB(o);
                const iDx=rdx!==0?1/rdx:Infinity,iDy=rdy!==0?1/rdy:Infinity;
                let tx1=(bb.left-px1)*iDx,tx2=(bb.right-px1)*iDx;
                let ty1=(bb.top-py1)*iDy, ty2=(bb.bottom-py1)*iDy;
                if(tx1>tx2){const s=tx1;tx1=tx2;tx2=s;}
                if(ty1>ty2){const s=ty1;ty1=ty2;ty2=s;}
                const tmin=Math.max(tx1,ty1),tmax=Math.min(tx2,ty2);
                if(tmin>tmax||tmax<0||tmin>1) continue;
                const t=Math.max(0,tmin);
                let nx=0,ny=0;
                if(tx1>ty1){nx=rdx<0?1:-1;}else{ny=rdy<0?1:-1;}
                const hx=px1+t*rdx,hy=py1+t*rdy;
                const r=_makeProxy(o);
                r._rayHit={point:{x:hx/100,y:-hy/100},normal:{x:nx,y:-ny},distance:t*rlen/100,fraction:t,isTile:false,tile:null};
                r.point=r._rayHit.point; r.normal=r._rayHit.normal; r.distance=r._rayHit.distance;
                r.fraction=r._rayHit.fraction; r.isTile=false; r.tile=null; r.sprite=r;
                hits.push({proxy:r,t});
            }
            hits.sort((a,b)=>a.t-b.t);
            if(window._zeGizmos?.raycasts){
                const gz=window._zeGizmos,col=gz.raycastColor??'#00ff44';
                const dur=gz.raycastDuration??0.12,wid=gz.raycastWidth??2;
                if(hits.length){const h=hits[0],ft=h.t;const ex=px1+ft*rdx,ey=py1+ft*rdy;_debugLines.push({x1,y1,x2:ex/100,y2:-ey/100,color:col,remaining:dur,width:wid,alpha:0.92});}
                else _debugLines.push({x1,y1,x2,y2,color:col,remaining:dur,width:wid,alpha:0.45});
            }
            return hits.map(h=>h.proxy);
        },

        /**
         * Cast a ray from THIS object's position at a given angle.
         * raycastFromSelf(0, 10)              — cast rightward 10 units
         * raycastFromSelf(90, 5, "wall")      — cast upward 5 units, only walls
         * angle: degrees (0=right, 90=up, 180=left, 270=down)
         */
        raycastFromSelf(angleDeg, distance, tag = null) {
            const rad = (angleDeg * Math.PI) / 180;
            const sx  = obj.x / 100;
            const sy  = -(obj.y / 100);
            const ex  = sx + Math.cos(rad) * distance;
            const ey  = sy + Math.sin(rad) * distance;
            return this.raycast(sx, sy, ex, ey, tag);
        },

        // ── PATHFINDING / NAVIGATION ─────────────────────────
        /**
         * Walk from current position to a world coordinate, avoiding obstacles.
         *
         *   walkTo(5, 3, { speed: 4, avoidTag: "wall", onDone: () => log("arrived") })
         *   walkTo(5, 3, { speed: 4, avoidStatic: true })
         *   walkTo(5, 3, { speed: 4, avoidGroup: "walls", avoidTag: "barrier" })
         *   walkTo(5, 3, { speed: 4, avoidAll: true })   // avoid every physics body
         *
         * Options:
         *   speed        — world units/sec (default 3)
         *   avoidTag     — tag string (or array) of objects to avoid
         *   avoidGroup   — group string (or array) of objects to avoid
         *   avoidStatic  — true → avoid all physicsBody='static' objects
         *   avoidAll     — true → avoid all objects with any physics body
         *   stopRadius   — arrival distance in world units (default 0.3)
         *   minHoleSize  — minimum gap width (world units) the agent can squeeze through;
         *                  smaller gaps are treated as blocked (default: auto from sprite)
         *   onDone       — callback fired on arrival
         *   agentRadius  — half-size of agent for clearance (default: auto from sprite)
         *   cellSize     — A* grid cell size in world units (default: auto)
         *   debug        — true → draw the path with debugLine
         *   smooth       — false → disable path smoothing (default: true)
         */
        walkTo(tx, ty, opts = {}) {
            _navStartWalk(obj, api, tx, ty, opts);
        },

        /**
         * Walk toward another object (or its current position if it moves).
         *
         *   walkToObject("Player", { speed: 3, avoidTag: "wall" })
         *   walkToObject(find("Enemy"), { speed: 5, avoidStatic: true })
         *   walkToObject("chest", { speed: 4, stopRadius: 1, onDone: () => open() })
         *
         * The target position is re-sampled every repath seconds (default 0.5).
         * Options: same as walkTo plus:
         *   repath       — how often to recalculate path (default 0.5s)
         *   follow       — keep following even after arrival (default: false)
         *   minHoleSize  — minimum gap width (world units) the agent can navigate through
         */
        walkToObject(targetOrName, opts = {}) {
            let target = null;
            if (typeof targetOrName === 'string') {
                // Try label first, then tag
                target = state.gameObjects.find(o => o.label === targetOrName);
                if (!target) {
                    const tagged = [...(_tagRegistry.get(targetOrName) ?? [])];
                    if (tagged.length) target = tagged[0].obj;
                }
            } else if (targetOrName?._ref) {
                target = targetOrName._ref;
            } else if (targetOrName?.label) {
                target = targetOrName;
            }
            if (!target) {
                _logConsole(`walkToObject: "${targetOrName}" not found`, '#facc15');
                return;
            }
            _navStartFollow(obj, api, target, opts);
        },

        /** Stop any active walkTo / walkToObject immediately. */
        stopWalking() {
            _navStop(obj);
        },

        /** True if a walkTo or walkToObject is currently in progress. */
        get isWalking() {
            return !!obj._nav && obj._nav.active;
        },

        /** Current navigation path as array of {x,y} world points, or [] */
        get navPath() {
            return (obj._nav?.path ?? []).map(p => ({ x: p.x / 100, y: -p.y / 100 }));
        },

        // ── SMART AI NAVIGATION ───────────────────────────────

        /**
         * pursue(targetOrName, opts)
         * Predictive chase — intercepts a moving target by extrapolating its
         * velocity instead of chasing its current position.
         * All options are identical to walkToObject, plus:
         *   predictTime  — seconds ahead to predict (default 0.5)
         *   separation   — avoid clustering with other nav agents
         *
         *   pursue("player", { speed: 3, avoidStatic: true, predictTime: 0.5 })
         */
        pursue(targetOrName, opts = {}) {
            let target = null;
            if (typeof targetOrName === 'string') {
                target = state.gameObjects.find(o => o.label === targetOrName);
                if (!target) {
                    const tagged = [...(_tagRegistry.get(targetOrName) ?? [])];
                    if (tagged.length) target = tagged[0].obj;
                }
            } else if (targetOrName?._ref) {
                target = targetOrName._ref;
            } else if (targetOrName?.label) {
                target = targetOrName;
            }
            if (!target) { _logConsole(`pursue: "${targetOrName}" not found`, '#facc15'); return; }
            _navStartFollow(obj, api, target, { ...opts, predict: true });
        },

        /**
         * flee(targetOrName, opts)
         * Run directly away from a target each frame (no pathfinding).
         * Call stopWalking() to stop.
         *   flee("player", { speed: 4 })
         *   flee(target, { speed: 3, separation: true })
         */
        flee(targetOrName, opts = {}) {
            let target = null;
            if (typeof targetOrName === 'string') {
                target = state.gameObjects.find(o => o.label === targetOrName);
                if (!target) {
                    const tagged = [...(_tagRegistry.get(targetOrName) ?? [])];
                    if (tagged.length) target = tagged[0].obj;
                }
            } else if (targetOrName?._ref) {
                target = targetOrName._ref;
            } else if (targetOrName?.label) {
                target = targetOrName;
            }
            if (!target) { _logConsole(`flee: "${targetOrName}" not found`, '#facc15'); return; }
            _navStartFlee(obj, api, target, opts);
        },

        /**
         * wander(opts)
         * Wander randomly around the scene.  Call stopWalking() to stop.
         *   wander({ speed: 1.5, radius: 3, changeInterval: 2 })
         */
        wander(opts = {}) {
            _navStartWander(obj, api, opts);
        },

        /**
         * canSee(targetOrName, opts) → boolean
         * Returns true when there is an unobstructed straight line between
         * this object and the target.  Uses the last built A* obstacle grid
         * when available; otherwise falls back to an AABB sweep.
         *   if (api.canSee("player")) { ... }
         *   if (api.canSee(target, { maxRange: 8 })) { ... }
         */
        canSee(targetOrName, opts = {}) {
            let target = null;
            if (typeof targetOrName === 'string') {
                target = state.gameObjects.find(o => o.label === targetOrName);
                if (!target) {
                    const tagged = [...(_tagRegistry.get(targetOrName) ?? [])];
                    if (tagged.length) target = tagged[0].obj;
                }
            } else if (targetOrName?._ref) {
                target = targetOrName._ref;
            } else if (targetOrName?.label) {
                target = targetOrName;
            }
            if (!target) return false;
            return navCanSee(obj, target, opts);
        },

        /**
         * lastKnownPos(targetOrName) → {x, y} | null
         * Returns the last world position this agent recorded seeing the target.
         * Entries expire automatically after ~10 seconds.
         *   var lkp = api.lastKnownPos("player");
         *   if (lkp) api.walkTo(lkp.x, lkp.y);
         */
        lastKnownPos(targetOrName) {
            const key = typeof targetOrName === 'string'
                ? targetOrName
                : (targetOrName?.label ?? String(targetOrName));
            const px = navGetLastKnownPos(obj, key);
            if (!px) return null;
            // Convert PIXI-pixel → world units (Y flip)
            return { x: px.x / 100, y: -px.y / 100 };
        },

        /**
         * inFOV(targetOrName, fovDeg, range) → boolean
         * True if the target is within the agent's forward-facing view cone.
         *   if (api.inFOV("player", 90, 6)) { setState("alert"); }
         */
        inFOV(targetOrName, fovDeg = 90, range = 0) {
            let target = null;
            if (typeof targetOrName === 'string') {
                target = state.gameObjects.find(o => o.label === targetOrName);
                if (!target) {
                    const tagged = [...(_tagRegistry.get(targetOrName) ?? [])];
                    if (tagged.length) target = tagged[0].obj;
                }
            } else if (targetOrName?._ref) {
                target = targetOrName._ref;
            } else if (targetOrName?.label) {
                target = targetOrName;
            }
            if (!target) return false;
            return navInFOV(obj, target, fovDeg, range);
        },

        /** True when the agent has not progressed enough recently (stuck). */
        get isStuck() {
            return navIsStuck(obj);
        },

        // ── RADIUS QUERY ──────────────────────────────────────
        /**
         * Find all objects within a circle radius in world units.
         * getObjectsInRadius(3, 4, 2)            — all objects within 2 units
         * getObjectsInRadius(3, 4, 2, "coin")    — only "coin" tagged objects
         * Returns: array of proxies
         */
        getObjectsInRadius(cx, cy, radius, tag = null) {
            const px  = cx * 100, py = -cy * 100;
            const pr2 = (radius * 100) ** 2;
            const candidates = tag
                ? [...(_tagRegistry.get(tag) || [])].map(i => i.obj)
                : state.gameObjects;
            const result = [];
            for (const o of candidates) {
                if (o === obj) continue;
                const ddx = o.x - px, ddy = o.y - py;
                if (ddx * ddx + ddy * ddy <= pr2) result.push(_makeProxy(o));
            }
            return result;
        },

        // ── Z-ORDER ───────────────────────────────────────────
        /** Set render order (higher = drawn on top). */
        setZOrder(n) {
            obj.zIndex = n;
            if (obj.parent?.sortChildren) obj.parent.sortChildren();
            else if (obj.parent) {
                // Manual sort for PIXI containers without sortableChildren
                obj.parent.children.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
            }
        },
        /** Get current render order. */
        getZOrder() { return obj.zIndex ?? 0; },

        // ── COORDINATE CONVERSION ─────────────────────────────
        /**
         * Convert screen pixel position → world units.
         * var pos = screenToWorld(e.clientX, e.clientY)
         * log(pos.x, pos.y)
         */
        screenToWorld(sx, sy) {
            const sc = state.sceneContainer;
            if (!sc) return { x: 0, y: 0 };
            return {
                x:  (sx - sc.x) / (sc.scale.x * 100),
                y: -(sy - sc.y) / (sc.scale.y * 100),
            };
        },
        /** Convert world position → screen pixels. */
        worldToScreen(wx, wy) {
            const sc = state.sceneContainer;
            if (!sc) return { x: 0, y: 0 };
            return {
                x:  wx * 100 * sc.scale.x + sc.x,
                y: -wy * 100 * sc.scale.y + sc.y,
            };
        },

        // ── ONE-LINE DRAG ──────────────────────────────────────
        /**
         * Make this object draggable with one line. The engine handles
         * click/tap to grab, smooth follow, and release — you do nothing else.
         *
         *   makeDraggable()
         *   makeDraggable({ smooth: 18, clamp: true, scale: 1.1,
         *                   onDrop: (x, y) => { log("dropped at", x, y) } })
         *
         * Options (all optional):
         *   smooth  — follow lag 0–30 (default 16, 0 = instant snap)
         *   clamp   — keep inside game canvas (default false)
         *   scale   — scale factor while held (default 1.08)
         *   onDrop(x, y) — called when released, receives world position
         */
        makeDraggable(opts = {}) {
            const smooth   = opts.smooth  ?? 16;
            const clamp    = opts.clamp   ?? false;
            const scaleMul = opts.scale   ?? 1.08;
            const onDrop   = opts.onDrop  ?? null;
            let   held     = false;
            let   origSX   = 1, origSY = 1;

            const release = () => {
                if (!held) return;
                held = false;
                obj.scale.x = origSX;
                obj.scale.y = origSY;
                if (_activeDragObj === obj) {
                    if (onDrop) {
                        try { onDrop(obj.x / 100, -obj.y / 100); } catch(_){}
                    }
                    _activeDragObj  = null;
                    _activeDragOpts = {};
                }
            };

            const grab = () => {
                if (held) return;
                held   = true;
                origSX = obj.scale.x;
                origSY = obj.scale.y;
                obj.scale.x = origSX * scaleMul;
                obj.scale.y = origSY * scaleMul;
                _activeDragObj  = obj;
                _activeDragOpts = { smooth, clampToGameBounds: clamp,
                    onDrop: () => release()
                };
            };

            // Grab fires on MOUSEDOWN (pointer over the object) — NOT on click/up.
            // instRef is the [instance] wrapper array — instRef[0] is the live ScriptInstance.
            const inst = instRef[0];
            if (inst) {
                inst._onDragMouseDown = grab;
                inst._onMouseClick    = null;
                inst._dragReleaseHook = release;
            }
        },
        /**
         * Make this object (or another) follow the mouse/finger precisely.
         * Call once — usually inside onMouseClick or when mouseJustDown().
         *
         *   dragObject()                      — drag THIS object
         *   dragObject(find("Crate"))         — drag a different object
         *   dragObject(null, { clampToGameBounds: true })
         *
         * Options:
         *   offsetX / offsetY   — world-unit offset from cursor centre (default 0)
         *   clampToGameBounds   — keep inside game canvas (default false)
         *   onDrop(obj) fn      — called once when finger/mouse is released
         */
        dragObject(target, opts = {}) {
            const dragObj = (target && target._ref)              ? target._ref
                          : (target && target.x !== undefined)   ? target
                          : obj;
            _activeDragObj  = dragObj;
            _activeDragOpts = opts || {};
        },
        /** Stop dragging (calls onDrop if provided). */
        stopDrag() {
            if (_activeDragOpts?.onDrop && _activeDragObj) {
                try { _activeDragOpts.onDrop(_activeDragObj); } catch(_) {}
            }
            _activeDragObj  = null;
            _activeDragOpts = {};
            _throwVelX = _throwVelY = _throwPrevX = _throwPrevY = 0;
        },
        /** True while a drag is active. */
        get isDragging() { return !!_activeDragObj; },

        // ── ONE-LINE DRAG-AND-THROW ───────────────────────────────
        /**
         * Make this object draggable AND throwable in one line.
         * Works on kinematic and dynamic physics bodies (and plain objects).
         * When released, the object keeps the velocity it was moving at.
         *
         *   makeThrowable()
         *   makeThrowable({ smooth: 0, speed: 1.4, maxSpeed: 20,
         *                   clamp: true, scale: 1.1,
         *                   onThrow: (vx, vy) => { log("thrown!", vx, vy) } })
         *
         * Options (all optional):
         *   smooth   — follow lag 0–30 (default 0 = instant, recommended for throw)
         *   speed    — velocity multiplier applied at release (default 1)
         *   maxSpeed — cap on throw speed in world units/sec (default none)
         *   clamp    — keep inside game canvas while dragging (default false)
         *   scale    — scale factor while held (default 1.08)
         *   onThrow(vx, vy) — called on release with the throw velocity
         */
        makeThrowable(opts = {}) {
            const smooth   = opts.smooth  ?? 0;
            const clamp    = opts.clamp   ?? false;
            const scaleMul = opts.scale   ?? 1.08;
            const onThrow  = opts.onThrow ?? null;
            let   held     = false;
            let   origSX   = 1, origSY = 1;

            const release = () => {
                if (!held) return;
                held = false;
                obj.scale.x = origSX;
                obj.scale.y = origSY;
                if (_activeDragObj === obj) {
                    // Snapshot velocity BEFORE clearing state so onThrow callback gets correct values
                    const speedMul = opts.speed ?? 1;
                    const capVx = _throwVelX * speedMul;
                    const capVy = _throwVelY * speedMul;
                    // Apply throw — _activeDragOpts still live here so _applyThrowVelocity can read opts
                    try { _applyThrowVelocity(obj); } catch(_) {}
                    // Clear AFTER applying
                    _activeDragObj  = null;
                    _activeDragOpts = {};
                    _throwVelX = _throwVelY = _throwPrevX = _throwPrevY = 0;
                    if (onThrow) {
                        try { onThrow(capVx, capVy); } catch(_) {}
                    }
                }
            };

            const grab = () => {
                if (held) return;
                held   = true;
                origSX = obj.scale.x;
                origSY = obj.scale.y;
                obj.scale.x = origSX * scaleMul;
                obj.scale.y = origSY * scaleMul;
                // Seed throw tracking from current position
                _throwVelX = _throwVelY = 0;
                _throwPrevX = obj.x / 100;
                _throwPrevY = -obj.y / 100;
                _activeDragObj  = obj;
                _activeDragOpts = {
                    smooth,
                    clampToGameBounds: clamp,
                    throw:    true,
                    speed:    opts.speed    ?? 1,
                    maxSpeed: opts.maxSpeed ?? null,
                    _throwAlpha: 0.2,
                    // onDrop fires from _onDragMouseUp.
                    // It calls release() which applies throw then clears state.
                    // _onDragMouseUp will NOT double-apply because opts.onDrop is set.
                    onDrop: () => release(),
                };
            };

            const inst = instRef[0];
            if (inst) {
                inst._onDragMouseDown = grab;
                inst._onMouseClick    = null;
                inst._dragReleaseHook = release;
            }
        },

        /**
         * Low-level: start throw-dragging an object right now.
         * Like dragObject() but applies physics velocity on release.
         * Call from onMouseClick or mouseJustDown().
         *
         *   throwObject()                        — throw THIS object
         *   throwObject(find("Ball"))            — throw another object
         *   throwObject(null, { speed: 1.5, maxSpeed: 30 })
         *
         * Options:
         *   offsetX / offsetY  — world-unit offset from cursor (default 0)
         *   clampToGameBounds  — keep inside canvas while dragging (default false)
         *   speed              — velocity multiplier at release (default 1)
         *   maxSpeed           — cap in world units/sec (default none)
         *   onDrop(obj)        — called on release
         */
        throwObject(target, opts = {}) {
            const dragObj = (target && target._ref)             ? target._ref
                          : (target && target.x !== undefined)  ? target
                          : obj;
            _throwVelX = _throwVelY = 0;
            _throwPrevX = dragObj.x / 100;
            _throwPrevY = -dragObj.y / 100;
            _activeDragObj  = dragObj;
            _activeDragOpts = {
                ...(opts || {}),
                throw: true,
                _throwAlpha: 0.25,
            };
        },

        // ── VIRTUAL JOYSTICK ─────────────────────────────────────
        /**
         * Create a virtual on-screen joystick for mobile/touch.
         *
         *   var joy = createJoystick()
         *   var joy = createJoystick({
         *     x: 150, y: 150,         // screen px from bottom-left (default 150,150)
         *     fixed: true,             // true=fixed position, false=spawns at touch (default false)
         *     size: 120,               // outer ring diameter in px (default 120)
         *     knobSize: 54,            // inner knob diameter in px (default size*0.45)
         *     baseColor: "#ffffff33",  // ring fill color
         *     knobColor: "#ffffffaa",  // knob fill color
         *     borderColor: "#ffffff66",// ring border color
         *     deadzone: 0.1,           // axis dead-zone 0–1 (default 0.1)
         *     opacity: 0.85,           // overall opacity (default 0.85)
         *     zIndex: 9500,            // CSS z-index
         *   })
         *
         * Handle properties:
         *   joy.axisH      — horizontal axis −1…1  (left < 0 < right)
         *   joy.axisV      — vertical axis   −1…1  (down < 0 < up, game-space)
         *   joy.angle      — angle in degrees (0=right, 90=up, 180=left, 270=down)
         *   joy.magnitude  — 0…1 (0=center, 1=full tilt)
         *   joy.active     — true while a finger is touching
         *   joy.destroy()  — remove the joystick from the screen
         */
        createJoystick(opts = {}) {
            return _createJoystick(opts);
        },
        /** Destroy every joystick created this session. */
        destroyAllJoysticks() { _destroyAllJoysticks(); },

        // ── KEY EVENT HANDLERS ────────────────────────────────
        /**
         * Register a callback fired once when a key is pressed.
         * onKeyDown("space", () => { jump(); })
         */
        onKeyDown(key, fn) { _keyDownHandlers.set(key.toLowerCase(), fn); },
        /** Register a callback fired once when a key is released. */
        onKeyUp(key, fn)   { _keyUpHandlers.set(key.toLowerCase(), fn); },

        // ── MOBILE / GESTURE HANDLERS ────────────────────────────

        /**
         * One-finger swipe. direction: "left"|"right"|"up"|"down"|"any"
         *   onSwipe("left",  () => { velocityX = -5; });
         *   onSwipe("any",   (dir) => { log("swiped " + dir); });
         */
        onSwipe(direction, fn) {
            _swipeHandlers.set(String(direction).toLowerCase(), fn);
        },

        /**
         * Two-finger swipe. direction: "left"|"right"|"up"|"down"|"any"
         * Useful for scrolling/panning the camera while one finger controls a character.
         *   onMultiSwipe("up", () => { camera.y += 2; });
         */
        onMultiSwipe(direction, fn) {
            _multiSwipeHandlers.set(String(direction).toLowerCase(), fn);
        },

        /**
         * Two-finger pinch — fires every frame while pinching.
         * scale > 1 means fingers are spreading apart (zoom in).
         * scale < 1 means fingers are closing together (zoom out).
         * Scale resets to 1.0 at the start of each new pinch gesture.
         *   onPinch((scale) => { obj.scaleX *= scale; obj.scaleY *= scale; });
         */
        onPinch(fn) { _pinchHandler = fn; },

        /**
         * Fires when fingers are spreading apart (zoom in direction).
         * fn receives the current scale value (always > 1 relative to pinch start).
         *   onPinchIn((scale) => { camera.zoom *= 1.02; });
         */
        onPinchIn(fn) { _pinchInHandler = fn; },

        /**
         * Fires when fingers are moving closer together (zoom out direction).
         * fn receives the current scale value (always < 1 relative to pinch start).
         *   onPinchOut((scale) => { camera.zoom *= 0.98; });
         */
        onPinchOut(fn) { _pinchOutHandler = fn; },

        /**
         * Two-finger rotation. fn receives the rotation DELTA in degrees this frame.
         * Positive = clockwise, negative = counter-clockwise.
         *   onRotate((deg) => { setRotation(getRotation() + deg); });
         */
        onRotate(fn) { _rotateHandler = fn; },

        /**
         * Short tap (works on touch AND mouse click).
         *   onTap(() => { jump(); });
         */
        onTap(fn) { _tapHandler = fn; },

        /**
         * Double tap / double click.
         *   onDoubleTap(() => { dash(); });
         */
        onDoubleTap(fn) { _doubleTapHandler = fn; },

        /**
         * Long press — fires after ~500ms of holding without moving.
         *   onLongPress(() => { openContextMenu(); });
         */
        onLongPress(fn) { _longPressHandler = fn; },

        /**
         * Fires when any finger touches the screen this frame.
         * fn receives the touches array: [{id, x, y}]
         *   onTouchStart((touches) => { log("fingers:", touches.length); });
         */
        onTouchStart(fn) { _touchStartHandler = fn; },

        /**
         * Fires when a finger lifts from the screen this frame.
         * fn receives the remaining touches array.
         *   onTouchEnd((touches) => { if (!touches.length) land(); });
         */
        onTouchEnd(fn) { _touchEndHandler = fn; },

        /**
         * Device tilt via gyroscope (mobile only, requires user permission on iOS).
         * tiltX = left/right tilt in degrees (-90…90), tiltY = forward/back tilt.
         * Called every frame while tilting.
         * On first call, automatically requests iOS permission if needed.
         *
         *   onTilt((tiltX, tiltY) => {
         *       velocityX = tiltX * 0.1;  // tilt phone to move
         *   });
         */
        onTilt(fn) {
            _tiltHandler = fn;
            _setupTilt();
        },

        /**
         * Trigger the device vibration motor (mobile only, ignored on desktop).
         * duration: ms (default 80). Can also pass an array for a pattern: [100, 50, 100]
         *   vibrate();          // short buzz
         *   vibrate(200);       // 200ms buzz
         *   vibrate([100,50,200]); // pattern: buzz, pause, buzz
         */
        vibrate(duration) {
            if (!navigator.vibrate) return;
            try { navigator.vibrate(duration ?? 80); } catch(_) {}
        },

        /** Number of fingers currently on screen (same as touchCount property). */
        getTouchCount() { return _activeTouches.length; },

        /** True if exactly N fingers are on screen right now. */
        isMultiTouch(n) { return _activeTouches.length === (n ?? 2); },

        // ── Internal getters used by runtime to wire Hammer.js ──
        get _swipeHandlers()      { return _swipeHandlers;      },
        get _multiSwipeHandlers() { return _multiSwipeHandlers; },
        get _pinchHandler()       { return _pinchHandler;       },
        get _pinchInHandler()     { return _pinchInHandler;     },
        get _pinchOutHandler()    { return _pinchOutHandler;    },
        get _rotateHandler()      { return _rotateHandler;      },
        get _tapHandler()         { return _tapHandler;         },
        get _doubleTapHandler()   { return _doubleTapHandler;   },
        get _longPressHandler()   { return _longPressHandler;   },
        get _touchStartHandler()  { return _touchStartHandler;  },
        get _touchEndHandler()    { return _touchEndHandler;    },
        get _tiltHandler()        { return _tiltHandler;        },
        get _lastTiltX()          { return _lastTiltX;          },
        get _lastTiltY()          { return _lastTiltY;          },
        set _lastTiltX(v)         { _lastTiltX = v;             },
        set _lastTiltY(v)         { _lastTiltY = v;             },
        get _lastPinchScale()     { return _lastPinchScale;     },
        set _lastPinchScale(v)    { _lastPinchScale = v;        },

        // ── PHYSICS HELPERS ───────────────────────────────────
        /**
         * Change this object's physics gravity scale.
         * setGravityScale(0) — floats freely
         * setGravityScale(2) — falls twice as fast
         */
        setGravityScale(n) {
            obj.physicsGravityScale = n;
        },
        /** Actual physics body velocity X in world units/sec (dynamic or kinematic). */
        getPhysicsVelX() {
            if (obj.physicsBody === 'kinematic')
                return  (obj._kinematicActualVx ?? 0) / 100;
            return  (obj._physicsBody?.getLinearVelocity()?.x ?? 0) / 100;
        },
        /** Actual physics body velocity Y in world units/sec +Y=up (dynamic or kinematic). */
        getPhysicsVelY() {
            if (obj.physicsBody === 'kinematic')
                return -(obj._kinematicActualVy ?? 0) / 100;
            return -(obj._physicsBody?.getLinearVelocity()?.y ?? 0) / 100;
        },

        // ── MATH EXTRAS ───────────────────────────────────────
        /**
         * smoothstep(lo, hi, x) — smooth S-curve interpolation between lo and hi.
         * Returns 0 below lo, 1 above hi, smooth in-between.
         */
        smoothstep(lo, hi, x) {
            const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
            return t * t * (3 - 2 * t);
        },
        /**
         * Normalize a 2D vector (make its length = 1).
         * var n = normalize(dx, dy)   →  { x, y }
         */
        normalize(vx, vy) {
            const len = Math.sqrt(vx * vx + vy * vy);
            return len > 0 ? { x: vx / len, y: vy / len } : { x: 0, y: 0 };
        },
        /**
         * Angle from point A to point B in degrees.
         * var deg = angleTo(x1,y1, x2,y2)
         */
        angleTo(x1, y1, x2, y2) {
            return Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        },
        /**
         * Returns true if the value has changed direction compared to last check
         * (useful for walking animations).
         */
        hasSignChanged(prev, curr) { return Math.sign(prev) !== Math.sign(curr) && curr !== 0; },

        // ── DEBUG DRAW ────────────────────────────────────────
        /**
         * Draw a temporary line in the scene (only visible during Play).
         * drawDebugLine(0, 0, 5, 5)                   — white line for 1 frame
         * drawDebugLine(0, 0, 5, 5, "#ff0000", 0.5)   — red line for 0.5 sec
         * drawDebugLine(0, 0, 5, 5, "#00ff00", 1, 3)  — green, 1s, 3px wide
         */
        drawDebugLine(x1, y1, x2, y2, color = '#ffffff', duration = 0, width = 2) {
            _debugLines.push({ x1, y1, x2, y2, color, remaining: Math.max(0.016, duration), width, alpha: 0.85 });
        },
        /**
         * Draw a temporary circle outline.
         * drawDebugCircle(x, y, radius)
         * drawDebugCircle(x, y, 1.5, "#ff0000", 1)
         */
        drawDebugCircle(cx, cy, radius, color = '#ffffff', duration = 0, width = 2) {
            _debugLines.push({ x1: cx, y1: cy, x2: cx, y2: cy, circle: radius, color, remaining: Math.max(0.016, duration), width, alpha: 0.85 });
        },

        // ── CLONE OPTS (per-clone local variable bag) ─────────────
        /** Each clone's own plain-object. Set opts in cloneSelf/cloneObject callback, read in onCloneStart. */
        get opts()      { return obj._opts ?? (obj._opts = {}); },
        set opts(v)     { obj._opts = v ?? {}; },

        // ── HEALTH / DAMAGE SYSTEM ────────────────────────────────
        /**
         * Set this object's health. Also initialises maxHealth if this is the first call.
         *   setHealth(100)
         */
        setHealth(n)    { obj._health = Math.max(0, n); if (obj._maxHealth == null) obj._maxHealth = n; },
        /** Current health value (defaults to 100 until setHealth is called). */
        getHealth()     { return obj._health ?? (obj._health = 100); },
        get maxHealth() { return obj._maxHealth ?? 100; },
        set maxHealth(n){ obj._maxHealth = Math.max(1, n); },
        setMaxHealth(n) { obj._maxHealth = Math.max(1, n); },
        getMaxHealth()  { return obj._maxHealth ?? 100; },
        /**
         * Deal damage. Triggers onDamage callback. If hp reaches 0 triggers onDeath.
         * Ignored while isInvincible() is true.
         *   takeDamage(10)          — 10 damage
         *   takeDamage(10, other)   — 10 damage from another object proxy
         */
        takeDamage(amount, source) {
            if (obj._isInvincible) return;
            if (obj._health == null) obj._health = 100;
            const prev = obj._health;
            obj._health = Math.max(0, prev - amount);
            const inst = _instances.find(i => i.obj === obj);
            if (inst?._onDamage) {
                try { inst._onDamage(amount, source ?? null); }
                catch(e) { const f = _friendlyScriptError(e, null, inst.name, obj.label, 'onDamage'); for (const l of f) _logConsole(l, '#f87171'); }
            }
            if (obj._health <= 0 && prev > 0) {
                if (inst?._onDeath) {
                    try { inst._onDeath(source ?? null); }
                    catch(e) { const f = _friendlyScriptError(e, null, inst.name, obj.label, 'onDeath'); for (const l of f) _logConsole(l, '#f87171'); }
                }
            }
        },
        /**
         * Restore health up to maxHealth. Triggers onHeal.
         *   heal(25)
         */
        heal(amount) {
            if (obj._health == null) obj._health = 0;
            const max = obj._maxHealth ?? 100;
            obj._health = Math.min(max, obj._health + amount);
            const inst = _instances.find(i => i.obj === obj);
            if (inst?._onHeal) try { inst._onHeal(amount); } catch(_) {}
        },
        /** True when current health is 0. */
        isDead()            { return (obj._health ?? 100) <= 0; },
        /**
         * Make this object immune to damage for `duration` seconds (default 1s).
         *   invincible(2)   — 2 seconds of immunity
         */
        invincible(duration = 1) {
            obj._isInvincible = true;
            setTimeout(() => { if (obj) obj._isInvincible = false; }, duration * 1000);
        },
        isInvincible() { return obj._isInvincible === true; },

        // ── AMMO SYSTEM ───────────────────────────────────────────
        /** Set ammo count (also sets maxAmmo on first call). */
        setAmmo(n)      { obj._ammo = Math.max(0, n); if (obj._maxAmmo == null) obj._maxAmmo = n; },
        getAmmo()       { return obj._ammo ?? 0; },
        setMaxAmmo(n)   { obj._maxAmmo = Math.max(0, n); },
        getMaxAmmo()    { return obj._maxAmmo ?? 0; },
        /**
         * Reload ammo to max (or a specific amount). Triggers onReload.
         *   reload()       — refill to maxAmmo
         *   reload(30)     — set ammo to 30
         */
        reload(amount) {
            obj._ammo = amount != null ? Math.min(obj._maxAmmo ?? amount, amount) : (obj._maxAmmo ?? 0);
            const inst = _instances.find(i => i.obj === obj);
            if (inst?._onReload) try { inst._onReload(); } catch(_) {}
        },

        // ── STATE MACHINE ─────────────────────────────────────────
        /**
         * Change this object's current state. Fires onStateExit on the old state
         * and onStateEnter on the new state.
         *   setState("idle")
         *   setState("attack")
         */
        setState(name) {
            const prev = obj._state ?? null;
            if (prev === name) return;
            const inst = _instances.find(i => i.obj === obj);
            if (inst && prev !== null) {
                const fn = inst._stateExitHandlers?.get(prev);
                if (fn) try { fn(prev, name); } catch(_) {}
            }
            obj._state = String(name);
            if (inst) {
                const fn = inst._stateEnterHandlers?.get(String(name));
                if (fn) try { fn(String(name), prev); } catch(_) {}
            }
        },
        /** Returns the current state string (null if not set yet). */
        getState() { return obj._state ?? null; },

        // ── VISUAL GIZMOS ─────────────────────────────────────────
        /**
         * Debug visualization toggles.
         *   Gizmos.raycasts = true          — show raycast lasers
         *   Gizmos.collision = true         — show collision shapes in play mode
         *   Gizmos.collisionColor = '#0f0'  — color for collision outlines
         */
        get Gizmos() {
            return {
                get raycasts()         { return window._zeGizmos?.raycasts ?? false; },
                set raycasts(v)        { (window._zeGizmos = window._zeGizmos ?? {}).raycasts = !!v; },
                get raycastColor()     { return window._zeGizmos?.raycastColor ?? '#00ff44'; },
                set raycastColor(v)    { (window._zeGizmos = window._zeGizmos ?? {}).raycastColor = v; },
                get raycastWidth()     { return window._zeGizmos?.raycastWidth ?? 2; },
                set raycastWidth(v)    { (window._zeGizmos = window._zeGizmos ?? {}).raycastWidth = v; },
                get raycastDuration()  { return window._zeGizmos?.raycastDuration ?? 0.12; },
                set raycastDuration(v) { (window._zeGizmos = window._zeGizmos ?? {}).raycastDuration = v; },
                // ── Collision shape debug overlay ──────────────────
                get collision()        { return window._zeGizmos?.collision ?? false; },
                set collision(v)       { (window._zeGizmos = window._zeGizmos ?? {}).collision = !!v; },
                get collisionColor()   { return window._zeGizmos?.collisionColor ?? '#00ffcc'; },
                set collisionColor(v)  { (window._zeGizmos = window._zeGizmos ?? {}).collisionColor = v; },
            };
        },
    };

    // ── Tilt (DeviceOrientation) setup ──────────────────────────
    let _tiltListenerAdded = false;
    function _setupTilt() {
        if (_tiltListenerAdded) return;
        _tiltListenerAdded = true;

        const _startListening = () => {
            window.addEventListener('deviceorientation', (e) => {
                // gamma = left/right tilt (-90…90), beta = forward/back (-180…180)
                const tx = e.gamma ?? 0;
                const ty = e.beta  ?? 0;
                api._lastTiltX = tx;
                api._lastTiltY = ty;
            }, { passive: true });
        };

        // iOS 13+ requires explicit permission
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(perm => { if (perm === 'granted') _startListening(); })
                .catch(() => {});
        } else {
            _startListening();
        }
    }

    return { api, _keys, _keysJustDown, _keysJustUp, _mouse, _tweens, _repeats, _keyDownHandlers, _keyUpHandlers };
}

// ── Deep-copy all designer-set properties from one object to another ─────────
// Used by cloneSelf, cloneObject, and spawnObject (when using a scene template).
// Call AFTER createImageObject so the new object already has its sprite/gizmos.
function _deepCopyObjectProps(src, dst) {
    // Mark as a runtime clone so hierarchy hides it and onStart is skipped
    dst._isClone = true;

    // Each clone gets its own fresh variable bag — never inherited from source
    dst._opts        = {};
    // Inherit health settings so clones start at the same health as template
    dst._health      = src._health    ?? null;
    dst._maxHealth   = src._maxHealth ?? null;
    dst._isInvincible= false;
    // State machine starts fresh
    dst._state       = null;
    // Ammo inherits from template (so clones can shoot too)
    dst._ammo        = src._ammo    ?? null;
    dst._maxAmmo     = src._maxAmmo ?? null;

    // Script
    if (src.scriptName) dst.scriptName = src.scriptName;

    // Tags — copy the raw Set and register each tag
    if (src._tags) {
        dst._tags = new Set(src._tags);
        for (const [tag, set] of _tagRegistry) {
            if (dst._tags.has(tag)) set.add({ obj: dst });
        }
    }
    if (src._scriptTag)   dst._scriptTag   = src._scriptTag;
    if (src._scriptGroup) dst._scriptGroup = src._scriptGroup;

    // Transform — scale and rotation
    if (src.scale && dst.scale) {
        dst.scale.x = src.scale.x;
        dst.scale.y = src.scale.y;
    }
    if (typeof src.rotation === 'number') dst.rotation = src.rotation;
    if (typeof src.alpha    === 'number') dst.alpha    = src.alpha;
    if (typeof src.visible  === 'boolean') dst.visible = src.visible;
    if (typeof src.unityZ   === 'number') dst.unityZ   = src.unityZ;

    // Physics body type + settings
    if (src.physicsBody)              dst.physicsBody             = src.physicsBody;
    if (typeof src.physicsGravityScale === 'number')
                                       dst.physicsGravityScale    = src.physicsGravityScale;
    if (src.physicsImmovable)         dst.physicsImmovable        = src.physicsImmovable;
    if (src.physicsFixedRotation)     dst.physicsFixedRotation    = src.physicsFixedRotation;
    if (typeof src.physicsRestitution === 'number')
                                       dst.physicsRestitution     = src.physicsRestitution;
    if (typeof src.physicsFriction    === 'number')
                                       dst.physicsFriction        = src.physicsFriction;
    if (typeof src.physicsDensity     === 'number')
                                       dst.physicsDensity         = src.physicsDensity;
    if (typeof src.collisionCategory  === 'number')
                                       dst.collisionCategory      = src.collisionCategory;
    if (typeof src.collisionMask      === 'number')
                                       dst.collisionMask          = src.collisionMask;
    if (src.isSensor !== undefined)   dst.isSensor               = src.isSensor;
    if (src.physicsShape)             dst.physicsShape            = src.physicsShape;

    // Tint
    if (src.spriteGraphic && dst.spriteGraphic && src.spriteGraphic.tint !== undefined)
        dst.spriteGraphic.tint = src.spriteGraphic.tint;

    // Animations — deep clone
    if (src.animations?.length) {
        dst.animations      = JSON.parse(JSON.stringify(src.animations));
        dst.activeAnimIndex = src.activeAnimIndex || 0;
    }

    // Apply physics body if needed (rebuilds planck body with copied settings)
    if (dst.physicsBody && dst.physicsBody !== 'none') {
        import('./engine.physics.js').then(m => m.rebuildBodyForObject(dst));
    }
}

// ── Exports ───────────────────────────────────────────────────
export { _buildSandbox, _deepCopyObjectProps };
