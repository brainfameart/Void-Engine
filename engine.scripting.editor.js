import { markDirty } from './engine.persist.js';
/* ============================================================
   Zengine — engine.scripting.editor.js
   Ace-powered script editor, autocomplete, and script prompts.
   Split from engine.scripting.js for maintainability.
   ============================================================ */

import { state }                               from './engine.state.js';
import { attachLinter, jumpEditorToError }        from './engine.scripting.linter.js';
// getScript/saveScript/refreshScriptPanel loaded dynamically to avoid circular deps

// ── Expose jumpEditorToError globally so runtime can call it ──
window._zeJumpEditorToError = jumpEditorToError;

// ── Local console logger (mirrors engine.scripting.js pattern) ─
function _logConsole(msg, color) {
    import('./engine.console.js').then(m => m.engineLog(msg,
        color === '#f87171' ? 'error' :
        color === '#facc15' ? 'warn'  :
        color === '#4ade80' ? 'system': 'log'));
}

// ── Ace CDN (duplicated here so this file is self-contained) ──
const ACE_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.2';

function _loadAce() {
    return new Promise((resolve, reject) => {
        const _loadLangTools = () => {
            if (window.ace?.require('ace/ext/language_tools')) { resolve(window.ace); return; }
            const lt = document.createElement('script');
            lt.src = `${ACE_BASE}/ext-language_tools.min.js`;
            lt.onload  = () => resolve(window.ace);
            lt.onerror = () => resolve(window.ace);
            document.head.appendChild(lt);
        };
        if (window.ace) { _loadLangTools(); return; }
        const s = document.createElement('script');
        s.src = `${ACE_BASE}/ace.min.js`;
        s.onload  = _loadLangTools;
        s.onerror = () => reject(new Error('Failed to load Ace editor from CDN.'));
        document.head.appendChild(s);
    });
}

// ── Ace autocomplete — only the allowed scripting API ─────────
const COMPLETIONS = [
    // ── Core lifecycle events ─────────────────────────────
    { n:'onStart',           m:'event',          v:"onStart(() => {\n  \n});", d:'Runs once when the scene starts (or object is first added). Use for setup.' },
    { n:'onUpdate',          m:'event',          v:"onUpdate((dt) => {\n  \n});", d:'Runs every frame. dt = seconds since last frame. Use for movement, logic.' },
    { n:'onStop',            m:'event',          v:"onStop(() => {\n  \n});", d:'Runs when play mode stops. Use for cleanup.' },
    { n:'onCloneStart',      m:'event',          v:"onCloneStart(() => {\n  // Runs on clones only\n});", d:'Runs on clones only (not the original). Fires instead of onStart.' },
    { n:'onDestroy',         m:'event',          v:"onDestroy(() => {\n  // Runs just before this object is destroyed\n});", d:'Runs just before this object is removed from the scene.' },
    // ── Collision / Overlap events ─────────────────────────
    { n:'onCollisionEnter',  m:'event collision', v:"onCollisionEnter((other) => {\n  // other.name, other.tag, other.x, other.y\n});", d:'Fires the first frame this object physically collides with another. other = the hit object.' },
    { n:'onCollisionStay',   m:'event collision', v:"onCollisionStay((other) => {\n  \n});", d:'Fires every frame while this object is in contact with another.' },
    { n:'onCollisionExit',   m:'event collision', v:"onCollisionExit((other) => {\n  \n});", d:'Fires the frame two objects stop physically touching.' },
    { n:'onOverlapEnter',    m:'event overlap',   v:"onOverlapEnter((other) => {\n  \n});", d:'Fires when this object overlaps another (sensor/overlap zone). No physics bounce.' },
    { n:'onOverlapExit',     m:'event overlap',   v:"onOverlapExit((other) => {\n  \n});", d:'Fires when two overlapping objects separate.' },
    // ── Messaging ─────────────────────────────────────────
    { n:'onMessage',         m:'event',          v:"onMessage('${1:messageName}', (data) => {\n  \n});", d:'Listen for a named message. Fires when sendMessage or broadcastAll targets this object.' },
    // ── Mouse events ──────────────────────────────────────
    { n:'onMouseClick',      m:'event mouse',    v:"onMouseClick(() => {\n  \n});", d:'Fires when the player clicks this object.' },
    { n:'onMouseEnter',      m:'event mouse',    v:"onMouseEnter(() => {\n  \n});", d:'Fires when the cursor moves onto this object.' },
    { n:'onMouseLeave',      m:'event mouse',    v:"onMouseLeave(() => {\n  \n});", d:'Fires when the cursor moves off this object.' },
    { n:'onBecomeVisible',   m:'event',          v:"onBecomeVisible(() => {\n  \n});", d:'Fires when this object enters the camera view (frustum culling).' },
    { n:'onBecomeHidden',    m:'event',          v:"onBecomeHidden(() => {\n  \n});", d:'Fires when this object leaves the camera view.' },
    // ── Health / Combat events (shooting games, beat-em-ups, RPGs) ──
    { n:'onDamage',          m:'event combat',   v:"onDamage((amount, source) => {\n  // fired when takeDamage() is called\n  hitFlash();\n  log('took', amount, 'damage');\n});", d:'Fires when takeDamage() is called. amount = damage dealt, source = who hit.' },
    { n:'onDeath',           m:'event combat',   v:"onDeath((source) => {\n  // fired when health reaches 0\n  soundPlay('die');\n  destroySelf();\n});", d:'Fires when health reaches 0. source = the object that dealt the killing blow.' },
    { n:'onHeal',            m:'event combat',   v:"onHeal((amount) => {\n  log('healed', amount);\n});", d:'Fires when heal() is called. amount = HP restored.' },
    // ── Platformer events (Mario, Celeste, etc.) ───────────
    { n:'onLand',            m:'event platform', v:"onLand(() => {\n  // fired the frame this object touches the ground after being airborne\n  soundPlay('land');\n});", d:'Fires the frame this object touches the ground after being airborne.' },
    { n:'onJump',            m:'event platform', v:"onJump(() => {\n  // define jump here — called by triggerJump()\n  velocityY = 14;\n  soundPlay('jump');\n});", d:'Define the jump behavior here — called by triggerJump(). Set velocityY inside.' },
    // ── Screen bounds events ───────────────────────────────
    { n:'onScreenExit',      m:'event bounds',   v:"onScreenExit(() => {\n  // fired when object leaves the visible area\n  destroySelf();\n});", d:'Fires when this object moves outside the visible game area.' },
    { n:'onScreenEnter',     m:'event bounds',   v:"onScreenEnter(() => {\n  // fired when object re-enters the visible area\n});", d:'Fires when this object re-enters the visible game area.' },
    // ── Shooter events ─────────────────────────────────────
    // removed: { n:'onAmmoEmpty',       m:'event shooter',  v:"onAmmoEmpt
    { n:'onReload',          m:'event shooter',  v:"onReload(() => {\n  soundPlay('reload');\n  log('Reloaded:', getAmmo());\n});" },
    // ── State machine events ───────────────────────────────
    { n:'onStateEnter',      m:'event state',    v:"onStateEnter('${1:idle}', (newState, prevState) => {\n  playAnimation('${1:idle}');\n});", d:'Fires when setState() switches to a named state. Gets (newState, prevState).' },
    { n:'onStateExit',       m:'event state',    v:"onStateExit('${1:attack}', (oldState, nextState) => {\n  stopAnimation();\n});", d:'Fires when leaving a state. Gets (oldState, nextState).' },
    // this.x / this.y position
    { n:'getX',              m:'position',  v:'getX()', d:'Returns this object\'s X position in world units.'},
    { n:'setX',              m:'position',  v:'setX(${1:value})', d:'Set this object\'s X position directly.' },
    { n:'getY',              m:'position',  v:'getY()', d:'Returns this object\'s Y position in world units.'},
    { n:'setY',              m:'position',  v:'setY(${1:value})', d:'Set this object\'s Y position directly.' },
    { n:'walkTo',            m:'navigate',  v:"walkTo(${1:5}, ${2:3}, { speed: ${3:4}, avoidStatic: true })", d:'Pathfind to a world position. Avoids static obstacles. opts: { speed, avoidStatic }.' },
    { n:'walkToObject',      m:'navigate',  v:"walkToObject('${1:Player}', { speed: ${2:4}, avoidStatic: true })", d:'Pathfind toward another named object. opts: { speed, avoidStatic }.' },
    { n:'stopWalking',       m:'navigate',  v:'stopWalking()', d:'Cancel any active pathfinding movement.'},
    { n:'moveTo',            m:'position',  v:'moveTo(${1:x}, ${2:y})', d:'Teleport to an exact world position (x, y).' },
    { n:'move',              m:'position',  v:'move(${1:dx}, ${2:dy})', d:'Move by an offset (dx, dy) in world units.' },
    { n:'moveForward',       m:'position',  v:'moveForward(${1:speed})', d:'Move in the direction this object is currently facing at a given speed.' },
    { n:'lookAt',            m:'position',  v:'lookAt(${1:tx}, ${2:ty})', d:'Rotate this object to face a world position (tx, ty).' },
    { n:'flipX',             m:'position',  v:'flipX()', d:'Mirror the sprite horizontally.'},
    { n:'flipY',             m:'position',  v:'flipY()', d:'Mirror the sprite vertically.'},
    // Velocity
    { n:'velocityX',         m:'velocity',  v:'velocityX', d:'Horizontal velocity in world units/sec. Assign directly: velocityX = 5.'},
    { n:'velocityY',         m:'velocity',  v:'velocityY', d:'Vertical velocity in world units/sec (+Y = up). Assign directly: velocityY = 10.'},
    { n:'vx',                m:'velocity',  v:'vx', d:'Alias for velocityX.'},
    { n:'vy',                m:'velocity',  v:'vy', d:'Alias for velocityY.'},
    { n:'setVelocity',       m:'velocity',  v:'setVelocity(${1:vx}, ${2:vy})', d:'Set both X and Y velocity at once in world units/sec.' },
    { n:'stopMovement',      m:'velocity',  v:'stopMovement()', d:'Set velocityX and velocityY to 0.'},
    { n:'bounceX',           m:'velocity',  v:'bounceX()', d:'Reverse the X velocity (like bouncing off a wall).'},
    { n:'bounceY',           m:'velocity',  v:'bounceY()', d:'Reverse the Y velocity (like bouncing off a floor/ceiling).'},
    // Gravity
    // removed: { n:'setGravity',        m:'gravity',   v:'setGravity(${1:
    // removed: { n:'gravity',           m:'gravity',   v:'gravity(${1:vy, d:'Removed — use setGravityScale() to control gravity.'}
    // Rotation / Scale
    { n:'getRotation',       m:'rotation',  v:'getRotation()', d:'Returns current rotation in degrees.'},
    { n:'setRotation',       m:'rotation',  v:'setRotation(${1:degrees})', d:'Set rotation in degrees.' },
    { n:'lockRotation',      m:'rotation',  v:'lockRotation()', d:'Prevent physics from spinning this dynamic body.'},
    { n:'unlockRotation',    m:'rotation',  v:'unlockRotation()', d:'Allow physics to spin this dynamic body again.'},
    { n:'setRotationLocked', m:'rotation',  v:'setRotationLocked(${1:true})', d:'Lock (true) or unlock (false) physics rotation in one call.' },
    { n:'getScaleX',         m:'scale',     v:'getScaleX()', d:'Returns the horizontal scale factor.'},
    { n:'setScaleX',         m:'scale',     v:'setScaleX(${1:value})', d:'Set horizontal scale. 2 = double width, -1 = flip.' },
    { n:'getScaleY',         m:'scale',     v:'getScaleY()', d:'Returns the vertical scale factor.'},
    { n:'setScaleY',         m:'scale',     v:'setScaleY(${1:value})', d:'Set vertical scale. 2 = double height.' },
    // Display
    { n:'show',              m:'display',   v:'show()', d:'Make this object visible (sets alpha > 0).'},
    { n:'hide',              m:'display',   v:'hide()', d:'Make this object invisible. It still exists and collides.'},
    { n:'setVisible',        m:'display',   v:'setVisible(${1:true})', d:'Set visibility with a bool: setVisible(true) or setVisible(false).' },
    { n:'getAlpha',          m:'display',   v:'getAlpha()', d:'Returns current opacity (0 = invisible, 1 = fully opaque).'},
    { n:'setAlpha',          m:'display',   v:'setAlpha(${1:1})', d:'Set opacity. 0 = invisible, 1 = fully opaque.' },
    { n:'fadeIn',            m:'display',   v:'fadeIn(${1:duration}, dt)', d:'Increase alpha toward 1 over duration seconds. Call inside onUpdate with dt.' },
    { n:'fadeOut',           m:'display',   v:'fadeOut(${1:duration}, dt)', d:'Decrease alpha toward 0 over duration seconds. Call inside onUpdate with dt.' },
    // Tag / Group
    { n:'setTag',            m:'tag',       v:"setTag('${1:myTag}')", d:'Assign a tag string. Used for messaging and findWithTag().' },
    { n:'getTag',            m:'tag',       v:'getTag()', d:'Returns this object\'s tag string.'},
    { n:'setGroup',          m:'group',     v:"setGroup('${1:myGroup}')", d:'Assign a group string for broadcastGroup() and findAllInGroup().' },
    { n:'getGroup',          m:'group',     v:'getGroup()', d:'Returns this object\'s group string.'},
    // Messaging
    { n:'sendMessage',       m:'message',   v:"sendMessage('${1:tag}', '${2:message}', ${3:data})", d:'Send a message to all objects with a tag, or directly to a proxy. data is optional.' },
    { n:'sendMessage(proxy)', m:'message',   v:"sendMessage(${1:other}, '${2:message}', ${3:data})", d:'Send a message directly to a proxy object (from find, collision, etc).' },
    { n:'broadcastGroup',    m:'message',   v:"broadcastGroup('${1:group}', '${2:message}')", d:'Send a message to all objects in a group.' },
    { n:'broadcastAll',      m:'message',   v:"broadcastAll('${1:message}')", d:'Send a message to every scripted object in the scene.' },
    // Finding objects
    { n:'find',              m:'find',      v:"find('${1:label}')", d:'Find an object by its exact name. Returns a live proxy.' },
    { n:'findWithTag',       m:'find',      v:"findWithTag('${1:tag}')", d:'Find the first object with a given tag. Returns a proxy.' },
    { n:'findAllWithTag',    m:'find',      v:"findAllWithTag('${1:tag}')", d:'Find all objects with a tag. Returns an array of proxies.' },
    { n:'findAllInGroup',    m:'find',      v:"findAllInGroup('${1:group}')", d:'Find all objects in a group. Returns an array of proxies.' },
    // Overlap
    { n:'overlaps',          m:'overlap',    v:'overlaps(${1:other})', d:'Returns true if this object overlaps another proxy.' },
    { n:'overlapsTag',       m:'overlap',    v:"overlapsTag('${1:tag}')", d:'Returns true if this object overlaps any object with the given tag.' },
    { n:'overlapsAllWithTag',m:'overlap',    v:"overlapsAllWithTag('${1:tag}')", d:'Returns an array of all overlapping objects with the given tag.' },
    // Proxy helpers — objects returned by find() / collision callbacks / cloneObject()
    // Store in a variable to act on that specific instance: var e = find("Enemy"); e.destroy();
    { n:'other.name',        m:'proxy',     v:'other.name', d:'The name of a colliding or found object.'},
    { n:'other.tag',         m:'proxy',     v:'other.tag', d:'The tag of a colliding or found object.'},
    { n:'other.x',           m:'proxy',     v:'other.x', d:'The X world position of a found/colliding object. Writable.'},
    { n:'other.y',           m:'proxy',     v:'other.y', d:'The Y world position of a found/colliding object. Writable.'},
    { n:'other.scaleX',      m:'proxy',     v:'other.scaleX', d:'Horizontal scale of a found/colliding object. Writable.'},
    { n:'other.scaleY',      m:'proxy',     v:'other.scaleY', d:'Vertical scale of a found/colliding object. Writable.'},
    { n:'other.rotation',    m:'proxy',     v:'other.rotation', d:'Rotation (degrees) of a found/colliding object. Writable.'},
    { n:'other.alpha',       m:'proxy',     v:'other.alpha', d:'Opacity of a found/colliding object. Writable.'},
    { n:'other.physicsType', m:'proxy',     v:'other.physicsType', d:'The physics body type: "kinematic", "dynamic", or "none".'},
    { n:'other.hasTag',      m:'proxy',     v:"other.hasTag('${1:tag}')", d:'Returns true if this proxy has a specific tag.' },
    { n:'other.destroy',     m:'proxy',     v:'other.destroy()', d:'Destroy the referenced object and remove it from the scene.'},
    { n:'other.sendMessage', m:'proxy',     v:"other.sendMessage('${1:msg}', ${2:data})", d:'Send a message directly to this specific proxy object.' },
    { n:'other.clone',       m:'proxy',     v:'other.clone(${1:other.x}, ${2:other.y})', d:'Clone the referenced object at a given position.' },
    { n:'other.distanceTo',  m:'proxy',     v:'other.distanceTo(${1:target})', d:'Distance from this proxy to another object or position.' },
    // Destroy
    { n:'destroySelf',       m:'destroy',   v:'destroySelf()', d:'Remove this object from the scene immediately.'},
    { n:'destroyObject',     m:'destroy',   v:'destroyObject(${1:other})', d:'Remove another specific object. Pass a proxy from find() or a collision.' },
    { n:'destroyAfter',      m:'destroy',   v:'destroyAfter(${1:secs})', d:'Remove this object after a delay in seconds.' },
    // Scene
    { n:'gotoScene',              m:'scene',  v:"gotoScene('${1:SceneName}')", d:'Switch to another scene by name or index. Args: transition, duration, {freeze}.' },
    { n:'gotoScene fade',         m:'scene',  v:"gotoScene('${1:Level2}', 'fade', ${2:0.5})", d:'Fade to black, swap scene, fade from black. Duration = total seconds.' },
    { n:'gotoScene fade freeze',  m:'scene',  v:"gotoScene('${1:Level2}', 'fade', ${2:0.5}, { freeze: true })", d:'Fade with scripts frozen during transition — prevents mid-switch conflicts.' },
    { n:'gotoScene fadewhite',    m:'scene',  v:"gotoScene('${1:Level2}', 'fadewhite', ${2:0.5})", d:'Fade to white, swap scene, fade from white.' },
    { n:'gotoScene slide-left',   m:'scene',  v:"gotoScene('${1:Level2}', 'slide-left', ${2:0.5})", d:'Black panel wipes in from right, then out to left to reveal new scene.' },
    { n:'gotoScene slide-right',  m:'scene',  v:"gotoScene('${1:Level2}', 'slide-right', ${2:0.5})", d:'Black panel wipes in from left, then out to right to reveal new scene.' },
    { n:'gotoScene zoom',         m:'scene',  v:"gotoScene('${1:Level2}', 'zoom', ${2:0.5})", d:'Zoom punch into black, swap, expand back out.' },
    { n:'gotoScene circle',       m:'scene',  v:"gotoScene('${1:Level2}', 'circle', ${2:0.5})", d:'Iris circle closes to black, swaps scene, opens back out.' },
    { n:'pauseScene',        m:'scene',      v:'pauseScene()', d:'Freeze all scripts and physics in the scene. pauseScene(false) to resume.'},
    { n:'resumeScene',       m:'scene',      v:'pauseScene(false)', d:'Resume a paused scene. Shorthand for pauseScene(false).'},
    { n:'restartScene',      m:'scene',      v:'restartScene()', d:'Reset the current scene without leaving play mode.'},
    { n:'drawText',          m:'text',       v:"drawText('${1:Hello}', ${2:0}, ${3:0}, { id: '${4:label1}', fontSize: ${5:32}, fill: '${6:#ffffff}' })", d:'Draw text in the game world. id keeps it persistent across frames. Returns a proxy.' },
    { n:'currentScene',      m:'scene',     v:'currentScene()', d:'Returns the current scene name string.'},
    { n:'currentSceneIndex', m:'scene',     v:'currentSceneIndex()', d:'Returns the current scene index (0-based).'},
    { n:'sceneCount',        m:'scene',     v:'sceneCount()', d:'Returns the total number of scenes in the project.'},
    { n:'getSceneName',      m:'scene',     v:'getSceneName(${1:index})', d:'Returns the name of the scene at a given index.' },
    // Camera
    { n:'cameraFollow',      m:'camera',    v:'cameraFollow(find("${1:Player}"), ${2:6})', d:'Make the camera smoothly follow a proxy. smoothing = lerp speed (e.g. 6).' },
    { n:'cameraUnfollow',    m:'camera',    v:'cameraUnfollow()', d:'Stop the camera from following any object.'},
    { n:'cameraMoveTo',      m:'camera',    v:'cameraMoveTo(${1:x}, ${2:y})', d:'Move the camera to a specific world position instantly.' },
    { n:'getCameraX',        m:'camera',    v:'getCameraX()', d:'Returns the camera\'s current X world position.'},
    { n:'getCameraY',        m:'camera',    v:'getCameraY()', d:'Returns the camera\'s current Y world position.'},
    { n:'cameraShake',       m:'camera',    v:'cameraShake(${1:0.2}, ${2:0.3})', d:'Shake the camera. amplitude = strength, duration = seconds.' },
    { n:'setCameraFOV',      m:'camera',    v:'setCameraFOV(${1:90})', d:'Set camera Field of View (zoom). <90 = zoom in, >90 = zoom out. Default 90.' },
    { n:'getCameraFOV',      m:'camera',    v:'getCameraFOV()', d:'Returns the current camera FOV in degrees (default 90).' },
    { n:'cameraZoomTo',      m:'camera',    v:'cameraZoomTo(${1:60}, ${2:1.0})', d:'Smoothly tween camera FOV to a new value over duration seconds.' },
    { n:'camera.fov',        m:'camera',    v:'camera.fov = ${1:60}', d:'Directly set camera FOV. <90 zooms in, >90 zooms out. Default is 90.' },
    { n:'camera.zoomTo',     m:'camera',    v:'camera.zoomTo(${1:60}, ${2:1.0})', d:'Tween camera FOV from current to target over duration (seconds).' },
    // Input
    { n:'isKeyDown',         m:'input',     v:"isKeyDown('${1:w}')", d:'True while a key is held. Names: "w", "ArrowLeft", "Space", etc.' },
    { n:'isKeyJustDown',     m:'input',     v:"isKeyJustDown('${1:Space}')", d:'True only on the single frame a key is first pressed.' },
    { n:'isKeyJustUp',       m:'input',     v:"isKeyJustUp('${1:w}')", d:'True only on the single frame a key is released.' },
    { n:'axisH',             m:'input',     v:'axisH()', d:'Returns -1 (left), 0, or 1 (right) from A/D or arrow keys.'},
    { n:'axisV',             m:'input',     v:'axisV()', d:'Returns -1 (up), 0, or 1 (down) from W/S or arrow keys.'},
    { n:'mouseX',            m:'input',     v:'mouseX()', d:'Mouse X position in world coordinates.'},
    { n:'mouseY',            m:'input',     v:'mouseY()', d:'Mouse Y position in world coordinates.'},
    { n:'screenMouseX',      m:'input',     v:'screenMouseX()', d:'Mouse X in screen pixels.'},
    { n:'screenMouseY',      m:'input',     v:'screenMouseY()', d:'Mouse Y in screen pixels.'},
    { n:'mouseDown',         m:'input',     v:'mouseDown()', d:'True while the left mouse button is held.'},
    { n:'mouseJustDown',     m:'input',     v:'mouseJustDown()', d:'True only on the single frame the mouse button is first pressed.'},
    // Mobile / Touch
    { n:'isTouching',        m:'mobile',    v:'isTouching()', d:'True while a finger is touching the screen. Mobile equivalent of mouseDown.'},
    { n:'touchJustStarted',  m:'mobile',    v:'touchJustStarted()', d:'True on the first frame a touch begins. Mobile equivalent of mouseJustDown.'},
    { n:'touchCount',        m:'mobile',    v:'touchCount()', d:'Returns the number of fingers currently touching the screen.'},
    { n:'getTouches',        m:'mobile',    v:'getTouches()', d:'Returns an array of active touch objects with x, y, id properties.'},
    { n:'onSwipe',           m:'mobile',    v:"onSwipe('${1:left}', () => {\n  \n});", d:'Fires on a touch swipe. direction: "left"|"right"|"up"|"down"|"any".' },
    { n:'onTap',             m:'mobile',    v:"onTap(() => {\n  \n});", d:'Fires on a touch tap (mobile).' },
    { n:'onPinch',           m:'mobile',    v:"onPinch((scale) => {\n  \n});", d:'Fires on a two-finger pinch. scale > 1 = expand, < 1 = shrink.' },
    // Virtual Joystick
    { n:'createJoystick',    m:'joystick',  v:"createJoystick({ fixed: true, x: 150, y: 150 })", d:'Create a virtual on-screen joystick. Returns an object with .axisH and .axisV.' },
    { n:'destroyAllJoysticks',m:'joystick', v:'destroyAllJoysticks()', d:'Remove all virtual joysticks from the screen.'},
    // Animation
    { n:'playAnimation',     m:'anim',      v:"playAnimation('${1:name}')", d:'Play a named animation clip defined in the Animation editor.' },
    { n:'stopAnimation',     m:'anim',      v:'stopAnimation()', d:'Stop the currently playing animation.'},
    { n:'currentAnimation',  m:'anim',      v:'currentAnimation()', d:'Returns the name of the currently playing animation, or null.'},
    // Speech bubbles
    { n:'say',               m:'dialog',   v:"say('${1:Hello!}')", d:'Show a speech bubble above this object. Optional duration in seconds.' },
    { n:'say duration',      m:'dialog',   v:"say('${1:Hello!}', ${2:3})", d:'Show a speech bubble for a specific number of seconds.' },
    { n:'think',             m:'dialog',   v:"think('${1:Hmm...}')", d:'Show a thought bubble above this object. Optional duration in seconds.' },
    { n:'think duration',    m:'dialog',   v:"think('${1:Hmm...}', ${2:3})", d:'Show a thought bubble for a specific number of seconds.' },
    // Chat dialog
    { n:'showChat',          m:'dialog',   v:"showChat('${1:NPC}', (input) => {\n  if (input.includes('${2:hello}')) return '${3:Hey there!}';\n  return 'I don\'t understand.';\n})", d:'Open the chat dialog. Callback receives player input, should return NPC reply.' },
    { n:'hideChat',          m:'dialog',   v:'hideChat()', d:'Close the chat dialog.'},
    { n:'chatSay',           m:'dialog',   v:"chatSay('${1:Welcome!}')", d:'Append an NPC line to the open chat dialog.' },
    { n:'chatPlayer',        m:'dialog',   v:"chatPlayer('${1:text}')", d:'Append a player line to the open chat dialog.' },
    { n:'aiChat',            m:'AI dialog', v:"aiChat('${1:NPC Name}', '${2:You are ${1:NPC Name}, a character in a game. Reply in 1-2 sentences.}')", d:'Open an AI-powered chat using Claude. Provide NPC name, description, and API key.' },
    // Physics — readable helper functions
    { n:'applyForce',            m:'physics (dynamic)',   v:'applyForce(${1:fx}, ${2:fy})', d:'Apply a continuous force (world units/sec²) to a dynamic physics body.' },
    { n:'applyImpulse',          m:'physics (dynamic)',   v:'applyImpulse(${1:ix}, ${2:iy})', d:'Apply an instant impulse to a dynamic body (like a single shove).' },
    { n:'setPhysicsVelocity',    m:'physics (dynamic)',   v:'setPhysicsVelocity(${1:vx}, ${2:vy})', d:'Directly set the dynamic physics body\'s velocity. Dynamic bodies only.' },
    { n:'setAngularVelocity',    m:'physics (dynamic)',   v:'setAngularVelocity(${1:3})', d:'Set the spin rate in degrees/sec. Dynamic bodies only.' },
    { n:'applyAngularImpulse',   m:'physics (dynamic)',   v:'applyAngularImpulse(${1:5})', d:'Apply an instant rotational impulse to a dynamic body.' },
    { n:'getVelX',               m:'physics',             v:'getVelX()', d:'Returns the actual physics velocity X in world units/sec.'},
    { n:'getVelY',               m:'physics',             v:'getVelY()', d:'Returns the actual physics velocity Y in world units/sec (+Y = up).'},
    { n:'stopPhysics',           m:'physics',             v:'stopPhysics()', d:'Zero out all physics velocity and forces.'},
    { n:'setImmovable',          m:'physics',             v:'setImmovable(${1:true})', d:'true = this body cannot be pushed by other bodies.' },
    // Kinematic ground / wall detection
    { n:'isOnGround',            m:'physics (kinematic)', v:'isOnGround()', d:'True if this body is resting on a floor surface.'},
    { n:'isOnCeiling',           m:'physics (kinematic)', v:'isOnCeiling()', d:'True if this body is touching a ceiling from below.'},
    { n:'isOnWall',              m:'physics (kinematic)', v:'isOnWall()', d:'True if this body is touching a wall on either side.'},
    // Physics body (advanced — direct access)
    { n:'physics.setVelocity',         m:'physics (dynamic)',   v:'physics.setVelocity(${1:vx}, ${2:vy})', d:'Directly set physics body velocity. Dynamic bodies only.' },
    { n:'physics.applyForce',          m:'physics (dynamic)',   v:'physics.applyForce(${1:fx}, ${2:fy})', d:'Apply a force directly to this physics body.' },
    { n:'physics.applyImpulse',        m:'physics (dynamic)',   v:'physics.applyImpulse(${1:ix}, ${2:iy})', d:'Apply an instant impulse directly to this physics body.' },
    { n:'physics.setAngularVelocity',  m:'physics (dynamic)',   v:'physics.setAngularVelocity(${1:3})', d:'Set angular velocity directly on the physics body.' },
    { n:'physics.applyAngularImpulse', m:'physics (dynamic)',   v:'physics.applyAngularImpulse(${1:5})', d:'Apply an instant rotational impulse to the physics body.' },
    { n:'physics.angularVelocity',     m:'physics (dynamic)',   v:'physics.angularVelocity', d:'Read the current angular velocity of this physics body (deg/sec).'},
    { n:'physics.velX',                m:'physics',             v:'physics.velX', d:'Actual physics velocity X (world units/sec). Read-only.'},
    { n:'physics.velY',                m:'physics',             v:'physics.velY', d:'Actual physics velocity Y (world units/sec, +Y = up). Read-only.'},
    { n:'physics.isOnGround',          m:'physics (kinematic)', v:'physics.isOnGround', d:'True if this body is resting on a floor. Read-only.'},
    { n:'physics.isOnCeiling',         m:'physics (kinematic)', v:'physics.isOnCeiling', d:'True if this body is touching a ceiling. Read-only.'},
    { n:'physics.isOnWall',            m:'physics (kinematic)', v:'physics.isOnWall', d:'True if this body is touching a wall. Read-only.'},
    { n:'physics.stop',                m:'physics',             v:'physics.stop()', d:'Zero out all physics velocity.'},
    { n:'physics.setImmovable',        m:'physics',             v:'physics.setImmovable(${1:true})', d:'Make this body immovable by other bodies.' },
    { n:'physics.immovable',           m:'physics',             v:'physics.immovable', d:'True if this body is currently set to immovable. Read-only.'},
    // Shared variables
    { n:'sceneVar',          m:'vars',      v:'sceneVar.${1:myVar}', d:'Shared variable store for the current scene. Resets on scene change.' },
    { n:'globalVar',         m:'vars',      v:'globalVar.${1:myVar}', d:'Shared variable store that persists across all scenes.' },
    { n:'GameSave',          m:'save',      v:'GameSave',                                      d:'Persistent save system — survives page close & refresh' },
    { n:'GameSave.set',      m:'save',      v:"GameSave.set('${1:key}', ${2:value})", d:'Save a value permanently. GameSave.set("score", 100).',          d:'Save a value permanently. GameSave.set("score", 100)' },
    { n:'GameSave.get',      m:'save',      v:"GameSave.get('${1:key}', ${2:defaultValue})", d:'Load a saved value. Second arg = default if key not found yet.',   d:'Load a saved value. Second arg = default if not found yet' },
    { n:'GameSave.has',      m:'save',      v:"GameSave.has('${1:key}')", d:'Returns true if this key has been saved before.',                      d:'Returns true if this key has been saved before' },
    { n:'GameSave.delete',   m:'save',      v:"GameSave.delete('${1:key}')", d:'Remove one saved key.',                   d:'Remove one saved key' },
    { n:'GameSave.setAll',   m:'save',      v:"GameSave.setAll({ ${1:key}: ${2:value} })", d:'Save multiple keys at once from a plain object.',     d:'Save multiple keys at once from a plain object' },
    { n:'GameSave.getAll',   m:'save',      v:'GameSave.getAll()',                              d:'Get all saved data as a plain object' },
    { n:'GameSave.increment',m:'save',      v:"GameSave.increment('${1:key}', ${2:1})", d:'Add to a numeric key (creates at 0 if missing). Returns new value.',        d:'Add to a numeric key (creates at 0 if missing). Returns new value' },
    { n:'GameSave.clear',    m:'save',      v:'GameSave.clear()',                               d:'Wipe ALL saved data in the current slot' },
    { n:'GameSave.slot',     m:'save',      v:"GameSave.slot('${1:slotName}')", d:'Switch to a named save slot: GameSave.slot("file2").set("level", 3).',                d:'Switch to a named save slot. GameSave.slot("file2").set("level",3)' },
    { n:'GameSave.listSlots',m:'save',      v:'GameSave.listSlots()',                           d:'Returns array of all slot names that have data' },
    { n:'store.set',         m:'vars',      v:"store.set('${1:key}', ${2:value})", d:"Save a value into this object's local persistent store." },
    { n:'store.get',         m:'vars',      v:"store.get('${1:key}', ${2:default})", d:"Load a value from this object's local store. Second arg = default." },
    // Time
    { n:'getTime',           m:'time',      v:'getTime()', d:'Returns seconds elapsed since play mode started.'},
    // Math
    { n:'lerp',              m:'math',      v:'lerp(${1:a}, ${2:b}, ${3:t})', d:'Linear interpolate: lerp(a, b, t). t is clamped 0–1.' },
    { n:'clamp',             m:'math',      v:'clamp(${1:v}, ${2:min}, ${3:max})', d:'Clamp v between lo and hi.' },
    { n:'dist',              m:'math',      v:'dist(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})', d:'Euclidean distance between two world points.' },
    { n:'rand',              m:'math',      v:'rand(${1:min}, ${2:max})', d:'Random float in [min, max).' },
    { n:'randInt',           m:'math',      v:'randInt(${1:min}, ${2:max})', d:'Random integer in [min, max] inclusive.' },
    { n:'pick',              m:'math',      v:'pick([${1:a}, ${2:b}, ${3:c}])', d:'Pick a random element from an array.' },
    { n:'chance',            m:'math',      v:'chance(${1:0.5})', d:'Returns true with probability p (0–1). chance(0.3) = 30% chance.' },
    { n:'sign',              m:'math',      v:'sign(${1:v})', d:'Returns 1, -1, or 0 depending on the sign of v.' },
    { n:'toRad',             m:'math',      v:'toRad(${1:degrees})', d:'Convert degrees to radians.' },
    { n:'toDeg',             m:'math',      v:'toDeg(${1:radians})', d:'Convert radians to degrees.' },
    { n:'mapRange',          m:'math',      v:'mapRange(${1:v}, ${2:a1}, ${3:b1}, ${4:a2}, ${5:b2})', d:'Re-map v from range [a1,b1] into range [a2,b2].' },
    { n:'sin',               m:'math',      v:'sin(${1:a})', d:'Sine of an angle in radians.' },
    { n:'cos',               m:'math',      v:'cos(${1:a})', d:'Cosine of an angle in radians.' },
    { n:'abs',               m:'math',      v:'abs(${1:v})', d:'Absolute value of a number.' },
    { n:'sqrt',              m:'math',      v:'sqrt(${1:v})', d:'Square root.' },
    { n:'PI',                m:'math',      v:'PI', d:'The mathematical constant π ≈ 3.14159.'},
    { n:'floor',             m:'math',      v:'floor(${1:v})', d:'Round down to the nearest integer.' },
    { n:'ceil',              m:'math',      v:'ceil(${1:v})', d:'Round up to the nearest integer.' },
    { n:'round',             m:'math',      v:'round(${1:v})', d:'Round to the nearest integer.' },
    { n:'max',               m:'math',      v:'max(${1:a}, ${2:b})', d:'Return the larger of two values.' },
    { n:'min',               m:'math',      v:'min(${1:a}, ${2:b})', d:'Return the smaller of two values.' },
    // Game helpers
    { n:'addImpulse',        m:'game',     v:'addImpulse(${1:vx}, ${2:vy})', d:'Apply a one-shot velocity kick (no physics body required).' },
    { n:'boundsClamp',       m:'game',     v:'boundsClamp(${1:0})', d:'Clamp this object inside the world bounds. margin = padding in units.' },
    { n:'boundsClamp destroy',m:'game',    v:'boundsClamp(${1:0}, true)  // destroy if offscreen', d:'Destroy this object if it leaves the world bounds.' },
    { n:'offScreen',         m:'game',     v:'offScreen(${1:0})  // → true if offscreen', d:'Returns true if this object is outside the visible game area.' },
    { n:'spawnCopy',         m:'game',     v:"spawnCopy('${1:Name}', ${2:x}, ${3:y})", d:'Spawn a copy of a named object at (x, y). Returns a proxy.' },
    { n:'trackTarget',       m:'game',     v:'trackTarget(${1:target}, ${2:speed}, dt)', d:'Move this object toward a target proxy each frame at a given speed.' },
    { n:'hitFlash',          m:'game',     v:"hitFlash('${1:#ffffff}', ${2:0.1})", d:'Flash the sprite tint to a color then back. Good for damage feedback.' },
    { n:'objectShake',       m:'game',     v:'objectShake(${1:0.2}, ${2:0.25})', d:'Shake this object in place. amplitude = strength, duration = seconds.' },
    // Debug
    { n:'log',               m:'debug',    v:'log(${1:value})', d:'Print a value to the engine console.' },
    { n:'warn',              m:'debug',    v:'warn(${1:value})', d:'Print a yellow warning to the engine console.' },
    { n:'error',             m:'debug',    v:'error(${1:value})', d:'Print a red error to the engine console.' },
    // Sound
    { n:'soundPlay',         m:'sound',    v:"soundPlay('${1:assetName}')", d:'Play a named audio asset. opts: { loop, volume (0-1), range }.' },
    { n:'soundPlay opts',    m:'sound',    v:"soundPlay('${1:name}', { loop:${2:false}, volume:${3:1.0}, range:${4:400} })", d:'Play a sound with options: loop, volume (0–1), range (spatial falloff).' },
    { n:'soundStop',         m:'sound',    v:"soundStop('${1:assetName}')", d:'Stop a specific playing sound by asset name.' },
    { n:'soundStopAll',      m:'sound',    v:'soundStopAll()', d:'Stop all currently playing sounds.'},
    // Timer
    { n:'wait',              m:'timer',    v:'wait(${1:seconds}, () => {\n  ${2:// code here}\n})', d:'Run a callback after a delay in seconds. Non-blocking (async-safe).' },
    // Physics control
    { n:'setPhysicsType',    m:'physics',   v:"setPhysicsType('${1:kinematic}')", d:'Change physics body type at runtime: "kinematic", "dynamic", or "none".' },
    { n:'setCollision',      m:'physics',   v:'setCollision(${1:true})', d:'Enable or disable collision with other physics bodies.' },
    { n:'setSensor',         m:'physics',   v:'setSensor(${1:true})', d:'Make this a sensor body: triggers overlaps but no physical collision.' },
    { n:'setCollisionCategory',m:'physics', v:'setCollisionCategory(${1:1})', d:'Set which collision category this body belongs to (bitmask).' },
    { n:'setCollisionMask',  m:'physics',   v:'setCollisionMask(${1:-1})', d:'Set which categories this body collides with (bitmask, -1 = all).' },
    // Tint
    { n:'setTint',           m:'tint',     v:"setTint('${1:#ffffff}')", d:'Tint this object\'s sprite with a hex color string like "#ff0000".' },
    { n:'getTint',           m:'tint',     v:'getTint()', d:'Returns the current tint as a hex string.'},
    // Distance
    { n:'distanceTo',        m:'distance', v:"distanceTo('${1:tag}')", d:'Distance in world units from this object to a tag, position, or proxy.' },
    { n:'distanceTo pos',    m:'distance', v:'distanceTo(${1:x}, ${2:y})', d:'Distance from this object to a world position (x, y).' },
    { n:'distanceTo obj',    m:'distance', v:'distanceTo(find("${1:label}"))', d:'Distance from this object to a found object by name.' },
    // Tween
    { n:'tween',             m:'tween',    v:"tween({ ${1:alpha}:${2:0} }, ${3:0.5}, '${4:easeOut}')", d:'Smoothly animate a property to a target value over duration seconds.' },
    { n:'tween complete',    m:'tween',    v:"tween({ ${1:x}:${2:5} }, ${3:1}, '${4:linear}', () => {\n  ${5:// done}\n})", d:'Tween with a callback that fires when the animation finishes.' },
    // Repeat timers
    { n:'repeat',            m:'repeat',   v:'repeat(${1:1}, () => {\n  ${2:// code}\n})', d:'Run a callback every N seconds. Returns an id for cancelRepeat.' },
    { n:'cancelRepeat',      m:'repeat',   v:'cancelRepeat(${1:id})', d:'Cancel a repeat timer by the id returned from repeat().' },
    // Spawn
    { n:'spawnObject',       m:'spawn',    v:"spawnObject('${1:AssetName}', ${2:x}, ${3:y})", d:'Spawn a fresh copy of an asset-library object at (x, y). Returns a proxy.' },
    { n:'spawnObject cb',    m:'spawn',    v:"spawnObject('${1:AssetName}', ${2:x}, ${3:y}, (obj) => {\n  ${4:// obj.velocityX = 10;}\n})", d:'Spawn with a callback to configure the new object immediately.' },
    { n:'cloneSelf',         m:'clone',    v:"cloneSelf(${1:getX()}, ${2:getY()})", d:'Clone this exact object (sprite, physics, script) at (x, y). Returns a proxy.' },
    { n:'cloneSelf cb',      m:'clone',    v:"cloneSelf(${1:getX()}, ${2:getY()}, (c) => {\n  ${3:c.velocityX = 3;}\n})", d:'Clone with a callback. Use c.opts to pass data to the clone.' },
    { n:'cloneObject',       m:'clone',    v:"cloneObject('${1:Name}', ${2:x}, ${3:y})", d:'Clone any object by name at (x, y). Copies all its properties.' },
    { n:'cloneObject cb',    m:'clone',    v:"cloneObject('${1:Name}', ${2:x}, ${3:y}, (c) => {\n  ${4:c.velocityX = 3;}\n})", d:'Clone any object with a callback to configure it on spawn.' },
    // Raycast
    { n:'raycast',           m:'raycast',  v:'raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})', d:'Cast a ray from (x1,y1) to (x2,y2). Returns the first hit, or null.' },
    { n:'raycast tag',       m:'raycast',  v:"raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}, '${5:enemy}')", d:'Raycast filtered to only hit objects with a specific tag.' },
    // Radius query
    { n:'getObjectsInRadius',m:'radius',   v:'getObjectsInRadius(${1:cx}, ${2:cy}, ${3:radius})', d:'Returns all objects within radius of (cx, cy). Optional tag filter.' },
    // Z-order
    { n:'setZOrder',         m:'zorder',   v:'setZOrder(${1:10})', d:'Set this object\'s render layer. Higher values draw on top.' },
    { n:'getZOrder',         m:'zorder',   v:'getZOrder()', d:'Returns this object\'s current render layer.'},
    // Coordinate conversion
    { n:'screenToWorld',     m:'coords',   v:'screenToWorld(${1:sx}, ${2:sy})', d:'Convert screen pixel coordinates to world coordinates. Returns { x, y }.' },
    { n:'worldToScreen',     m:'coords',   v:'worldToScreen(${1:wx}, ${2:wy})', d:'Convert world coordinates to screen pixel coordinates. Returns { x, y }.' },
    // Key event handlers
    { n:'onKeyDown',         m:'key event',v:"onKeyDown('${1:arrowleft}', () => {\n  ${2:// code}\n})", d:'Fires once when a specific key is pressed down.' },
    { n:'onKeyUp',           m:'key event',v:"onKeyUp('${1:arrowleft}', () => {\n  ${2:// code}\n})", d:'Fires once when a specific key is released.' },
    // Physics helpers
    { n:'setGravityScale',  m:'physics',  v:'setGravityScale(${1:1.0})', d:'Multiply gravity for this object. 0 = floats, 2 = double gravity.' },
    // Extra math
    { n:'smoothstep',        m:'math',     v:'smoothstep(${1:lo}, ${2:hi}, ${3:x})', d:'S-curve blend between lo and hi. Smoother than lerp at the edges.' },
    { n:'normalize',         m:'math',     v:'normalize(${1:vx}, ${2:vy})', d:'Normalize vector (vx, vy) to unit length. Returns { x, y }.' },
    { n:'angleTo',           m:'math',     v:'angleTo(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})', d:'Angle in degrees from (x1,y1) to (x2,y2).' },
    // Debug draw
    { n:'drawDebugLine',     m:'debug draw',v:'drawDebugLine(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})', d:'Draw a line in world space for debugging. Color and duration are optional.' },
    { n:'drawDebugLine opts',m:'debug draw',v:"drawDebugLine(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}, '${5:#ff0000}', ${6:0.5})", d:'Draw a debug line with explicit color (hex) and duration (seconds).' },
    { n:'drawDebugCircle',   m:'debug draw',v:'drawDebugCircle(${1:cx}, ${2:cy}, ${3:radius})', d:'Draw a circle in world space for debugging.' },
    // Scene transitions
    { n:'gotoScene fade',    m:'scene',    v:"gotoScene('${1:Level2}', 'fade')", d:'Switch to another scene with a fade transition.' },
    { n:'gotoScene slide',   m:'scene',    v:"gotoScene('${1:Level2}', 'slide-left')", d:'Switch to another scene with a slide-left transition.' },

    // ── Health / Damage ────────────────────────────────────
    { n:'setHealth',         m:'health',    v:'setHealth(${1:100})', d:'Set this object\'s current HP.' },
    { n:'getHealth',         m:'health',    v:'getHealth()', d:'Returns this object\'s current HP.'},
    { n:'setMaxHealth',      m:'health',    v:'setMaxHealth(${1:100})', d:'Set the maximum HP for this object.' },
    { n:'getMaxHealth',      m:'health',    v:'getMaxHealth()', d:'Returns the maximum HP.'},
    { n:'takeDamage',        m:'health',    v:'takeDamage(${1:10})', d:'Reduce HP by amount and fire onDamage.' },
    { n:'takeDamage src',    m:'health',    v:'takeDamage(${1:10}, other)', d:'Deal damage and pass the source object so onDamage knows who hit.' },
    { n:'heal',              m:'health',    v:'heal(${1:25})', d:'Restore HP by amount and fire onHeal.' },
    { n:'isDead',            m:'health',    v:'isDead()', d:'Returns true if current HP is 0 or less.'},
    { n:'invincible',        m:'health',    v:'invincible(${1:1})', d:'Make this object immune to takeDamage() for duration seconds.' },
    { n:'isInvincible',      m:'health',    v:'isInvincible()', d:'Returns true if this object is currently invincible.'},

    // ── Knockback ──────────────────────────────────────────
    // removed: { n:'knockback',         m:'combat',   v:'knockback(${1:18
    // removed: { n:'knockback timed',   m:'combat',   v:'knockback(${1:18

    // ── Ammo System ────────────────────────────────────────
    { n:'setAmmo',           m:'ammo',     v:'setAmmo(${1:30})', d:'Set this object\'s current ammo count.' },
    { n:'getAmmo',           m:'ammo',     v:'getAmmo()', d:'Returns current ammo count.'},
    { n:'setMaxAmmo',        m:'ammo',     v:'setMaxAmmo(${1:30})', d:'Set the maximum ammo capacity.' },
    { n:'getMaxAmmo',        m:'ammo',     v:'getMaxAmmo()', d:'Returns the maximum ammo capacity.'},
    { n:'reload',            m:'ammo',     v:'reload()', d:'Restore ammo to max and fire onReload.'},

    // ── Fire Projectile ────────────────────────────────────
    // removed: { n:'fireProjectile',    m:'shoot',    v:"fireProjectile('
    // removed: { n:'fireProjectile opts',m:'shoot',   v:"fireProjectile('

    // ── State Machine ──────────────────────────────────────
    { n:'setState',          m:'state',    v:"setState('${1:idle}')", d:'Switch to a named state. Fires onStateExit then onStateEnter.' },
    { n:'getState',          m:'state',    v:'getState()', d:'Returns the current state name string.'},

    // ── Platformer helpers ─────────────────────────────────
    { n:'triggerJump',       m:'platform', v:'triggerJump()', d:'Invoke the onJump handler. Use this from your input code.'},

    // ── Clone opts ─────────────────────────────────────────
    { n:'opts',              m:'clone opts',v:'opts.${1:myVar}', d:'Data bag passed from the spawner to this clone. Read in onCloneStart.' },
    { n:'opts set (clone)',  m:'clone opts',v:"cloneSelf(getX(), getY(), (c) => {\n  c.opts.${1:speed} = ${2:5};\n  c.opts.${3:damage} = ${4:1};\n});", d:'Pass custom data to a clone via c.opts before onCloneStart fires.' },
    { n:'opts read (clone)', m:'clone opts',v:"onCloneStart(() => {\n  // read opts set by spawner\n  velocityX = opts.${1:speed};\n});", d:'Read opts data in onCloneStart that was set by the spawner.' },
    { n:'isClone',           m:'clone',    v:'isClone()', d:'Returns true if this object was created by cloneSelf() or cloneObject().'},
    { n:'getCloneId',        m:'clone',    v:'getCloneId()', d:'Returns this clone\'s numeric ID. The original returns 0.'},
    { n:'cloneInPlace',      m:'clone',    v:"cloneInPlace((c) => {\n  ${1:c.velocityX = 2;}\n})", d:'Clone this object at its current position.' },

    // ── Screen / Proximity helpers ─────────────────────────
    { n:'inRangeOf',         m:'proximity',v:'inRangeOf(find("${1:Player}"), ${2:3})', d:'Returns true if this object is within radius world units of a proxy.' },
    { n:'onceAfter',         m:'timer',    v:'onceAfter(${1:2}, () => {\n  ${2:destroySelf();}\n})', d:'Run a callback once after delay seconds (like wait, more explicit name).' },

    // ── Raycast (extended) ─────────────────────────────────
    { n:'raycastAll',        m:'raycast',  v:'raycastAll(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})', d:'Like raycast but returns all hits as an array.' },
    { n:'raycastFromSelf',   m:'raycast',  v:'raycastFromSelf(${1:0}, ${2:8})', d:'Cast a ray from this object\'s center at angleDeg for a given distance.' },
    { n:'raycastFromSelf tag',m:'raycast', v:"raycastFromSelf(${1:0}, ${2:8}, '${3:wall}')", d:'Raycast from self, filtered to a specific tag.' },
    { n:'hit.distance',      m:'raycast',  v:'${1:hit}.distance', d:'Distance from the ray origin to the hit point.' },
    { n:'hit.point.x',       m:'raycast',  v:'${1:hit}.point.x', d:'World X coordinate where the ray hit.' },
    { n:'hit.normal.x',      m:'raycast',  v:'${1:hit}.normal.x', d:'Surface normal X at the hit point. Use to deflect projectiles.' },

    // ── Gizmos / Debug visualization ───────────────────────
    { n:'Gizmos.raycasts',       m:'gizmos', v:'Gizmos.raycasts = ${1:true}', d:'Show or hide raycast debug lines during play.' },
    { n:'Gizmos.raycastColor',   m:'gizmos', v:"Gizmos.raycastColor = '${1:#00ff44}'", d:'Set the color of raycast debug lines (hex string).' },
    { n:'Gizmos.raycastWidth',   m:'gizmos', v:'Gizmos.raycastWidth = ${1:2}', d:'Set the pixel width of raycast debug lines.' },
    { n:'Gizmos.raycastDuration',m:'gizmos', v:'Gizmos.raycastDuration = ${1:0.12}', d:'How many seconds each raycast debug line stays on screen.' },
    { n:'Gizmos.collision',      m:'gizmos', v:'Gizmos.collision = ${1:true}', d:'Show or hide collision shape debug overlays.' },
    { n:'Gizmos.collisionColor', m:'gizmos', v:"Gizmos.collisionColor = '${1:#00ffcc}'", d:'Set the color of collision debug overlays (hex string).' },

    // ── Proxy (other.*) extended ───────────────────────────
    { n:'other.health',      m:'proxy',    v:'other.health', d:'Current HP of the colliding object.'},
    { n:'other.ammo',        m:'proxy',    v:'other.ammo', d:'Ammo count of the colliding object.'},
    { n:'other.state',       m:'proxy',    v:'other.state', d:'Current state string of the colliding object.'},
    { n:'other.isDead',      m:'proxy',    v:'other.isDead', d:'True if the colliding object\'s HP is 0.'},
    { n:'other.isInvincible',m:'proxy',    v:'other.isInvincible', d:'True if the colliding object is currently invincible.'},
    { n:'other.opts',        m:'proxy',    v:'other.opts.${1:myVar}', d:'Access the opts data bag of the colliding object.' },
    { n:'other.takeDamage',  m:'proxy',    v:'other.takeDamage(${1:10})', d:'Deal damage to the colliding object.' },

    // ── Tint (full set) ────────────────────────────────────
    { n:'clearTint',         m:'tint',     v:'clearTint()', d:'Remove any tint and restore original sprite colors.'},

    // ── Display (extended) ────────────────────────────────
    // removed: { n:'getWidth',          m:'size',     v:'getWidth()' },
    // removed: { n:'getHeight',         m:'size',     v:'getHeight()' },
    { n:'getVisible',        m:'display',  v:'getVisible()', d:'Returns true if this object is currently visible.'},
    { n:'selfName',          m:'identity', v:'selfName()', d:'Returns the name of this object as set in the editor.'},
    // removed: { n:'translate',         m:'position',  v:'translate(${1:d
    { n:'pauseAnimation',    m:'anim',      v:'pauseAnimation()', d:'Pause the animation on its current frame without resetting it.'},

    // ── AI Navigation ─────────────────────────────────────
    { n:'pursue',            m:'AI nav',   v:"pursue('${1:player}', { speed: ${2:3} })", d:'Move toward a target tag using pathfinding. opts: { speed }.' },
    { n:'flee',              m:'AI nav',   v:"flee('${1:player}', { speed: ${2:4} })", d:'Move away from a target tag. opts: { speed }.' },
    { n:'wander',            m:'AI nav',   v:'wander({ speed: ${1:1.5}, radius: ${2:3} })', d:'Roam randomly around the scene. opts: { speed, radius }.' },
    { n:'canSee',            m:'AI nav',   v:"canSee('${1:player}')", d:'True if there is a clear line of sight to the target.' },
    { n:'canSee opts',       m:'AI nav',   v:"canSee('${1:player}', { maxRange: ${2:8} })", d:'canSee with a maximum range limit in world units.' },
    { n:'lastKnownPos',      m:'AI nav',   v:"lastKnownPos('${1:player}')", d:'Returns the last seen position { x, y } of a target, or null.' },
    { n:'inFOV',             m:'AI nav',   v:"inFOV('${1:player}', ${2:90}, ${3:6})", d:'True if target is within a field-of-view cone. Args: tag, degrees, range.' },
    { n:'isWalking',         m:'navigate', v:'isWalking', d:'True if this object is currently executing a pathfinding movement.'},
    { n:'isStuck',           m:'navigate', v:'isStuck', d:'True if the pathfinder is stuck and cannot reach the destination.'},

    // ── Drag (full set) ────────────────────────────────────
    { n:'makeDraggable',          m:'drag',  v:'makeDraggable()', d:'Let the player drag this object with mouse or touch. Works on all body types.' },
    { n:'makeDraggable opts',     m:'drag',  v:"makeDraggable({ smooth:${1:16}, clamp:${2:false}, scale:${3:1.08}, onDrag:(x,y)=>{ ${4:} }, onDrop:(x,y)=>{ ${5:} } })", d:'Draggable with options. onDrag fires every frame while held. onDrop fires on release.' },
    { n:'dragObject',             m:'drag',  v:"dragObject(find('${1:Crate}'))", d:'Start dragging another object by proxy programmatically.' },
    { n:'dragObject onDrag',      m:'drag',  v:"dragObject(find('${1:Crate}'), { onDrag:(x,y)=>{ ${2:log(x,y)} } })", d:'Drag another object and call onDrag(x,y) every frame while held.' },
    { n:'stopDrag',             m:'drag',  v:'stopDrag()', d:'Release whatever object is currently being dragged.'},
    { n:'isDragging',           m:'drag',  v:'isDragging()', d:'Returns true if this object is currently being dragged.'},
    { n:'makeThrowable',           m:'throw', v:'makeThrowable()', d:'Drag + fling this object with physics velocity on release. Works on ALL body types.'},
    { n:'makeThrowable opts',      m:'throw', v:"makeThrowable({ speed:${1:1}, maxSpeed:${2:25}, clamp:${3:false}, scale:${4:1.08}, onDrag:(x,y)=>{ ${5:} } })", d:'Throwable with options: speed multiplier, maxSpeed cap, onDrag per frame, scale on grab.' },
    { n:'makeThrowable onThrow',   m:'throw', v:"makeThrowable({ speed:${1:1}, onThrow:(vx,vy) => { ${2:log(vx,vy)} } })", d:'Throwable with a callback that fires with (vx, vy) on release. Visually distinct from makeDraggable (uses instant tracking).' },
    { n:'throwObject',             m:'throw', v:"throwObject(find('${1:Ball}'))", d:'Throw another object using the current drag velocity.' },
    { n:'throwObject opts',        m:'throw', v:"throwObject(find('${1:Ball}'), { speed:${2:1.5}, maxSpeed:${3:30}, onDrag:(x,y)=>{ ${4:} } })", d:'Throw another object with custom speed, maxSpeed, and onDrag options.' },

    // ── Messaging (extended) ──────────────────────────────
    { n:'broadcastAll data',m:'message',v:"broadcastAll('${1:msg}', ${2:data})", d:'Send a message with a data payload to every scripted object in the scene.' },

    // ── Shared Vars (extended) ────────────────────────────
    { n:'sceneSettings',     m:'vars',     v:'sceneSettings.gameWidth', d:'Read-only scene settings object: gameWidth, gameHeight, gravity, etc.'},
    { n:'wrap',              m:'math',      v:'wrap(${1:v}, ${2:lo}, ${3:hi})', d:'Wrap v within [lo, hi]. Useful for looping angles.' },
    { n:'tan',               m:'math',      v:'tan(${1:a})', d:'Tangent of an angle in radians.' },
    { n:'atan2',             m:'math',      v:'atan2(${1:y}, ${2:x})', d:'Angle in radians from the positive X axis to point (y, x).' },
    { n:'pow',               m:'math',      v:'pow(${1:base}, ${2:exp})', d:'Raise base to an exponent: pow(2, 10) = 1024.' },

    // ── Key & Mouse constants ─────────────────────────────
    { n:'Key.W',             m:'key const', v:'Key.W', d:'String constant "w" — use with isKeyDown(), isKeyJustDown(), etc.'},
    { n:'Key.A',             m:'key const', v:'Key.A', d:'String constant "a".'},
    { n:'Key.S',             m:'key const', v:'Key.S', d:'String constant "s".'},
    { n:'Key.D',             m:'key const', v:'Key.D', d:'String constant "d".'},
    { n:'Key.SPACE',         m:'key const', v:'Key.SPACE', d:'String constant "Space".'},
    { n:'Key.ARROW_LEFT',    m:'key const', v:'Key.ARROW_LEFT', d:'String constant "ArrowLeft".'},
    { n:'Key.ARROW_RIGHT',   m:'key const', v:'Key.ARROW_RIGHT', d:'String constant "ArrowRight".'},
    { n:'Key.ARROW_UP',      m:'key const', v:'Key.ARROW_UP', d:'String constant "ArrowUp".'},
    { n:'Key.ARROW_DOWN',    m:'key const', v:'Key.ARROW_DOWN', d:'String constant "ArrowDown".'},
    { n:'Key.ANY',           m:'key const', v:'Key.ANY', d:'Matches any key — use with onKeyDown to catch all input.'},
    { n:'Mouse.LEFT',        m:'mouse const',v:'Mouse.LEFT', d:'Mouse button 0 (left click constant).'},

    // ── forever — per-frame loop ────────────────────────────
    { n:'forever',           m:'loop',     v:"forever((dt) => {\n  ${1:// runs every frame}\n});", d:'Run a callback every frame with dt. Register inside onStart.' },
    { n:'forever move',      m:'loop',     v:"forever((dt) => {\n  x -= ${1:3} * dt;  // move left\n});", d:'Example: move this object left every frame using dt.' },

    // ── Clone return-value: var c = cloneSelf(...) ─────────
    { n:'cloneSelf assign',  m:'clone',    v:"var ${1:c} = cloneSelf(${2:getX()}, ${3:getY()});", d:'Store the cloned object in a variable to control it later.' },
    { n:'cloneObject assign',m:'clone',    v:"var ${1:c} = cloneObject('${2:Name}', ${3:x}, ${4:y});", d:'Store a cloneObject result in a variable.' },
    { n:'cloneInPlace assign',m:'clone',   v:"var ${1:c} = cloneInPlace();", d:'Store the in-place clone in a variable.' },
    { n:'spawnObject assign', m:'spawn',   v:"var ${1:obj} = spawnObject('${2:Name}', ${3:x}, ${4:y});", d:'Store a spawned object in a variable.' },

    // ── Proxy properties on a stored clone/object reference ─
    { n:'c.x',               m:'clone prop', v:'${1:c}.x', d:'Read or set the X position of a stored object reference.' },
    { n:'c.y',               m:'clone prop', v:'${1:c}.y', d:'Read or set the Y position of a stored object reference.' },
    { n:'c.rotation',        m:'clone prop', v:'${1:c}.rotation', d:'Read or set rotation (degrees) of a stored reference.' },
    { n:'c.scaleX',          m:'clone prop', v:'${1:c}.scaleX', d:'Read or set horizontal scale of a stored reference.' },
    { n:'c.scaleY',          m:'clone prop', v:'${1:c}.scaleY', d:'Read or set vertical scale of a stored reference.' },
    { n:'c.velocityX',       m:'clone prop', v:'${1:c}.velocityX', d:'Read or set velocityX on a stored clone or spawned object.' },
    { n:'c.velocityY',       m:'clone prop', v:'${1:c}.velocityY', d:'Read or set velocityY on a stored clone or spawned object.' },
    { n:'c.alpha',           m:'clone prop', v:'${1:c}.alpha', d:'Read or set opacity (0–1) of a stored reference.' },
    { n:'c.visible',         m:'clone prop', v:'${1:c}.visible', d:'Read or set visibility of a stored reference.' },
    { n:'c.health',          m:'clone prop', v:'${1:c}.health', d:'Read the current HP of a stored reference.' },
    { n:'c.state',           m:'clone prop', v:'${1:c}.state', d:'Read the current state string of a stored reference.' },
    { n:'c.opts',            m:'clone prop', v:'${1:c}.opts.${2:myVar}', d:'Access the opts data bag on a stored clone reference.' },
    { n:'c.destroy',         m:'clone prop', v:'${1:c}.destroy()', d:'Destroy a stored clone or object.' },
    { n:'c.setVelocity',     m:'clone prop', v:'${1:c}.setVelocity(${2:vx}, ${3:vy})', d:'Set both velocity components on a stored reference.' },
    { n:'c.stopMovement',    m:'clone prop', v:'${1:c}.stopMovement()', d:'Zero the velocity of a stored reference.' },
    { n:'c.applyForce',      m:'proxy',      v:'${1:c}.applyForce(${2:fx}, ${3:fy})', d:'Apply a physics force to a stored dynamic object.' },
    { n:'c.sendMessage',     m:'clone prop', v:"${1:c}.sendMessage('${2:msg}', ${3:data})", d:'Send a message directly to a stored object.' },
    { n:'c.takeDamage',      m:'clone prop', v:'${1:c}.takeDamage(${2:10})', d:'Deal damage to a stored object.' },
    { n:'c.isTop (opts)',    m:'clone prop', v:'${1:c}.opts.isTop', d:'Read a custom boolean flag from a clone\'s opts.' },
    { n:'c.isTop set',       m:'clone prop', v:'${1:c}.opts.isTop = ${2:true}', d:'Set a custom boolean flag on a clone via its opts.' },

    // ── Proxy (clone/find/spawn reference) extra methods ──────────────────
    { n:'isPlayingAnimation',   m:'anim',      v:'isPlayingAnimation', d:'True if an animation is currently playing on this object.'},
    { n:'c.applyImpulse',       m:'proxy',     v:'${1:c}.applyImpulse(${2:ix}, ${3:iy})', d:'Apply an instant impulse to a stored dynamic object.' },
    { n:'c.ammo',               m:'proxy',     v:'${1:c}.ammo', d:'Read the ammo count of a stored reference.' },
    { n:'c.getState',           m:'proxy',     v:'${1:c}.getState()', d:'Read the current state of a stored reference.' },
    { n:'c.setState',           m:'proxy',     v:"${1:c}.setState('${2:idle}')", d:'Set the state of a stored reference.' },
    { n:'c.getHealth',          m:'proxy',     v:'${1:c}.getHealth()', d:'Read the HP of a stored reference.' },
    { n:'c.setHealth',          m:'proxy',     v:'${1:c}.setHealth(${2:100})', d:'Set the HP of a stored reference.' },
    { n:'c.isDead',             m:'proxy',     v:'${1:c}.isDead', d:'True if a stored reference\'s HP is 0 or below.' },
    { n:'c.isInvincible',       m:'proxy',     v:'${1:c}.isInvincible()', d:'True if a stored reference is currently invincible.' },

    // ── Raycast hit properties (flat — no ._rayHit needed) ────────────────
    { n:'hit.sprite',         m:'raycast',  v:'${1:hit}.sprite', d:'The PIXI sprite of the hit object.' },
    { n:'hit.isTile',         m:'raycast',  v:'${1:hit}.isTile', d:'True if the ray hit a tilemap tile instead of a sprite.' },
    { n:'hit.point.y',        m:'raycast',  v:'${1:hit}.point.y', d:'World Y coordinate where the ray hit.' },
    { n:'hit.normal.y',       m:'raycast',  v:'${1:hit}.normal.y', d:'Surface normal Y at the hit point.' },
    { n:'hit.tile',           m:'raycast',  v:'${1:hit}.tile', d:'Tile data object if the hit was a tile.' },
    // ── drawText proxy methods ──────────────────────────────────────────────
    { n:'t.text',             m:'text',     v:'${1:t}.text = ${2:value}', d:'Directly set the text string on a drawText proxy.' },
    { n:'t.setText',          m:'text',     v:"${1:t}.setText(${2:'hello'})", d:'Update the displayed text on a drawText proxy.' },
    { n:'t.setTextStyle',     m:'text',     v:"${1:t}.setTextStyle({ fontSize: ${2:32}, fill: '${3:#fff}' })", d:'Update font size or color on a drawText proxy.' },
    { n:'t.visible',          m:'text',     v:'${1:t}.visible = ${2:true}', d:'Show or hide a drawText element.' },
    { n:'t.destroy',          m:'text',     v:'${1:t}.destroy()', d:'Remove this drawText element from the game.' },
    // ── Text object (placed in editor) via find() ──────────────────────────
    { n:'setText (obj)',      m:'text',     v:"find('${1:TextLabel}').setText('${2:hello}')", d:'Update text on a named TextLabel object placed in the editor.' },
].map(c => ({ caption:c.n, value:c.v, meta:c.m, score:950, docText: c.d || '' }));


// ── Script Editor (Ace-powered) ───────────────────────────────
export async function openScriptEditor(obj, scriptName, initialCode) {
    // Destroy any existing overlay + its ace instance cleanly
    const oldOverlay = document.getElementById('zengine-script-editor');
    if (oldOverlay) {
        const oldAceEl = oldOverlay.querySelector('#se-ace');
        if (oldAceEl && oldAceEl.env?.editor) {
            try { oldAceEl.env.editor.destroy(); } catch(_) {}
        }
        oldOverlay.remove();
    }

    // Resolve the initial code:
    //  1. If explicitly passed and non-empty, use it
    //  2. Otherwise look up from saved scripts
    //  3. Fall back to the default template
    if (typeof initialCode !== 'string' || initialCode.trim() === '') {
        const { getScript } = await import('./engine.scripting.js');
        const saved = getScript(scriptName);
        initialCode = (saved?.code && saved.code.trim().length > 0)
            ? saved.code
            : _defaultScript(scriptName);
    }

    const ace = await _loadAce();
    ace.config.set('basePath', ACE_BASE);

    const overlay = document.createElement('div');
    overlay.id = 'zengine-script-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#1e1e1e;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

    const canDetach = !!obj && !!obj.scriptName && obj.scriptName === scriptName;
    const objLabel  = obj?.label ?? '';

    overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 14px;background:#252526;border-bottom:1px solid #1a1a1a;flex-shrink:0;user-select:none;">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;flex-shrink:0;fill:none;stroke:#569cd6;stroke-width:2.5;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <span style="color:#d4d4d4;font-weight:600;font-size:13px;">${scriptName}.js</span>
            ${obj ? `<span style="color:#3a3a3a;">│</span><span style="color:#6a6a6a;font-size:11px;">attached to: <b style="color:#9cdcfe;">${objLabel}</b></span>` : ''}
            <div style="flex:1;"></div>
            <span id="se-status" style="font-size:11px;transition:color .2s;margin-right:6px;"></span>
            <button id="se-save"   style="${_bs('#0f2540','#569cd6','#1e4a7a')}">Save <kbd style="opacity:.4;font-size:9px;">Ctrl+S</kbd></button>
            ${canDetach ? `<button id="se-detach" style="${_bs('#200a0a','#f87171','#3a1515')}margin-left:4px;">Detach</button>` : ''}
            <button id="se-close"  style="${_bs('#2d2d2d','#858585','#3c3c3c')}margin-left:4px;">✕</button>
        </div>
        <div style="display:flex;flex:1;min-height:0;">
            <div style="flex:1;position:relative;min-width:0;">
                <div id="se-ace" style="position:absolute;inset:0;"></div>
            </div>
            <div style="width:212px;flex-shrink:0;background:#252526;border-left:1px solid #1a1a1a;overflow-y:auto;">
                ${_sidebarHTML()}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    if (window.lucide) window.lucide.createIcons({ context: overlay });
    _initSidebarBehavior(overlay);  // wire search + click-to-insert after DOM insertion

    // Wait two animation frames so the overlay has real pixel dimensions before ace measures it
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Get the element directly — passing the DOM element (not ID string) bypasses
    // ace's internal element-ID cache, which otherwise returns a dead editor instance
    // from the previous overlay that was already removed from the DOM.
    const aceEl = overlay.querySelector('#se-ace');

    // Belt-and-suspenders: destroy any lingering ace instance on this element
    if (aceEl && aceEl.env?.editor) {
        try { aceEl.env.editor.destroy(); } catch(_) {}
    }

    let editor;
    try {
        editor = ace.edit(aceEl);
        window._seAceEditor = editor; // expose for sidebar click-to-insert
    } catch(initErr) {
        console.error('[Zengine] Ace editor failed to initialize:', initErr);
        if (aceEl) aceEl.innerHTML = `<div style="color:#f87171;padding:20px;font-family:monospace;font-size:13px;">
            ⚠ Script editor failed to load.<br><br>
            ${String(initErr.message)}<br><br>
            <small style="color:#888;">Check your internet connection — the editor requires the Ace library from CDN.</small>
        </div>`;
        return;
    }

    // ── Custom VS Code Dark+ theme — register once, reuse after ──
    if (!ace._zengineThemeDefined) {
        ace._zengineThemeDefined = true;
    ace.define('ace/theme/zengine', ['require','exports','module','ace/lib/dom'], (require, exports, module) => {
        exports.isDark = true;
        exports.cssClass = 'ace-zengine';
        exports.cssText = `
.ace-zengine .ace_gutter                { background:#1e1e1e; color:#858585; border-right:1px solid #2a2a2a; }
.ace-zengine .ace_gutter-active-line    { background:#2a2a2a; color:#c6c6c6; }
.ace-zengine                            { background:#1e1e1e; color:#d4d4d4; }
.ace-zengine .ace_cursor               { color:#d4d4d4; border-left:2px solid #d4d4d4; }
.ace-zengine .ace_selection            { background:#264f78; }
.ace-zengine .ace_selected-word        { background:#264f78; border:none; }
.ace-zengine .ace_active-line          { background:#282828; }
.ace-zengine .ace_highlight-marker     { background:#313131; }
.ace-zengine .ace_indent-guide         { background:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAEklEQVQI12NgMGJgYGBg+A8AAQQBAScAAAAAElFTkSuQmCC") right repeat-y; }
.ace-zengine .ace_bracket              { border:1px solid #808080; }
.ace-zengine .ace_fold                 { background:#569cd6; border-color:#569cd6; }
.ace-zengine .ace_scrollbar-v          { width:8px; }
.ace-zengine .ace_scrollbar            { background:#1e1e1e; }

/* ── Syntax tokens ────────────────────────────────────────── */
/* Keywords: if, else, for, while, return, var, let, const, function, class, new, this, typeof, void */
.ace-zengine .ace_keyword              { color:#569cd6; }
.ace-zengine .ace_keyword.ace_operator { color:#d4d4d4; }
.ace-zengine .ace_keyword.ace_other.ace_unit { color:#b5cea8; }
.ace-zengine .ace_storage              { color:#569cd6; }
.ace-zengine .ace_storage.ace_type     { color:#569cd6; }

/* Strings */
.ace-zengine .ace_string               { color:#ce9178; }
.ace-zengine .ace_string.ace_regexp    { color:#d16969; }

/* Numbers */
.ace-zengine .ace_constant.ace_numeric { color:#b5cea8; }

/* Constants: true, false, null, undefined, NaN, Infinity */
.ace-zengine .ace_constant.ace_language { color:#569cd6; }
.ace-zengine .ace_constant.ace_other   { color:#9cdcfe; }

/* Functions: declaration names and calls */
.ace-zengine .ace_entity.ace_name.ace_function { color:#dcdcaa; }
.ace-zengine .ace_support.ace_function { color:#dcdcaa; }

/* Variables and identifiers */
.ace-zengine .ace_variable             { color:#9cdcfe; }
.ace-zengine .ace_variable.ace_language { color:#569cd6; }
.ace-zengine .ace_variable.ace_parameter { color:#9cdcfe; }

/* Classes and types */
.ace-zengine .ace_entity.ace_name.ace_type  { color:#4ec9b0; }
.ace-zengine .ace_entity.ace_other.ace_inherited-class { color:#4ec9b0; }
.ace-zengine .ace_support.ace_class        { color:#4ec9b0; }

/* Comments */
.ace-zengine .ace_comment               { color:#6a9955; font-style:normal; }
.ace-zengine .ace_comment.ace_doc        { color:#6a9955; }
.ace-zengine .ace_comment.ace_doc.ace_tag { color:#6a9955; }

/* Operators and punctuation */
.ace-zengine .ace_punctuation           { color:#d4d4d4; }

/* Object properties */
.ace-zengine .ace_variable.ace_other.ace_property { color:#9cdcfe; }

/* Meta (import/export) */
.ace-zengine .ace_meta.ace_tag          { color:#569cd6; }

/* ── Zengine Engine API functions — warm amber so they stand out from JS ── */
/* Engine lifecycle/gameplay functions: onStart, walkTo, spawnObject, etc. */
.ace-zengine .ace_zengine_api           { color:#f0a050; font-weight:500; }
/* Math/util shortcuts: lerp, clamp, rand, sin, cos, dist, etc. */
.ace-zengine .ace_zengine_math          { color:#4ec9b0; }
`;
        const dom = require('ace/lib/dom');
        dom.importCssString(exports.cssText, exports.cssClass);
    });
    } // end if !ace._zengineThemeDefined

    editor.setTheme('ace/theme/zengine');
    editor.session.setMode('ace/mode/javascript');

    // ── Engine API syntax highlighting ───────────────────────────────────────
    // Uses Ace's built-in token-rendering pipeline. After each render we walk
    // the visible scroller DOM and tag <span> elements whose text matches an
    // engine API name, adding a CSS class that overrides the color.
    // This is safer than subclassing the Ace tokenizer (which depends on Ace internals).
    if (!ace._zengineHighlightSets) {
        ace._zengineHighlightSets = {
            engine : new Set(["addImpulse", "aiChat", "applyAngularImpulse", "applyForce", "applyImpulse", "axisH", "axisV", "bounceX", "bounceY", "boundsClamp", "broadcastAll", "broadcastGroup", "cameraFollow", "cameraMoveTo", "cameraShake", "onRotate", "setCameraFOV", "getCameraFOV", "cameraZoomTo", "cameraUnfollow", "cancelRepeat", "canSee", "chatPlayer", "chatSay", "clearTint", "cloneInPlace", "cloneObject", "cloneSelf", "createJoystick", "currentAnimation", "currentScene", "currentSceneIndex", "destroyAfter", "destroyAllJoysticks", "destroyObject", "destroySelf", "distanceTo", "dragObject", "drawDebugCircle", "drawDebugLine", "drawText", "error", "fadeIn", "fadeOut", "find", "findAllInGroup", "findAllWithTag", "findWithTag", "flipX", "flipY", "flee", "forever", "getAlpha", "getAmmo", "getCameraX", "getCameraY", "getCloneId", "getGroup", "getHealth", "getMaxAmmo", "getMaxHealth", "getObjectsInRadius", "getRotation", "getScaleX", "getScaleY", "getSceneName", "getState", "getTag", "getTime", "getTint", "getTouches", "getVelX", "getVelY", "getVisible", "getX", "getY", "getZOrder", "GameSave", "globalVar", "gotoScene", "heal", "hide", "hideChat", "hitFlash", "inFOV", "inRangeOf", "invincible", "isClone", "isPlayingAnimation", "isDead", "isDragging", "isInvincible", "isKeyDown", "isKeyJustDown", "isKeyJustUp", "isOnCeiling", "isOnGround", "isOnWall", "isStuck", "isTouching", "isWalking", "lastKnownPos", "lockRotation", "log", "lookAt", "makeDraggable", "makeThrowable", "throwObject", "mouseDown", "mouseJustDown", "mouseX", "mouseY", "move", "moveForward", "moveTo", "objectShake", "offScreen", "onBecomeHidden", "onBecomeVisible", "onCloneStart", "onCollisionEnter", "onCollisionExit", "onCollisionStay", "onDamage", "onDeath", "onDestroy", "onHeal", "onJump", "onKeyDown", "onKeyUp", "onLand", "onMessage", "onMouseClick", "onMouseEnter", "onMouseLeave", "onOverlapEnter", "onOverlapExit", "onPinch", "onReload", "onScreenEnter", "onScreenExit", "onStart", "onStateEnter", "onStateExit", "onStop", "onSwipe", "onTap", "onUpdate", "onceAfter", "opts", "overlaps", "overlapsAllWithTag", "overlapsTag", "pauseAnimation", "pauseScene", "playAnimation", "pursue", "raycast", "raycastAll", "raycastFromSelf", "reload", "repeat", "restartScene", "resumeScene", "say", "sceneCount", "sceneSettings", "sceneVar", "screenMouseX", "screenMouseY", "screenToWorld", "selfName", "sendMessage", "setAlpha", "setAmmo", "setAngularVelocity", "setCollision", "setCollisionCategory", "setCollisionMask", "setGravityScale", "setGroup", "setHealth", "setImmovable", "setMaxAmmo", "setMaxHealth", "setPhysicsType", "setPhysicsVelocity", "setRotation", "setRotationLocked", "setScaleX", "setScaleY", "setSensor", "setState", "setTag", "setTint", "setVelocity", "setVisible", "setX", "setY", "setZOrder", "show", "showChat", "soundPlay", "soundStop", "soundStopAll", "spawnCopy", "spawnObject", "stopAnimation", "stopDrag", "stopMovement", "stopPhysics", "stopWalking", "takeDamage", "think", "touchCount", "touchJustStarted", "trackTarget", "triggerJump", "tween", "unlockRotation", "velocityX", "velocityY", "vx", "vy", "wait", "walkTo", "walkToObject", "wander", "warn", "worldToScreen", "wrap"]),
            math   : new Set(["PI", "abs", "angleTo", "atan2", "ceil", "chance", "clamp", "cos", "dist", "floor", "lerp", "mapRange", "max", "min", "normalize", "pick", "pow", "rand", "randInt", "round", "sign", "sin", "smoothstep", "sqrt", "tan", "toDeg", "toRad", "wrap"]),
        };
    }
    const _Z_ENGINE = ace._zengineHighlightSets.engine;
    const _Z_MATH   = ace._zengineHighlightSets.math;

    // Regex that matches a whole word token (Ace splits JS into word tokens already)
    const _Z_WORD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    function _applyEngineColors() {
        const scroller = aceEl.querySelector('.ace_scroller');
        if (!scroller) return;
        // Walk every text span in the rendered lines
        const spans = scroller.querySelectorAll('.ace_line span');
        for (const span of spans) {
            const t = span.textContent;
            if (!_Z_WORD_RE.test(t)) continue;
            // Remove any previous classification so we don't stack classes
            span.classList.remove('ace_zengine_api', 'ace_zengine_math');
            if (_Z_ENGINE.has(t))      span.classList.add('ace_zengine_api');
            else if (_Z_MATH.has(t))   span.classList.add('ace_zengine_math');
        }
    }

    // Apply after each render cycle (Ace fires 'afterRender' reliably)
    editor.renderer.on('afterRender', _applyEngineColors);
    // Also apply once now on initial load
    requestAnimationFrame(_applyEngineColors);
    // Ensure initialCode is always a valid string — never null/undefined
    const safeCode = (typeof initialCode === 'string' && initialCode.length > 0)
        ? initialCode
        : _defaultScript(scriptName);
    editor.setValue(safeCode, -1);
    editor.session.getUndoManager().reset();   // clear the undo stack so Ctrl+Z can't delete the template
    editor.scrollToLine(0, false, false);
    editor.gotoLine(1, 0, false);
    editor.setOptions({
        enableBasicAutocompletion: true,
        enableSnippets:            true,
        enableLiveAutocompletion:  true,
        showPrintMargin:           false,
        fontSize:                  '13px',
        fontFamily:                '"Fira Code","Cascadia Code","Consolas",monospace',
        tabSize:                   2,
        useSoftTabs:               true,
        highlightActiveLine:       true,
        displayIndentGuides:       true,
        scrollPastEnd:             0.3,
    });

    // Force ace to recalculate its layout now that it has real dimensions
    editor.resize(true);
    editor.renderer.updateFull(true);

    // Safely get langTools — may be null if CDN is slow or offline
    let langTools = null;
    try { langTools = ace.require('ace/ext/language_tools'); } catch(_) {}

    /** Read @script_type from the first 5 lines of the editor. */
    function _getScriptType() {
        const lines = editor.getValue().split('\n').slice(0, 5);
        for (const line of lines) {
            const m = line.match(/@script_type\s*:\s*["']?(\w+)["']?/i);
            if (m) return m[1].toLowerCase();
        }
        return null;
    }

    /** Filter completions by @script_type if declared. */
    function _filterByType(completions) {
        const st = _getScriptType();
        if (!st) return completions;
        return completions.filter(c => {
            const meta = (c.meta || '').toLowerCase();
            if (st === 'dynamic') {
                // hide kinematic-only entries
                if (meta.includes('(kinematic)') && !meta.includes('(dynamic)')) return false;
            } else if (st === 'kinematic') {
                // hide dynamic-only entries
                if (meta.includes('(dynamic)') && !meta.includes('(kinematic)')) return false;
            } else if (st === 'none' || st === 'static') {
                // hide all physics-body-specific entries
                if (meta.includes('(dynamic)') || meta.includes('(kinematic)')) return false;
            }
            return true;
        });
    }

    if (langTools) {
        langTools.addCompleter({
            getCompletions(_ed, _sess, _pos, prefix, cb) {
                const lp = prefix.toLowerCase();
                const filtered = _filterByType(COMPLETIONS);
                cb(null, !lp ? filtered : filtered.filter(c => c.caption.toLowerCase().startsWith(lp)));
            },
            getDocTooltip(item) {
                if (item.docText) {
                    item.docHTML = `<b>${item.caption}</b><hr style="margin:4px 0;border-color:#444">`
                        + `<span style="white-space:pre-wrap;font-size:12px;line-height:1.5">${item.docText}</span>`;
                }
            },
        });
    }

    let _dirty = false;
    const statusEl = overlay.querySelector('#se-status');
    editor.on('change', () => {
        if (!_dirty) { _dirty = true; statusEl.textContent = '● unsaved'; statusEl.style.color = '#facc15'; }
    });

    async function _doSave() {
        const { saveScript } = await import('./engine.scripting.js');
        saveScript(scriptName, editor.getValue());
        if (obj) obj.scriptName = scriptName;
        _dirty = false;
        statusEl.textContent = '✓ saved'; statusEl.style.color = '#4ade80';
        setTimeout(() => { if (!_dirty) statusEl.textContent = ''; }, 2000);
        _logConsole(`💾 Script "${scriptName}" saved`, '#4ade80');
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    }

    overlay.querySelector('#se-save').addEventListener('click', _doSave);
    overlay.querySelector('#se-close').addEventListener('click', async () => {
        if (_dirty && !confirm('Unsaved changes — save before closing?')) { overlay.remove(); return; }
        if (_dirty) await _doSave();
        window._seAceEditor = null;
        overlay.remove();
    });
    overlay.querySelector('#se-detach')?.addEventListener('click', () => {
        if (obj) { obj.scriptName = null; _logConsole(`✂️ Script detached from "${obj.label}"`, '#facc15'); import('./engine.ui.js').then(m => m.syncPixiToInspector()); }
        window._seAceEditor = null;
        overlay.remove();
    });

    editor.commands.addCommand({ name:'save', bindKey:{win:'Ctrl-S',mac:'Command-S'}, exec:_doSave });

    // Attach live linter — red squiggles + error panel + jump-to-line
    attachLinter(editor, aceEl);

    // Defer focus so the browser has fully painted — fixes "can't type" on first open
    requestAnimationFrame(() => {
        editor.resize(true);
        editor.focus();
    });
}

// ── Create Script prompt ──────────────────────────────────────
export function promptCreateScript(obj) {
    const modal = _modal();
    modal.innerHTML = `
        <div style="padding:22px;min-width:330px;">
            <div style="color:#d4d4d4;font-weight:600;font-size:14px;margin-bottom:4px;">Create Script</div>
            <div style="color:#858585;font-size:11px;margin-bottom:14px;">Enter a name for the new script</div>
            <input id="sn-input" type="text" placeholder="e.g. PlayerController" autocomplete="off"
                style="width:100%;box-sizing:border-box;background:#3c3c3c;color:#d4d4d4;border:1px solid #569cd6;border-radius:4px;padding:7px 10px;font-size:13px;outline:none;font-family:monospace;">
            <div id="sn-err" style="color:#f87171;font-size:11px;margin-top:4px;min-height:14px;"></div>
            <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
                <button id="sn-cancel" style="${_bs('#0f1018','#888','#1a1d28')}">Cancel</button>
                <button id="sn-ok"     style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const inp = modal.querySelector('#sn-input');
    const err = modal.querySelector('#sn-err');
    inp.focus();
    modal.querySelector('#sn-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
    modal.querySelector('#sn-ok').onclick = () => {
        const name = inp.value.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!name) { err.textContent = 'Name is required'; return; }
        if (state.scripts.find(s => s.name === name)) { err.textContent = `"${name}" already exists`; return; }
        modal.remove();
        openScriptEditor(obj, name, _defaultScript(name));
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#sn-ok').click(); });
}

// ── Load / Attach Script prompt ───────────────────────────────
export function promptLoadScript(obj) {
    // If no scripts exist yet, inject built-ins first then re-open
    if (state.scripts.length === 0) {
        const loading = _modal();
        loading.innerHTML = `<div style="padding:24px;min-width:220px;text-align:center;color:#888;font-size:13px;">Loading scripts…</div>`;
        document.body.appendChild(loading);
        import('./engine.defaultscripts.js').then(m => {
            m.injectDefaultScripts(state.scripts);
            loading.remove();
            promptLoadScript(obj); // re-open now that scripts exist
            import('./engine.scripting.js').then(s => s.refreshScriptPanel());
        });
        return;
    }

    const modal = _modal();

    const rows = state.scripts.map(s => {
        const attached = obj.scriptName === s.name;
        const ts = new Date(s.updatedAt).toLocaleDateString();
        return `
            <div class="sl-row" data-name="${s.name}"
                style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:4px;margin:2px 0;
                background:${attached ? 'rgba(58,114,165,.15)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;fill:none;stroke:${attached?'#7cb9f0':'#383850'};stroke-width:2;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${attached?'#7cb9f0':'#ccc'};font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${s.name}${attached ? ' <span style="color:#4ade80;font-size:10px;font-weight:400;">● attached</span>' : ''}
                        ${s.isDefault ? ' <span style="color:#4ade80;font-size:9px;font-weight:400;">BUILT-IN</span>' : ''}
                    </div>
                    <div style="color:#383850;font-size:10px;">${ts}</div>
                </div>
                <button class="sl-edit"   data-name="${s.name}" style="${_bs('#0d200d','#8f8','#1e3a1e','3px')}font-size:10px;padding:3px 8px;">Edit</button>
                <button class="sl-attach" data-name="${s.name}" style="${_bs('#0f2540','#7cb9f0','#1e4a7a','3px')}font-size:10px;padding:3px 8px;">${attached ? '✓' : 'Attach'}</button>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:18px;min-width:380px;max-height:70vh;display:flex;flex-direction:column;">
            <div style="color:#d4d4d4;font-weight:600;font-size:14px;margin-bottom:3px;">Load Script</div>
            <div style="color:#444;font-size:11px;margin-bottom:10px;">Attach a script to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;">${rows}</div>
            ${obj.scriptName ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a1a28;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#444;font-size:11px;">Attached: <span style="color:#9bc;">${obj.scriptName}</span></span>
                <button id="sl-detach" style="${_bs('#1a0808','#f87171','#3a1818','3px')}font-size:10px;padding:3px 10px;">Detach</button>
            </div>` : ''}
            <button id="sl-cancel" style="margin-top:10px;${_bs('#0f1018','#888','#1a1d28')}width:100%;text-align:center;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('.sl-row').forEach(r => {
        r.addEventListener('mouseenter', () => { if (!r.style.background.includes('165')) r.style.background = 'rgba(255,255,255,.04)'; });
        r.addEventListener('mouseleave', () => { if (!r.style.background.includes('165')) r.style.background = 'transparent'; });
    });
    modal.querySelectorAll('.sl-edit').forEach(b => {
        b.onclick = async e => {
            e.stopPropagation();
            const { getScript } = await import('./engine.scripting.js');
            const rec = getScript(b.dataset.name);
            modal.remove();
            // Pass null for initialCode — openScriptEditor will load from state.scripts
            // This ensures saved code is always shown, never an empty editor
            openScriptEditor(obj, b.dataset.name, rec?.code ?? null);
        };
    });
    modal.querySelectorAll('.sl-attach').forEach(b => {
        b.onclick = e => {
            e.stopPropagation();
            obj.scriptName = b.dataset.name;
            _logConsole(`📎 "${b.dataset.name}" attached to "${obj.label}"`, '#4ade80');
            modal.remove();
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
            import('./engine.persist.js').then(m => m.markDirty());
        };
    });
    modal.querySelector('#sl-detach')?.addEventListener('click', () => {
        const old = obj.scriptName; obj.scriptName = null;
        _logConsole(`✂️ "${old}" detached from "${obj.label}"`, '#facc15');
        modal.remove();
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
        import('./engine.persist.js').then(m => m.markDirty());
    });
    modal.querySelector('#sl-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
}

// ── Shared helpers ────────────────────────────────────────────
function _bs(bg, color, border, radius='4px') {
    return `background:${bg};color:${color};border:1px solid ${border};border-radius:${radius};padding:5px 12px;cursor:pointer;font-family:inherit;font-size:12px;`;
}

function _modal() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#252526;border:1px solid #3a3a3a;border-radius:6px;box-shadow:0 24px 64px rgba(0,0,0,.9);font-family:system-ui,sans-serif;';
    wrap.appendChild(box);
    Object.defineProperty(wrap,'innerHTML',{ get:()=>box.innerHTML, set:v=>{ box.innerHTML=v; } });
    wrap.querySelector    = s => box.querySelector(s);
    wrap.querySelectorAll = s => box.querySelectorAll(s);
    wrap.addEventListener('click', e => { if (e.target===wrap) wrap.remove(); });
    return wrap;
}


// ── Sidebar syntax highlighter ───────────────────────────────
// Applies lightweight colour to reference panel lines so engine API names,
// strings, numbers, keywords and comments all look like the editor.
(function() {
    const _SB_ENGINE = new Set(["addImpulse", "aiChat", "applyAngularImpulse", "applyForce", "applyImpulse", "axisH", "axisV", "bounceX", "bounceY", "boundsClamp", "broadcastAll", "broadcastGroup", "cameraFollow", "cameraMoveTo", "cameraShake", "onRotate", "setCameraFOV", "getCameraFOV", "cameraZoomTo", "cameraUnfollow", "cancelRepeat", "canSee", "chatPlayer", "chatSay", "clearTint", "cloneInPlace", "cloneObject", "cloneSelf", "createJoystick", "currentAnimation", "currentScene", "currentSceneIndex", "destroyAfter", "destroyAllJoysticks", "destroyObject", "destroySelf", "distanceTo", "dragObject", "drawDebugCircle", "drawDebugLine", "drawText", "error", "fadeIn", "fadeOut", "find", "findAllInGroup", "findAllWithTag", "findWithTag", "flipX", "flipY", "flee", "forever", "getAlpha", "getAmmo", "getCameraX", "getCameraY", "getCloneId", "getGroup", "getHealth", "getMaxAmmo", "getMaxHealth", "getObjectsInRadius", "getRotation", "getScaleX", "getScaleY", "getSceneName", "getState", "getTag", "getTime", "getTint", "getTouches", "getVelX", "getVelY", "getVisible", "getX", "getY", "getZOrder", "GameSave", "globalVar", "gotoScene", "heal", "hide", "hideChat", "hitFlash", "inFOV", "inRangeOf", "invincible", "isClone", "isPlayingAnimation", "isDead", "isDragging", "isInvincible", "isKeyDown", "isKeyJustDown", "isKeyJustUp", "isOnCeiling", "isOnGround", "isOnWall", "isStuck", "isTouching", "isWalking", "lastKnownPos", "lockRotation", "log", "lookAt", "makeDraggable", "makeThrowable", "throwObject", "mouseDown", "mouseJustDown", "mouseX", "mouseY", "move", "moveForward", "moveTo", "objectShake", "offScreen", "onBecomeHidden", "onBecomeVisible", "onCloneStart", "onCollisionEnter", "onCollisionExit", "onCollisionStay", "onDamage", "onDeath", "onDestroy", "onHeal", "onJump", "onKeyDown", "onKeyUp", "onLand", "onMessage", "onMouseClick", "onMouseEnter", "onMouseLeave", "onOverlapEnter", "onOverlapExit", "onPinch", "onReload", "onScreenEnter", "onScreenExit", "onStart", "onStateEnter", "onStateExit", "onStop", "onSwipe", "onTap", "onUpdate", "onceAfter", "opts", "overlaps", "overlapsAllWithTag", "overlapsTag", "pauseAnimation", "pauseScene", "playAnimation", "pursue", "raycast", "raycastAll", "raycastFromSelf", "reload", "repeat", "restartScene", "resumeScene", "say", "sceneCount", "sceneSettings", "sceneVar", "screenMouseX", "screenMouseY", "screenToWorld", "selfName", "sendMessage", "setAlpha", "setAmmo", "setAngularVelocity", "setCollision", "setCollisionCategory", "setCollisionMask", "setGravityScale", "setGroup", "setHealth", "setImmovable", "setMaxAmmo", "setMaxHealth", "setPhysicsType", "setPhysicsVelocity", "setRotation", "setRotationLocked", "setScaleX", "setScaleY", "setSensor", "setState", "setTag", "setTint", "setVelocity", "setVisible", "setX", "setY", "setZOrder", "show", "showChat", "soundPlay", "soundStop", "soundStopAll", "spawnCopy", "spawnObject", "stopAnimation", "stopDrag", "stopMovement", "stopPhysics", "stopWalking", "takeDamage", "think", "touchCount", "touchJustStarted", "trackTarget", "triggerJump", "tween", "unlockRotation", "velocityX", "velocityY", "vx", "vy", "wait", "walkTo", "walkToObject", "wander", "warn", "worldToScreen", "wrap"]);
    const _SB_MATH   = new Set(["PI", "abs", "angleTo", "atan2", "ceil", "chance", "clamp", "cos", "dist", "floor", "lerp", "mapRange", "max", "min", "normalize", "pick", "pow", "rand", "randInt", "round", "sign", "sin", "smoothstep", "sqrt", "tan", "toDeg", "toRad", "wrap"]);

    window._sidebarHighlight = function(safe) {
        // safe is already HTML-escaped. We need to tokenize the raw text.
        // Re-decode just enough to tokenize, then re-escape each token.
        const raw = safe
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
            .replace(/&gt;/g,'>').replace(/&quot;/g,'"');

        // Simple tokenizer: identifiers | strings | numbers | operators | parens
        const tokens = [];
        let i = 0;
        while (i < raw.length) {
            // String literal (single or double quote)
            if (raw[i] === '"' || raw[i] === "'") {
                const q = raw[i]; let j = i+1;
                while (j < raw.length && raw[j] !== q) j++;
                tokens.push({ type:'str', val: raw.slice(i, j+1) });
                i = j+1; continue;
            }
            // Number
            if (/[0-9]/.test(raw[i]) || (raw[i]==='-' && /[0-9]/.test(raw[i+1]||''))) {
                let j = i; if (raw[j]==='-') j++;
                while (j < raw.length && /[0-9.]/.test(raw[j])) j++;
                tokens.push({ type:'num', val: raw.slice(i, j) });
                i = j; continue;
            }
            // Identifier
            if (/[a-zA-Z_]/.test(raw[i])) {
                let j = i;
                while (j < raw.length && /[a-zA-Z0-9_]/.test(raw[j])) j++;
                const word = raw.slice(i, j);
                let type = 'id';
                if (_SB_ENGINE.has(word)) type = 'api';
                else if (_SB_MATH.has(word)) type = 'math';
                else if (word === 'true' || word === 'false' || word === 'null' || word === 'undefined') type = 'kw';
                tokens.push({ type, val: word });
                i = j; continue;
            }
            // Anything else: operators, punctuation, spaces
            tokens.push({ type:'op', val: raw[i] });
            i++;
        }

        // Render tokens to HTML spans
        return tokens.map(t => {
            const v = t.val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            if (t.type === 'api')  return `<span class="se-api">${v}</span>`;
            if (t.type === 'math') return `<span class="se-math">${v}</span>`;
            if (t.type === 'str')  return `<span class="se-str">${v}</span>`;
            if (t.type === 'num')  return `<span class="se-num">${v}</span>`;
            if (t.type === 'kw')   return `<span class="se-kw">${v}</span>`;
            return v;
        }).join('');
    };
})();

function _sidebarHTML() {
    const ICON_MAP = {
        'Events':              'zap',
        'Position':            'move',
        'Velocity':            'gauge',
        'Rotation / Scale':    'rotate-cw',
        'Display':             'eye',
        'Tint':                'palette',
        'Tags & Groups':       'tag',
        'Find Objects':        'search',
        'Messaging':           'send',
        'Overlap':             'layers',
        'Distance':            'ruler',
        'Destroy':             'trash-2',
        'Scene':               'film',
        'Camera':              'camera',
        'Text (runtime)':      'type',
        'Input':               'keyboard',
        'Key Constants':       'key',
        'Mobile / Touch':      'smartphone',
        'Virtual Joystick':    'circle-dot',
        'Drag':                'grab',
        'Animation':           'play-circle',
        'Speech & Chat':       'message-circle',
        'Screen Coords':       'map-pin',
        'Tween':               'sparkles',
        'Timer':               'clock',
        'forever':             'infinity',
        'Spawn / Clone':       'copy-plus',
        'Clone Opts':          'package',
        'Clone Properties':    'link',
        'Physics (helpers)':   'atom',
        'Physics Setup':       'settings-2',
        'Physics Direct':      'cpu',
        'Raycasting':          'scan-line',
        'Health / Damage':     'heart',
        'Ammo':                'crosshair',
        'State Machine':       'git-branch',
        'Sound':               'volume-2',
        'Shared Vars':         'database',
        'AI Navigation':       'navigation',
        'Game Helpers':        'wrench',
        'Shooting (Gun)':      'target',
        'Math':                'calculator',
        'Game Save':           'save',
        'Debug':               'bug',
    };

    const G = [
        ['Events', [
            'onStart(() => { })',
            'onUpdate((dt) => { })',
            'onStop(() => { })',
            'onDestroy(() => { })',
            'onCloneStart(() => { })',
            'onCollisionEnter((other) => { })',
            'onCollisionStay((other) => { })',
            'onCollisionExit((other) => { })',
            'onOverlapEnter((other) => { })',
            'onOverlapExit((other) => { })',
            'onMessage("msg", (data) => { })',
            'onMouseClick(() => { })',
            'onMouseEnter(() => { })',
            'onMouseLeave(() => { })',
            'onBecomeVisible(() => { })',
            'onBecomeHidden(() => { })',
            'onScreenEnter(() => { })',
            'onScreenExit(() => { })',
            'onLand(() => { })',
            'onJump(() => { })',
            'onDamage((amount, src) => { })',
            'onDeath(() => { })',
            'onHeal((amount) => { })',
            'onReload(() => { })',
            'onStateEnter("name", () => { })',
            'onStateExit("name", () => { })',
            'onKeyDown("a", () => { })',
            'onKeyUp("a", () => { })',
            'onSwipe("left", () => { })',
            'onTap(() => { })',
            'onPinch((scale) => { })',
        ]],
        ['Position', [
            'getX()  /  setX(v)',
            'getY()  /  setY(v)',
            'moveTo(x, y)',
            'move(dx, dy)',
            'moveForward(speed)',
            'lookAt(tx, ty)',
            'flipX()  /  flipY()',
            'selfName()                 // own label',
        ]],
        ['Velocity', [
            'velocityX = 5  /  vx = 5',
            'velocityY = 3  /  vy = 3',
            'setVelocity(vx, vy)',
            'stopMovement()',
            'bounceX()  /  bounceY()',
            'addImpulse(vx, vy)',
        ]],
        ['Rotation / Scale', [
            'getRotation()  /  setRotation(deg)',
            'lockRotation()  /  unlockRotation()',
            'setRotationLocked(true)',
            'getScaleX()  /  setScaleX(v)',
            'getScaleY()  /  setScaleY(v)',
        ]],
        ['Display', [
            'show()  /  hide()',
            'setVisible(bool)',
            'getVisible()              // → true/false',
            'getAlpha()  /  setAlpha(v)',
            'fadeIn(t, dt)',
            'fadeOut(t, dt)',
            'setZOrder(n)  /  getZOrder()',
        ]],
        ['Tint', [
            'setTint("#ff0000")        // red tint',
            'setTint("#ffffff")        // remove tint',
            'setTint(0xff6600)         // hex number ok',
            'getTint()                // → "#rrggbb"',
            'clearTint()',
            '// this.tint = "#ff0000" also works in scripts',
        ]],
        ['Tags & Groups', [
            'setTag("name")  /  getTag()',
            'setGroup("name")  /  getGroup()',
            'other.hasTag("enemy")',
        ]],
        ['Find Objects', [
            'find("Label")',
            'findWithTag("tag")',
            'findAllWithTag("tag")     // → array',
            'findAllInGroup("grp")     // → array',
            'getObjectsInRadius(cx, cy, r)',
            'getObjectsInRadius(cx, cy, r, "tag")',
        ]],
        ['Messaging', [
            'sendMessage("tag", "msg", data)',
            'broadcastGroup("grp", "msg")',
            'broadcastAll("msg")',
            'broadcastAll("msg", data)',
            'onMessage("msg", (data) => { })',
        ]],
        ['Overlap', [
            'overlaps(other)',
            'overlapsTag("tag")',
            'overlapsAllWithTag("tag") // → array',
        ]],
        ['Distance', [
            'distanceTo("tag")',
            'distanceTo(x, y)',
            'distanceTo(find("Boss"))',
            'inRangeOf(find("Player"), 3)',
        ]],
        ['Destroy', [
            'destroySelf()',
            'destroyObject(other)',
            'destroyAfter(secs)',
        ]],
        ['Scene', [
            'gotoScene("Name")                              // instant',
            '// 3rd arg = duration seconds (default 0.5)',
            '// 4th arg = options: { freeze: true/false }',
            'gotoScene("Level2", "fade")                    // fade to black',
            'gotoScene("Level2", "fade", 1.2)               // slow fade',
            'gotoScene("Level2", "fade", 0.5, { freeze: true })   // freeze scripts during',
            'gotoScene("Level2", "fade", 0.5, { freeze: false })  // keep scripts running (default)',
            'gotoScene("Level2", "fadewhite")               // fade to white',
            'gotoScene("Level2", "slide-left")              // wipe left',
            'gotoScene("Level2", "slide-right")             // wipe right',
            'gotoScene("Level2", "zoom")                    // zoom punch',
            'gotoScene("Level2", "circle")                  // iris close/open',
            'pauseScene()  /  resumeScene()',
            'restartScene()',
            'currentScene()  /  currentSceneIndex()',
            'sceneCount()',
            'getSceneName(index)',
        ]],
        ['Camera', [
            'cameraFollow(obj, smooth)',
            'cameraUnfollow()',
            'cameraMoveTo(x, y)',
            'getCameraX()  /  getCameraY()',
            'cameraShake(amp, dur)',
            '// ── Field of View (zoom) ──────────────────────────────────',
            'setCameraFOV(60)          // zoom in  (<90 = tighter view)',
            'setCameraFOV(120)         // zoom out (>90 = wider view)',
            'setCameraFOV(90)          // reset to default',
            'getCameraFOV()            // returns current FOV in degrees',
            'cameraZoomTo(60, 1.0)     // smoothly tween to FOV over duration',
            'camera.fov = 70           // set FOV directly via camera object',
            'camera.zoomTo(90, 0.5)    // tween via camera object',
        ]],
        ['Text (runtime)', [
            'drawText("Score: " + n, 0, 3, { id:"score", fontSize:32, fill:"#fff" })',
            '// t.text = "new string"   — update live each frame',
            '// t.setText("new text")   — same effect',
            '// t.setTextStyle({ fontSize:48, fill:"#f00" })',
            '// t.visible = false        — hide the text',
            '// t.destroy()              — remove it',
            '// ── Text object placed in editor ─────────────────────────────',
            "find('TextLabel').text = 'Score: ' + score",
            "find('TextLabel').setText('hello world')",
            '// id prevents duplicate nodes in onUpdate',
            'var t = drawText("Hello", 0, 0, { id:"lbl" })',
            't.text = "new text"',
            't.setText("new text")',
            't.setTextStyle({ fontSize:48, fill:"#f00" })',
            't.visible = false',
            't.destroy()',
        ]],
        ['Input', [
            'isKeyDown("w")',
            'isKeyJustDown("Space")',
            'isKeyJustUp("w")',
            'axisH()  /  axisV()       // -1, 0, +1',
            'mouseX()  /  mouseY()     // world coords',
            'screenMouseX()  /  screenMouseY()',
            'mouseDown()  /  mouseJustDown()',
            'onKeyDown("a", fn)',
            'onKeyUp("a", fn)',
        ]],
        ['Key Constants', [
            'isKeyDown(Key.W)',
            'Key.A  Key.S  Key.D  Key.W',
            'Key.SPACE',
            'Key.ARROW_LEFT  Key.ARROW_RIGHT',
            'Key.ARROW_UP    Key.ARROW_DOWN',
            'Key.ANY                   // any key pressed',
            'Mouse.LEFT',
        ]],
        ['Mobile / Touch', [
            'isTouching()',
            'touchJustStarted()',
            'getTouches()              // → array of {x,y}',
            'touchCount()',
            'onSwipe("left", fn)',
            'onTap(fn)',
            'onPinch(fn)',
        ]],
        ['Virtual Joystick', [
            'var joy = createJoystick()',
            'var joy = createJoystick({ fixed:true, x:150, y:150 })',
            'joy.axisH  /  joy.axisV   // -1 to +1',
            'joy.angle  /  joy.magnitude',
            'joy.active',
            'joy.destroy()',
            'destroyAllJoysticks()',
        ]],
        ['Drag', [
            '// Call makeDraggable inside onStart, not top-level',
            '// Works on ALL body types: dynamic, kinematic, static, none',
            'onStart(() => { makeDraggable(); })',
            'onStart(() => { makeDraggable({ smooth:16, clamp:false, scale:1.08,',
            '    onDrag:(x,y)=>{ log(x,y) },   // fires every frame while held',
            '    onDrop:(x,y)=>{ log("dropped at", x, y) } }); })',
            'isDragging()',
            'stopDrag()',
            'dragObject(find("Crate"))               // drag another object',
            'dragObject(find("Crate"), { onDrag:(x,y)=>{ } })   // with per-frame callback',
        ]],
        ['Drag & Throw', [
            '// makeThrowable: drag + release with physics velocity on ALL body types',
            '// Unlike makeDraggable, uses instant tracking (smooth:0) for throw feel',
            'onStart(() => { makeThrowable(); })',
            'onStart(() => { makeThrowable({ speed:1.4, maxSpeed:25 }); })',
            'onStart(() => { makeThrowable({',
            '    clamp:true, scale:1.1,',
            '    onDrag:(x,y) =>{ log("dragging", x, y) },',
            '    onThrow:(vx,vy)=>{ log("thrown!", vx, vy) } }); })',
            '// Low-level: start throw-drag from a click handler',
            'onMouseClick(() => { throwObject(); })              // throw self',
            'onMouseClick(() => { throwObject(find("Ball")); })  // throw another',
            'onMouseClick(() => { throwObject(null, { speed:2, maxSpeed:40,',
            '    onDrag:(x,y)=>{} }); })',
        ]],
        ['Animation', [
            'playAnimation("name")',
            'stopAnimation()',
            'pauseAnimation()',
            'currentAnimation()       // name or null',
            'isPlayingAnimation       // synced bool (true/false)',
        ]],
        ['Speech & Chat', [
            'say("Hello!")',
            'say("Hello!", 4)          // 4 = duration secs',
            'say("")                   // hide bubble',
            'think("Hmm...")',
            'showChat("Guard", (input) => { return "reply"; })',
            'chatSay("Opening line")',
            'chatPlayer("Player text")',
            'hideChat()',
            'aiChat("Wizard", "system prompt")',
        ]],
        ['Screen Coords', [
            'screenToWorld(sx, sy)     // → {x, y}',
            'worldToScreen(wx, wy)     // → {x, y}',
            'getCameraX()  /  getCameraY()',
            'sceneSettings.gameWidth',
            'sceneSettings.gameHeight',
        ]],
        ['Tween', [
            'tween({ alpha:0 }, 0.5)',
            'tween({ x:5 }, 1, "easeOut")',
            'tween({ scaleX:2, scaleY:2 }, 1, "easeIn")',
            'tween({ rotation:360 }, 2, "linear", () => {})',
            '// properties: x y scaleX scaleY alpha rotation',
            '// easings: linear easeIn easeOut easeInOut',
            '//          elastic bounce steps4',
        ]],
        ['Timer', [
            'wait(seconds, fn)',
            'onceAfter(seconds, fn)',
            'repeat(1.5, fn)           // → id',
            'cancelRepeat(id)',
            'getTime()                // seconds since play start',
        ]],
        ['forever', [
            '// Runs fn every frame — frame-rate independent',
            '// Works anywhere: onStart, onCloneStart, etc.',
            'forever((dt) => { x -= 3 * dt; })',
            '// Stack multiple:',
            'forever((dt) => { x -= speed * dt; })',
            'forever((dt) => { rotation += 90 * dt; })',
            '// Flappy-Bird pipe:',
            'onCloneStart(() => {',
            '    forever((dt) => { x -= 3 * dt; })',
            '    onScreenExit(() => { destroySelf(); })',
            '})',
        ]],
        ['Spawn / Clone', [
            '// All return a proxy you can store and control',
            'var obj = spawnObject("Asset", x, y)',
            'spawnObject("Asset", x, y, (obj) => { })',
            'spawnCopy("Name", x, y)',
            'var c = cloneSelf(x, y)',
            'cloneSelf(x, y, (c) => { c.velocityX = 3; })',
            'cloneInPlace()',
            'var e = cloneObject("Enemy", x, y)',
            'isClone()  /  getCloneId()',
            'onCloneStart(() => { })',
        ]],
        ['Clone Opts', [
            '// Pass data from spawner to clone',
            'cloneSelf(getX(), getY(), (c) => {',
            '    c.opts.speed = 5;',
            '    c.opts.damage = 1;',
            '})',
            'onCloneStart(() => {',
            '    velocityX = opts.speed;',
            '})',
        ]],
        ['Clone Properties', [
            '// Proxy props on any stored ref (clone/spawn/find)',
            'c.x  /  c.y  /  c.rotation',
            'c.scaleX  /  c.scaleY',
            'c.velocityX  /  c.velocityY',
            'c.alpha  /  c.visible',
            'c.health  /  c.state  /  c.ammo',
            'c.tint = "#ff0000"',
            'c.setTint("#ff0000")',
            'c.setVelocity(vx, vy)',
            'c.stopMovement()',
            'c.destroy()',
            'c.sendMessage("msg", data)',
            'c.takeDamage(10)',
            'c.playAnimation("run")',
            'c.opts.myVar',
        ]],
        ['Physics (helpers)', [
            'isOnGround()  /  isOnCeiling()  /  isOnWall()',
            'applyForce(fx, fy)',
            'applyImpulse(ix, iy)',
            'setPhysicsVelocity(vx, vy)',
            'getVelX()  /  getVelY()',
            'setAngularVelocity(rad)',
            'applyAngularImpulse(n)',
            'stopPhysics()',
            'setImmovable(true)',
            'setGravityScale(n)',
        ]],
        ['Physics Setup', [
            'setPhysicsType("static")',
            'setPhysicsType("kinematic")',
            'setPhysicsType("dynamic")',
            'setCollision(true)',
            'setSensor(true)',
            'setCollisionCategory(n)',
            'setCollisionMask(n)',
        ]],
        ['Physics Direct', [
            '// Direct Planck body access (advanced)',
            'physics.setVelocity(vx, vy)',
            'physics.applyForce(fx, fy)',
            'physics.applyImpulse(ix, iy)',
            'physics.setAngularVelocity(r)',
            'physics.applyAngularImpulse(n)',
            'physics.angularVelocity     // read',
            'physics.velX  /  physics.velY',
            'physics.isOnGround  /  physics.isOnCeiling',
            'physics.isOnWall',
            'physics.stop()',
            'physics.setImmovable(true)',
            'physics.immovable           // read',
        ]],
        ['Raycasting', [
            'raycast(x1, y1, x2, y2)',
            '// hits everything (sprites + tilemaps)',
            'raycast(x1, y1, x2, y2, "colliders")',
            '// "colliders" = physics bodies + tilemaps only',
            'raycast(x1, y1, x2, y2, "wall")',
            '// any string = only objects with that tag',
            'raycastAll(x1, y1, x2, y2)  // → array',
            'raycastFromSelf(angleDeg, distance)',
            'raycastFromSelf(90, 5, "colliders")',
            '// hit.point.x  hit.point.y',
            '// hit.normal.x  hit.normal.y',
            '// hit.distance  hit.isTile',
            'Gizmos.raycasts = true',
        ]],
        ['Health / Damage', [
            'setHealth(100)  /  getHealth()',
            'setMaxHealth(200)  /  getMaxHealth()',
            'takeDamage(10)',
            'takeDamage(10, other)      // passes source',
            'heal(25)',
            'isDead()',
            'invincible()              // permanent',
            'invincible(2.5)           // timed (secs)',
            'isInvincible()',
            'hitFlash("#ff0000", 0.2)  // tint flash shorthand',
            'onDamage((amount, src) => { })',
            'onDeath(() => { })',
            'onHeal((amount) => { })',
        ]],
        ['Ammo', [
            'setAmmo(30)  /  getAmmo()',
            'setMaxAmmo(90)  /  getMaxAmmo()',
            'reload()',
            'onReload(() => { })',
        ]],
        ['State Machine', [
            'setState("idle")',
            'getState()',
            'onStateEnter("attack", (next, prev) => { })',
            'onStateExit("attack", (old, next) => { })',
        ]],
        ['Sound', [
            'soundPlay("name")',
            'soundPlay("name", { loop:true, volume:0.6 })',
            'soundPlay("name", { range:10 })',
            'soundStop("name")',
            'soundStopAll()',
        ]],
        ['Shared Vars', [
            'sceneVar.score = 0         // per-scene',
            'globalVar.lives = 3        // all scenes',
            'store.set("key", val)      // persistent (localStorage)',
            'store.get("key")           // reads from localStorage',
            'sceneSettings.gameWidth',
            'sceneSettings.gameHeight',
        ]],
        ['AI Navigation', [
            'walkTo(x, y)',
            'walkTo(x, y, { speed:4, avoidStatic:true })',
            'walkToObject("Player", { speed:3 })',
            'stopWalking()',
            'isWalking                 // true while moving',
            'isStuck                   // true when blocked',
            'pursue("player", { speed:3 })',
            'flee("player", { speed:4 })',
            'wander({ speed:1.5, radius:3 })',
            'canSee("player")',
            'canSee("player", { maxRange:8 })',
            'inFOV("player", 90, 6)    // degrees, range',
            'lastKnownPos("player")    // → {x,y} or null',
        ]],
        ['Game Helpers', [
            'addImpulse(vx, vy)',
            'boundsClamp(margin)',
            'boundsClamp(0, true)       // destroy if offscreen',
            'offScreen(margin)          // → true if offscreen',
            'trackTarget(find("Player"), 5, dt)',
            'hitFlash("#ff0000", 0.2)',
            'objectShake(0.3, 0.4)',
            'inRangeOf(find("Player"), 3)',
            'onceAfter(2, () => { destroySelf(); })',
        ]],
        ['Shooting (Gun)', [
            '// Attach the built-in Gun script to a sprite.',
            '// To fire manually from any script:',
            'var angle = angleTo(getX(), getY(), mouseX(), mouseY())',
            'spawnObject("Bullet", getX(), getY(), (b) => {',
            '    b.setRotation(angle)',
            '    b.velocityX = Math.cos(toRad(angle)) * 20',
            '    b.velocityY = Math.sin(toRad(angle)) * 20',
            '})',
        ]],
        ['Math', [
            'lerp(a, b, t)',
            'clamp(v, lo, hi)',
            'rand(min, max)',
            'randInt(min, max)',
            'pick([a, b, c])',
            'chance(0.25)',
            'dist(x1, y1, x2, y2)',
            'angleTo(x1, y1, x2, y2)',
            'mapRange(v, a1, b1, a2, b2)',
            'wrap(v, lo, hi)',
            'smoothstep(lo, hi, x)',
            'normalize(vx, vy)         // → {x, y}',
            'abs / sign / floor / ceil / round',
            'sin / cos / tan / atan2 / sqrt / pow',
            'max / min / PI / toRad / toDeg',
        ]],
        ['Game Save', [
            '// Survives page close/refresh — stores player progress',
            'GameSave.set("score", 100)',
            'GameSave.get("score", 0)       // 0 = default if missing',
            'GameSave.has("unlocked")       // → true / false',
            'GameSave.delete("key")',
            'GameSave.increment("coins", 1) // add 1, returns new value',
            'GameSave.setAll({ score:0, level:1 })',
            'GameSave.getAll()              // → plain object',
            'GameSave.clear()               // wipe entire slot',
            '// Multiple save files:',
            'GameSave.slot("file2").set("level", 3)',
            'GameSave.slot("file2").get("level", 1)',
            'GameSave.listSlots()           // → ["default","file2"]',
        ]],
        ['Debug', [
            'log(...)',
            'warn(...)',
            'drawDebugLine(x1, y1, x2, y2)',
            'drawDebugLine(x1, y1, x2, y2, "#f00", 1, 2)',
            'drawDebugCircle(cx, cy, radius)',
            'Gizmos.raycasts = true',
            'Gizmos.raycastColor = "#ff4444"',
            'Gizmos.collision = true',
            'Gizmos.collisionColor = "#00ffcc"',
        ]],
    ];

    const rows = G.map(([cat, items]) => {
        const icon = ICON_MAP[cat] || 'code-2';
        const itemHTML = items.map(s => {
            const isComment = s.startsWith('//');
            const safe = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            if (isComment) return `<div class="se-gi se-cm" data-s="">${safe}</div>`;
            const highlighted = _sidebarHighlight(safe);
            return `<div class="se-gi" data-s="${safe}">${highlighted}</div>`;
        }).join('');
        const safeCat = cat.replace(/&/g,'&amp;').replace(/</g,'&lt;');
        return `<div class="se-g" data-cat="${cat.toLowerCase()}"><div class="se-gt"><i data-lucide="${icon}" class="se-cat-icon"></i>${safeCat}</div>${itemHTML}</div>`;
    }).join('');

    return `
<style>
.se-sw{padding:6px 8px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;position:sticky;top:0;z-index:10}
.se-sw input{width:100%;box-sizing:border-box;background:#2d2d2d;border:1px solid #3a3a3a;border-radius:4px;color:#d4d4d4;font-size:11px;padding:4px 8px 4px 28px;outline:none;font-family:"Fira Code","Consolas",monospace}
.se-sw input:focus{border-color:#569cd6}
.se-sw input::placeholder{color:#555}
.se-sw-wrap{position:relative}
.se-sw-icon{position:absolute;left:8px;top:50%;transform:translateY(-50%);pointer-events:none;width:11px;height:11px;color:#555}
.se-sw-icon svg{width:11px;height:11px;stroke:#555;fill:none;stroke-width:2;display:block}
.se-g{border-top:1px solid #2a2a2a}
.se-g:first-child{border-top:none}
.se-gt{padding:5px 10px 2px;color:#569cd6;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;user-select:none;display:flex;align-items:center;gap:5px}
.se-cat-icon{width:9px;height:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.se-cat-icon svg{width:9px;height:9px;stroke:#569cd6;fill:none;stroke-width:2.5;display:block}
.se-gi{padding:1px 10px;font-size:10px;line-height:1.8;font-family:"Fira Code","Consolas",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#5a6a7a;cursor:default}
.se-gi:not(.se-cm){color:#8fbcd4;cursor:pointer}
.se-gi:not(.se-cm):hover{color:#fff;background:#2a4060}
.se-gi:not(.se-cm):active{background:#1e4a7a}
.se-cm{color:#3d4d5a;font-style:italic}
.se-api{color:#f0a050;font-weight:500}
.se-math{color:#4ec9b0}
.se-str{color:#ce9178}
.se-kw{color:#569cd6}
.se-num{color:#b5cea8}
</style>
<div class="se-sw"><div class="se-sw-wrap"><i data-lucide="search" class="se-sw-icon"></i><input id="se-search" type="text" placeholder="Search API..." autocomplete="off" spellcheck="false"/></div></div>
<div id="se-groups">${rows}</div>`;
}

function _initSidebarBehavior(overlay) {
    const inp    = overlay.querySelector('#se-search');
    const groups = overlay.querySelector('#se-groups');
    if (!inp || !groups) return;

    // ── Search filter ─────────────────────────────────────
    inp.addEventListener('input', function() {
        const q = this.value.toLowerCase().trim();
        groups.querySelectorAll('.se-g').forEach(g => {
            const cat  = g.getAttribute('data-cat') || '';
            const rows = g.querySelectorAll('.se-gi');
            let any = false;
            rows.forEach(r => {
                const show = !q || cat.includes(q) || r.textContent.toLowerCase().includes(q);
                r.style.display = show ? '' : 'none';
                if (show && !r.classList.contains('se-cm')) any = true;
            });
            g.style.display = (!q || any || cat.includes(q)) ? '' : 'none';
        });
    });
    inp.addEventListener('keydown', e => {
        if (e.key === 'Escape') { inp.value = ''; inp.dispatchEvent(new Event('input')); }
    });

    // ── Click to insert ───────────────────────────────────
    groups.addEventListener('click', e => {
        const row = e.target.closest('.se-gi');
        if (!row || row.classList.contains('se-cm')) return;
        const snip = row.getAttribute('data-s');
        if (!snip) return;

        const ed = window._seAceEditor;
        if (ed && !ed.destroyed) {
            ed.focus();
            ed.insert(snip);
        } else {
            // fallback: clipboard
            navigator.clipboard?.writeText(snip).then(() => {
                const old = row.style.background;
                row.style.background = '#1a3a1a';
                setTimeout(() => row.style.background = old, 300);
            });
        }
    });
}

function _defaultScript(name) {
    return `// ================================================================
// Script: ${name}
// Runs only during Play Mode. The editor is always safe.
//
// ── QUICK REFERENCE ──────────────────────────────────────────────
// POSITION:    getX() / setX(v)      getY() / setY(v)
// MOVEMENT:    move(dx, dy)          moveTo(x, y)     moveForward(speed)
// VELOCITY:    velocityX = 5         velocityY = -3
// EVENTS:      onStart / onUpdate(dt) / onStop / onCollisionEnter(other)
// PHYSICS:     applyForce(fx,fy)     applyImpulse(ix,iy)    isOnGround()
// CAMERA:      cameraFollow(find("${name}"), 6)
// TINT:        setTint("#ff0000")    clearTint()
// SOUND:       soundPlay("Jump")     soundStopAll()
// TIMER:       wait(2, () => { destroySelf(); })
// SCENE:       gotoScene("Level2")   restartScene()
// FIND:        find("Label")         findWithTag("enemy")    getObjectsInRadius(cx,cy,r)
// MESSAGE:     sendMessage("enemy","takeDamage",10)  broadcastAll("gameOver")
//
// ── RAYCAST & DETECTION GUIDE ────────────────────────────────────
//
// Raycast fires an invisible beam and returns what it hits first.
//
//   raycast(x1, y1, x2, y2)          — single hit, returns null or hit
//   raycast(x1, y1, x2, y2, "wall")  — only objects tagged "wall"
//   raycastAll(x1, y1, x2, y2)       — all hits, nearest→farthest
//   raycastFromSelf(angleDeg, dist)   — fires from self, angle in degrees
//                                       0=right  90=up  180=left  270=down
//
// Hit object fields:
//   hit.point.x / hit.point.y        — world position of the impact
//   hit.normal.x / hit.normal.y      — surface normal at impact
//   hit.distance                     — world units from start to hit
//   hit.name                         — label of the struck object
//   hit.tag                          — tag of the struck object
//   hit.isTile                       — true if a tilemap cell was hit
//   hit.sprite                       — proxy for the struck object (or null for tiles)
//
// Proximity & sight:
//   getObjectsInRadius(cx, cy, r)    — returns array of proxies, nearest→farthest
//   getObjectsInRadius(cx, cy, r, "enemy")  — tag-filtered
//   canSee("player")                 — raycast + range check combined
//   canSee("player", { maxRange:8 }) — with distance limit
//   inFOV("player", 90, 6)           — cone check: 90° FOV, 6 unit range
//
// Debug visualization (add in onStart):
//   Gizmos.raycasts   = true;        — show all raycasts as colored lines
//   Gizmos.collision  = true;        — show collision shapes
// ================================================================


onStart(() => {
  setTag("${name.toLowerCase()}");
  log("${name} started!");

  // ── Visualize all raycasts while in Play Mode ──────────────────
  Gizmos.raycasts = true;
  Gizmos.raycastColor = "#00ffcc";
});


onUpdate((dt) => {
  const speed = 5;
  move(axisH() * speed * dt, axisV() * speed * dt);


  // ════════════════════════════════════════════════════════════════
  // RAYCAST EXAMPLES — uncomment the one you want to try
  // ════════════════════════════════════════════════════════════════

  // ── 1. Probe directly below (floor/ground detection) ────────────
  // var below = raycast(getX(), getY(), getX(), getY() - 2);
  // if (below) {
  //   if (below.isTile) {
  //     log("Standing on a tile, dist:", below.distance.toFixed(2));
  //   } else {
  //     log("Standing on:", below.name, "dist:", below.distance.toFixed(2));
  //   }
  // }


  // ── 2. Fire a ray forward in the direction I'm facing ───────────
  // var fwd = raycastFromSelf(getRotation(), 8);
  // if (fwd) {
  //   log("Ahead:", fwd.name || "tile", "@", fwd.distance.toFixed(2), "units");
  //   drawDebugLine(getX(), getY(), fwd.point.x, fwd.point.y, "#ff4444");
  // }


  // ── 3. Shoot toward the mouse cursor ────────────────────────────
  // var angle = angleTo(getX(), getY(), mouseX(), mouseY());
  // var mhit = raycast(getX(), getY(), mouseX(), mouseY());
  // if (mhit) {
  //   log("Mouse ray hit:", mhit.name || "tile");
  // }


  // ── 4. Get ALL hits along a ray (piercing) ──────────────────────
  // var hits = raycastAll(getX(), getY(), getX() + 12, getY());
  // for (var i = 0; i < hits.length; i++) {
  //   log("Hit #" + i + ":", hits[i].name, "at", hits[i].distance.toFixed(2));
  // }


  // ── 5. Proximity ring — all objects within radius ───────────────
  // var nearby = getObjectsInRadius(getX(), getY(), 5);
  // var enemies = getObjectsInRadius(getX(), getY(), 5, "enemy");
  // for (var i = 0; i < enemies.length; i++) {
  //   log("Nearby enemy:", enemies[i].name);
  // }


  // ── 6. Line-of-sight using canSee ───────────────────────────────
  // if (canSee("player")) {
  //   log("I can see the player!");
  // }
  // if (canSee("player", { maxRange: 8 })) {
  //   log("Player visible within 8 units");
  // }


  // ── 7. Field-of-view cone ───────────────────────────────────────
  // if (inFOV("player", 90, 6)) {
  //   log("Player is in my 90-degree FOV, within 6 units");
  // }


  // ── 8. Wall-bounce: reflect velocity off surface normal ─────────
  // var wall = raycastFromSelf(getRotation(), 1.5);
  // if (wall) {
  //   var dot = velocityX * wall.normal.x + velocityY * wall.normal.y;
  //   velocityX -= 2 * dot * wall.normal.x;
  //   velocityY -= 2 * dot * wall.normal.y;
  // }


  // ── 9. Draw a 360-degree vision ring for debugging ─────────────
  // for (var a = 0; a < 360; a += 15) {
  //   var r = raycastFromSelf(a, 6);
  //   if (r) {
  //     drawDebugLine(getX(), getY(), r.point.x, r.point.y, "#ff8800", 0, 1);
  //   }
  // }

});


onStop(() => {
  soundStopAll();
  log("${name} stopped.");
});


onCollisionEnter((other) => {
  // Fires when this object physically touches another (needs physics body).
  if (!other) return;
  log("Collided with:", other.name, "tag:", other.tag);

  // Properties on 'other': name, tag, x, y, scaleX, scaleY, rotation, alpha
  // Methods on 'other': other.hasTag("wall")  other.destroy()
  //                     other.sendMessage("hit", data)
  //                     other.setTint("#f00")
});


onOverlapEnter((other) => {
  // Like collision but works WITHOUT a physics body (pure AABB).
  // Perfect for: coins, checkpoints, trigger zones.
  if (!other) return;
  log("Overlapped:", other.name);
});


onMessage("takeDamage", (amount) => {
  warn("Took " + amount + " damage!");
  hitFlash("#ff0000", 0.2);
});
`;
}

// _logConsole is defined in engine.scripting.js
