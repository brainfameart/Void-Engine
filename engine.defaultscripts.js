/* ============================================================
   Zengine — engine.defaultscripts.js
   Ready-to-use starter scripts. Injected into every new project.

   Users attach these to any sprite via Inspector → Load Script.

   Scripts:
     PlatformerPlayer  — WASD/arrows + jump + coyote time + shooting gun
     TopDownPlayer     — 8-dir movement + mouse aim + camera
     PatrolEnemy       — patrol + player detection + messaging
     HealthSystem      — HP, damage, heal, flash invincibility
     Rotator           — constant rotation (coins, hazards)
     Destroyer         — self-destruct after a timer with fade
     Oscillator        — sine-wave bobbing motion
     EnemySpawner      — efficient edge-based spawning with pool
     ChaseAI           — smart chase enemy; works with EnemySpawner
     SceneManager      — scene transitions & score/lives tracking
     Gun               — mouse-aim gun that fires Bullet objects
     Bullet            — projectile: damages enemies, destroys on hit
     Enemy             — patrol+chase enemy with health/death/score
   ============================================================ */

export const DEFAULT_SCRIPTS = [

// ── 1. Platformer Player ─────────────────────────────────────
{
    name: 'PlatformerPlayer',
    code: `// ============================================================
// PLATFORMER PLAYER  (with shooting gun)
// Requires: Kinematic physics body on this object.
//           A tilemap or static floor below to land on.
//
// Controls:
//   A / D  or Left/Right    move
//   W / Space / Up          jump
//   Left click / F          shoot  (needs a "Bullet" asset)
// ============================================================

var SPEED          = 5;      // world units / sec
var JUMP_FORCE     = 12;     // upward velocity on jump
var GRAVITY        = -28;    // downward accel per sec²
var MAX_FALL       = -20;    // terminal velocity
var COYOTE_TIME    = 0.12;   // grace period to jump after walking off edge
var BULLET_SPEED   = 18;     // bullet units / sec
var SHOOT_COOLDOWN = 0.18;   // min seconds between shots

var grounded   = false;
var coyote     = 0;
var facing     = 1;          // 1 = right, -1 = left
var shootTimer = 0;

onStart(() => {
  setTag("player");
  cameraFollow(findWithTag("player"), 7);
  log("Platformer: A/D move  W/Space jump  click/F shoot");
});

onUpdate((dt) => {
  // ── Gravity ────────────────────────────────────────────────
  velocityY = velocityY + GRAVITY * dt;
  if (velocityY < MAX_FALL) velocityY = MAX_FALL;

  // ── Horizontal ─────────────────────────────────────────────
  var h = axisH();
  velocityX = h * SPEED;
  if (h > 0)  { facing =  1; setScaleX( 1); }
  if (h < 0)  { facing = -1; setScaleX(-1); }

  // ── Coyote time + jump ─────────────────────────────────────
  coyote = max(0, coyote - dt);
  if (isKeyJustDown("w") || isKeyJustDown("arrowup") || isKeyJustDown(" ")) {
    if (grounded || coyote > 0) {
      velocityY = JUMP_FORCE;
      grounded  = false;
      coyote    = 0;
    }
  }

  // ── Shoot ──────────────────────────────────────────────────
  shootTimer = max(0, shootTimer - dt);
  if (shootTimer <= 0 && (mouseJustDown() || isKeyJustDown("f"))) {
    // spawnObject runs the Bullet script fully (onCollisionEnter, lifetime, damage)
    var dir = facing > 0 ? 1 : -1;
    spawnObject("Bullet", getX() + dir * 0.6, getY(), (b) => {
      b.velocityX = dir * BULLET_SPEED;
      b.velocityY = 0;
    });
    shootTimer = SHOOT_COOLDOWN;
  }

  // ── Animation ──────────────────────────────────────────────
  if (!grounded) {
    playAnimation(velocityY > 0 ? "jump" : "fall");
  } else if (abs(velocityX) > 0.1) {
    playAnimation("run");
  } else {
    playAnimation("idle");
  }
});

onCollisionEnter((other) => {
  if (!other) return;
  // Land when hitting something below us
  if (velocityY <= 0 && other.y <= getY()) {
    grounded  = true;
    coyote    = COYOTE_TIME;
    velocityY = 0;
  }
});

onCollisionExit(() => {
  if (grounded) {
    grounded = false;
    coyote   = COYOTE_TIME;
  }
});

onStop(() => { velocityX = 0; velocityY = 0; grounded = false; coyote = 0; });
`,
},

// ── 2. Top-Down Player ───────────────────────────────────────
{
    name: 'TopDownPlayer',
    code: `// ============================================================
// TOP-DOWN PLAYER
// 8-directional WASD/arrows movement.
// Camera follows this object smoothly.
// Mouse rotates the player to aim.
// ============================================================

var SPEED = 5;   // world units per second

onStart(() => {
  setTag("player");
  cameraFollow(findWithTag("player"), 6);
  log("Top-Down Player ready — WASD / arrows to move, mouse to aim");
});

onUpdate((dt) => {
  // ── Movement ─────────────────────────────────────────────
  var h = axisH();
  var v = axisV();
  move(h * SPEED * dt, v * SPEED * dt);

  // ── Aim toward mouse ─────────────────────────────────────
  lookAt(mouseX(), mouseY());

  // ── Animation ────────────────────────────────────────────
  playAnimation((abs(h) > 0.01 || abs(v) > 0.01) ? "walk" : "idle");
});

onOverlapEnter((other) => {
  if (!other) return;
  if (other.hasTag("coin")) {
    sceneVar.score = (sceneVar.score || 0) + 1;
    log("Score: " + sceneVar.score);
    other.destroy();
  }
});

onMessage("enemySpotted", () => {
  warn("Enemy has spotted you!");
});
`,
},

// ── 3. Patrol Enemy ──────────────────────────────────────────
{
    name: 'PatrolEnemy',
    code: `// ============================================================
// PATROL ENEMY
// Walks back and forth. Detects the player. Takes damage.
//
// Setup: Give this object a Kinematic physics body.
//        Attach HealthSystem script as well for full HP logic.
// ============================================================

var SPEED        = 2.5;
var PATROL_DIST  = 4;
var DETECT_RANGE = 4;

var startX  = 0;
var dirX    = 1;
var alerted = false;

onStart(() => {
  setTag("enemy");
  setGroup("enemies");
  startX = getX();
  setHealth(3);
  setMaxHealth(3);
  log("Patrol Enemy ready");
});

onUpdate((dt) => {
  // ── Patrol ──────────────────────────────────────────────
  velocityX = dirX * SPEED;
  setScaleX(dirX);

  if (getX() > startX + PATROL_DIST) dirX = -1;
  if (getX() < startX - PATROL_DIST) dirX =  1;

  // ── Player detection ────────────────────────────────────
  var player = findWithTag("player");
  if (player) {
    var d = distanceTo(player);
    if (d < DETECT_RANGE && !alerted) {
      alerted = true;
      broadcast("player", "enemySpotted");
    }
    if (d >= DETECT_RANGE + 1) alerted = false;
  }
});

onCollisionEnter((other) => {
  // Reverse when hitting a wall (not the player)
  if (other && !other.hasTag("player")) dirX = -dirX;
});

onDamage((amount) => {
  hitFlash("#ff4444", 0.12);
  warn("Enemy hit! HP: " + health);
});

onDeath(() => {
  sceneVar.score = (sceneVar.score || 0) + 10;
  log("Enemy defeated! Score: " + sceneVar.score);
  destroy();
});

onStop(() => {
  velocityX = 0;
  alerted   = false;
  dirX      = 1;
});
`,
},

// ── 4. Health System ─────────────────────────────────────────
{
    name: 'HealthSystem',
    code: `// ============================================================
// HEALTH SYSTEM
// Gives any object hitpoints, invincibility frames, and death.
//
// From another script:
//   sendMessage("player", "takeDamage", 1)
//   sendMessage("player", "heal", 2)
// ============================================================

var MAX_HP   = 10;
var I_FRAMES = 1.0;   // invincibility seconds after being hit

onStart(() => {
  setHealth(MAX_HP);
  setMaxHealth(MAX_HP);
  setAlpha(1);
  log("HealthSystem ready — HP: " + MAX_HP);
});

onDamage((amount) => {
  hitFlash("#ff4444", 0.12);
  cameraShake(0.15, 0.2);
  warn("Took " + amount + " dmg — HP: " + health + "/" + MAX_HP);
});

onDeath(() => {
  log("Died!");
  broadcastAll("entityDied");
  destroy();
});

onMessage("takeDamage", (amount) => {
  takeDamage(amount || 1);
});

onMessage("heal", (amount) => {
  heal(amount || 1);
  setAlpha(1);
  log("Healed — HP: " + health + "/" + MAX_HP);
});
`,
},

// ── 5. Rotator ───────────────────────────────────────────────
{
    name: 'Rotator',
    code: `// ============================================================
// ROTATOR — spins this object at a constant speed.
// Great for: coins, spinning hazards, icons.
// ============================================================

var DEGREES_PER_SECOND = 180;   // positive = clockwise

onUpdate((dt) => {
  setRotation(getRotation() + DEGREES_PER_SECOND * dt);
});
`,
},

// ── 6. Destroyer ─────────────────────────────────────────────
{
    name: 'Destroyer',
    code: `// ============================================================
// DESTROYER — removes this object after LIFETIME seconds.
// Fades out near the end. Perfect for bullets, VFX.
// ============================================================

var LIFETIME   = 3.0;   // seconds until removed
var FADE_START = 0.8;   // seconds before death to begin fading

var elapsed = 0;

onStart(() => {
  elapsed = 0;
  setAlpha(1);
});

onUpdate((dt) => {
  elapsed = elapsed + dt;

  if (elapsed > LIFETIME - FADE_START) {
    var t = clamp((LIFETIME - elapsed) / FADE_START, 0, 1);
    setAlpha(t);
  }

  if (elapsed >= LIFETIME) destroySelf();
});
`,
},

// ── 7. Oscillator ────────────────────────────────────────────
{
    name: 'Oscillator',
    code: `// ============================================================
// OSCILLATOR — bobs this object smoothly with a sine wave.
// Great for: floating platforms, coins, decorative elements.
// ============================================================

var AMPLITUDE = 0.5;    // how far to move (world units)
var FREQUENCY = 1.0;    // oscillations per second
var AXIS      = "y";    // "y" = up/down,  "x" = left/right

var originX = 0;
var originY = 0;

onStart(() => {
  originX = getX();
  originY = getY();
});

onUpdate((dt) => {
  var offset = sin(getTime() * FREQUENCY * PI * 2) * AMPLITUDE;
  if (AXIS === "y") setY(originY + offset);
  else              setX(originX + offset);
});
`,
},

// ── 8. Enemy Spawner ─────────────────────────────────────────
{
    name: 'EnemySpawner',
    code: `// ============================================================
// ENEMY SPAWNER  (efficient edge-based spawning)
// Attach to any object in your scene.
//
// Spawns copies of an object named "Enemy" from random
// screen edges. Uses a simple active-count cap so you never
// get more than MAX_ALIVE enemies at once.
//
// Pair with the ChaseAI or Enemy script on your Enemy template.
// ============================================================

var INTERVAL   = 2.5;   // seconds between spawn attempts
var MAX_ALIVE  = 8;     // hard cap — won't spawn if at limit
var SPAWN_DIST = 8;     // world units from centre to spawn at

onStart(() => {
  sceneVar.enemyCount = 0;
  log("EnemySpawner ready. Template object must be named 'Enemy'.");

  repeat(INTERVAL, () => {
    // Respect the cap
    if ((sceneVar.enemyCount || 0) >= MAX_ALIVE) return;

    // Pick a random point on the edge of a circle around the scene centre
    var angle = rand(0, PI * 2);
    var sx = cos(angle) * SPAWN_DIST;
    var sy = sin(angle) * SPAWN_DIST;

    spawnObject("Enemy", sx, sy, (e) => {
      e.setTag("enemy");
      sceneVar.enemyCount = (sceneVar.enemyCount || 0) + 1;
    });
  });
});
`,
},

// ── 9. Chase AI ──────────────────────────────────────────────
{
    name: 'ChaseAI',
    code: `// ============================================================
// CHASE AI  — Smart obstacle-aware pursuit enemy
//
// Behaviour layers (in order of priority):
//   1. MELEE    — stop and strike when close enough
//   2. CHASE    — A* pursuit with prediction + separation steering
//   3. SEARCH   — walk to last-known position when player out of sight
//   4. WANDER   — drift randomly when player was never seen / lost
//
// Works standalone or spawned by EnemySpawner.
// ============================================================

var SPEED        = 2.5;    // world units / sec while chasing
var DAMAGE       = 1;
var MELEE_DIST   = 0.55;   // deal damage when this close (world units)
var SIGHT_RANGE  = 8;      // vision range in world units
var REPATH_SEC   = 0.3;    // seconds between path recalculations

// Internal state machine
var STATE        = "wander";  // "wander" | "chase" | "search"
var searchTimer  = 0;         // seconds left searching the last-known spot
var SEARCH_TIME  = 4;         // seconds to investigate before giving up

onStart(() => {
  setTag("enemy");
  setHealth(3);
  setMaxHealth(3);
  // Start wandering so enemies aren't frozen when player is absent
  wander({ speed: 1.2, radius: 4, changeInterval: 2.5 });
});

onUpdate((dt) => {
  var target = findWithTag("player");

  // ── No player object in scene ────────────────────────────────
  if (!target) {
    if (STATE !== "wander") {
      STATE = "wander";
      wander({ speed: 1.2, radius: 4, changeInterval: 2.5 });
    }
    return;
  }

  var d = distanceTo(target);

  // ── MELEE: close enough to strike ────────────────────────────
  if (d < MELEE_DIST) {
    stopWalking();
    STATE = "wander";
    target.takeDamage(DAMAGE);
    hitFlash("#ff4444", 0.15);
    sceneVar.enemyCount = max(0, (sceneVar.enemyCount || 1) - 1);
    destroy();
    return;
  }

  // ── Can we see the player? ────────────────────────────────────
  var visible = canSee(target, { maxRange: SIGHT_RANGE });

  if (visible) {
    searchTimer = SEARCH_TIME; // reset search timer whenever player is seen

    // ── CHASE: pursue with prediction + separation ────────────
    if (STATE !== "chase") {
      STATE = "chase";
      pursue("player", {
        speed:           SPEED,
        avoidStatic:     true,
        stopRadius:      MELEE_DIST * 0.8,
        repath:          REPATH_SEC,
        follow:          true,
        separation:      true,      // avoid stacking on other enemies
        separationRadius: 1.2,
        predictTime:     0.4,       // lead the player slightly
      });
    }

  } else {
    // Player not visible — use memory

    if (STATE === "chase") {
      // Just lost sight — switch to SEARCH at last known position
      var lkp = lastKnownPos("player");
      if (lkp) {
        STATE = "search";
        searchTimer = SEARCH_TIME;
        walkTo(lkp.x, lkp.y, {
          speed:       SPEED * 0.85,
          avoidStatic: true,
          stopRadius:  0.5,
        });
      } else {
        STATE = "wander";
        wander({ speed: 1.2, radius: 4, changeInterval: 2.5 });
      }
    }

    if (STATE === "search") {
      searchTimer -= dt;
      if (searchTimer <= 0 || !isWalking) {
        // Gave up or reached the last-known spot — start wandering
        STATE = "wander";
        wander({ speed: 1.2, radius: 4, changeInterval: 2.5 });
      }
    }

    // STATE === "wander" — wander() is already running, nothing to do
  }
});

onDamage((amount) => {
  hitFlash("#ff6600", 0.1);
});

onDeath(() => {
  sceneVar.score      = (sceneVar.score || 0) + 10;
  sceneVar.enemyCount = max(0, (sceneVar.enemyCount || 1) - 1);
  destroy();
});

onStop(() => {
  stopWalking();
  STATE = "wander";
});
`,
},

// ── 10. Scene Manager ────────────────────────────────────────
{
    name: 'SceneManager',
    code: `// ============================================================
// SCENE MANAGER
// Attach to any persistent object (e.g. a UI overlay sprite).
//
// From other scripts:
//   sceneVar.score += 10;
//   sendMessage("scenemanager", "nextScene");
//   sendMessage("scenemanager", "restartScene");
//   sendMessage("scenemanager", "gotoScene", "Level2");
//   sendMessage("scenemanager", "addScore",  10);
//   sendMessage("scenemanager", "loseLife");
// ============================================================

onStart(() => {
  setTag("scenemanager");

  sceneVar.score  = sceneVar.score  || 0;
  sceneVar.lives  = sceneVar.lives  || 3;
  sceneVar.paused = false;

  globalVar.highScore = globalVar.highScore || 0;

  log("Scene: " + currentScene() +
      "  Score: " + sceneVar.score +
      "  Lives: " + sceneVar.lives);
});

onUpdate((dt) => {
  // Keep high score up to date
  if (sceneVar.score > (globalVar.highScore || 0)) {
    globalVar.highScore = sceneVar.score;
  }
});

onMessage("nextScene", () => {
  var next = currentSceneIndex() + 1;
  if (next < sceneCount()) gotoScene(next);
  else { log("No more scenes! Final score: " + sceneVar.score); broadcastAll("gameComplete"); }
});

onMessage("restartScene", () => {
  gotoScene(currentSceneIndex());
});

onMessage("gotoScene", (nameOrIndex) => {
  gotoScene(nameOrIndex);
});

onMessage("addScore", (amount) => {
  sceneVar.score = sceneVar.score + (amount || 1);
  log("Score: " + sceneVar.score);
});

onMessage("loseLife", () => {
  sceneVar.lives = sceneVar.lives - 1;
  warn("Lives remaining: " + sceneVar.lives);
  if (sceneVar.lives <= 0) {
    broadcastAll("gameOver");
    log("GAME OVER — final score: " + sceneVar.score);
  }
});

onMessage("entityDied", () => {
  sceneVar.score = sceneVar.score + 5;
});
`,
},

// ── 11. Gun ──────────────────────────────────────────────────
{
    name: 'Gun',
    code: `// ============================================================
// GUN SCRIPT
// Attach to any sprite to make it a gun.
// Rotates to face the mouse and fires Bullet objects.
//
// SETUP:
//   1. Add a sprite to your scene (this is the gun).
//   2. Attach this script to it.
//   3. In your project, create a small sprite asset named "Bullet"
//      and attach the Bullet script to it.
//
// HOW BULLETS WORK:
//   spawnObject("Bullet", x, y) creates a full copy of your Bullet
//   asset — including its script — so onCollisionEnter, damage,
//   and lifetime all work exactly as written in the Bullet script.
// ============================================================

var BULLET_SPEED = 20;     // world units per second
var FIRE_RATE    = 0.15;   // seconds between shots
var AUTO_FIRE    = false;  // true = hold mouse to fire, false = click

var cooldown = 0;

onStart(() => {
  setTag("gun");
  log("Gun ready — aim with mouse, " + (AUTO_FIRE ? "hold" : "click") + " to fire");
});

onUpdate((dt) => {
  cooldown = max(0, cooldown - dt);

  // Rotate to face mouse
  var angle = angleTo(getX(), getY(), mouseX(), mouseY());
  setRotation(-angle);
  setScaleY(mouseX() < getX() ? -abs(getScaleY()) : abs(getScaleY()));

  // Fire
  var wantFire = AUTO_FIRE ? mouseDown() : mouseJustDown();
  if (wantFire && cooldown <= 0) {
    var rad = (angle * PI) / 180;
    // Spawn at muzzle tip, half a unit in front
    var bx = getX() + cos(rad) * 0.6;
    var by = getY() + sin(rad) * 0.6;

    // spawnObject runs the Bullet script — all collision + lifetime logic works
    spawnObject("Bullet", bx, by, (b) => {
      b.velocityX = cos(rad) * BULLET_SPEED;
      b.velocityY = sin(rad) * BULLET_SPEED;
      b.setRotation(-angle);
    });

    hitFlash("#ffffff", 0.06);
    cooldown = FIRE_RATE;
  }
});

onStop(() => { cooldown = 0; });
`,
},

// ── 12. Bullet ───────────────────────────────────────────────
{
    name: 'Bullet',
    code: `// ============================================================
// BULLET SCRIPT
// Attach this to your Bullet sprite asset.
// Works with the Gun script and PlatformerPlayer.
//
// HOW TO USE:
//   Spawn via spawnObject("Bullet", x, y, (b) => { b.velocityX = 20; })
//   The spawner sets velocityX/Y before this script's onStart runs,
//   so the bullet travels in whatever direction you set.
//
// WHAT IT DOES:
//   - Auto-destroys after LIFETIME seconds
//   - Damages "enemy" tagged objects on collision
//   - Destroys on hitting walls (anything not a bullet or player)
// ============================================================

var LIFETIME = 2.0;   // seconds before auto-destroy
var DAMAGE   = 1;     // damage dealt to enemies

var life = 0;

onStart(() => {
  setTag("bullet");
  life = LIFETIME;
});

onUpdate((dt) => {
  life -= dt;
  if (life <= 0) destroy();
});

onCollisionEnter((other) => {
  if (!other) return;

  if (other.hasTag("enemy")) {
    other.takeDamage(DAMAGE);
    other.hitFlash("#ff4444", 0.15);
    destroy();
    return;
  }

  // Destroy on walls/terrain — ignore other bullets and the player
  if (!other.hasTag("bullet") && !other.hasTag("player")) {
    destroy();
  }
});
`,
},

// ── 13. Enemy ────────────────────────────────────────────────
{
    name: 'Enemy',
    code: `// ============================================================
// ENEMY SCRIPT
// Patrol + chase + health/death/score.
//
// Requires: Static or kinematic physics body.
//           Player tagged "player" in the scene.
// ============================================================

var MAX_HEALTH  = 3;
var MOVE_SPEED  = 2.5;
var CHASE_SPEED = 4;
var CHASE_RANGE = 8;     // start chasing within this range
var PATROL_DIST = 3;     // world units each direction before turning
var SCORE_VALUE = 10;

var startX  = 0;
var dir     = 1;
var chasing = false;

onStart(() => {
  setTag("enemy");
  startX = getX();
  setHealth(MAX_HEALTH);
  setMaxHealth(MAX_HEALTH);
  log("Enemy ready");
});

onUpdate((dt) => {
  var player = findWithTag("player");

  if (player && distanceTo(player) < CHASE_RANGE) {
    // Chase
    chasing = true;
    dir     = player.x > getX() ? 1 : -1;
    velocityX = dir * CHASE_SPEED;
  } else {
    // Patrol
    chasing   = false;
    velocityX = dir * MOVE_SPEED;
    if (getX() > startX + PATROL_DIST) dir = -1;
    if (getX() < startX - PATROL_DIST) dir =  1;
  }

  setScaleX(dir);
  playAnimation(chasing ? "run" : "walk");
});

onDamage((amount) => {
  hitFlash("#ff4444", 0.12);
  objectShake(0.15, 0.2);
});

onDeath(() => {
  sceneVar.score = (sceneVar.score || 0) + SCORE_VALUE;
  log("Enemy died. Score: " + sceneVar.score);

  // Decrement spawner count if EnemySpawner is in the scene
  sceneVar.enemyCount = max(0, (sceneVar.enemyCount || 1) - 1);

  destroy();
});

onCollisionEnter((other) => {
  // Reverse on hitting walls
  if (other && !other.hasTag("player") && !other.hasTag("enemy")) dirX = -dir;

  // Damage player on contact
  if (other && other.hasTag("player")) {
    other.takeDamage(1);
    var pushDir = other.x > this.x ? 1 : -1;
    other.velocityX = pushDir * 6;
    wait(0.2, () => { other.velocityX = 0; });
  }
});

onStop(() => {
  velocityX = 0;
  chasing   = false;
  dir       = 1;
});
`,
},


{
    name: 'Pathfinder',
    code: `
// ── Pathfinder ─────────────────────────────────────────────────
// Smart pathfinding script: walk to a world position or an object
// while navigating around obstacles.
//
// HOW TO USE
// ──────────
// 1. Attach this script to any object (no physics body needed).
// 2. Call any of these from another script or from this script:
//
//   walkTo(5, 3, { speed: 4, avoidStatic: true })
//     → Walk to world (5,3), avoiding physicsBody=static obstacles.
//
//   walkTo(5, 3, { speed: 4, avoidTag: "wall" })
//     → Avoid only objects tagged "wall".
//
//   walkTo(5, 3, { speed: 4, avoidGroup: "terrain", avoidTag: "rock" })
//     → Avoid multiple obstacle types.
//
//   walkTo(5, 3, { speed: 4, avoidAll: true, debug: true })
//     → Avoid ALL physics objects and visualise the path.
//
//   walkToObject("Player", { speed: 5, avoidStatic: true })
//     → Walk toward the "Player" object, recalculating path every 0.5s.
//
//   walkToObject("chest", { speed: 3, stopRadius: 1, onDone: () => log("at chest!") })
//     → Stop 1 unit away, fire callback on arrival.
//
//   walkToObject("Ally", { speed: 4, follow: true, repath: 0.3 })
//     → Keep following the Ally, recalculating every 0.3s.
//
//   stopWalking()  — cancel current path immediately.
//   isWalking      — true while a path is active.

var SPEED      = 4;      // world units / second
var TARGET_X   = 8;      // destination world X
var TARGET_Y   = 0;      // destination world Y
var AVOID_STATIC = true; // avoid physicsBody=static objects

onStart(() => {
  walkTo(TARGET_X, TARGET_Y, {
    speed:        SPEED,
    avoidStatic:  AVOID_STATIC,
    // avoidTag:  "wall",      // uncomment to also avoid tagged objects
    // avoidGroup:"terrain",   // or entire groups
    // avoidAll:  true,        // or every physics body
    debug:        false,       // set true to see the path drawn in blue
    onDone:  () => { log("Arrived at destination!"); },
    onFail:  () => { log("No path found — destination unreachable."); },
  });
});

// ── Example: re-trigger with a key ─────────────────────────────
onUpdate(() => {
  if (isKeyDown("r")) {
    walkTo(TARGET_X, TARGET_Y, {
      speed: SPEED,
      avoidStatic: AVOID_STATIC,
    });
  }
  if (isKeyDown("x")) {
    stopWalking();
    log("Stopped walking.");
  }
});
`,
},

{
    name: 'NavFollower',
    code: `
// ── NavFollower ────────────────────────────────────────────────
// Follows a named object (e.g. the player) using pathfinding.
// Obstacles are avoided automatically.
//
// Usage: Attach to any enemy / NPC / companion.
//   Rename TARGET to the label of the object you want to follow.

var TARGET      = "Player";  // label of the object to follow
var SPEED       = 4;         // units/sec
var STOP_RADIUS = 1.2;       // stop this close to target
var REPATH      = 0.4;       // recalculate path every N seconds

onStart(() => {
  walkToObject(TARGET, {
    speed:       SPEED,
    avoidStatic: true,
    stopRadius:  STOP_RADIUS,
    repath:      REPATH,
    follow:      true,        // keep walking even after initial arrival
    onFail: () => log("Can't reach " + TARGET),
  });
});

onStop(() => {
  stopWalking();
  velocityX = 0;
  velocityY = 0;
});
`,
},
];

// ── Inject built-in scripts into a project's script list ─────────────────────
// Called by engine.project.js when creating a new project or loading one with
// no scripts. Only adds a script if one with the same name doesn't already exist.
export function injectDefaultScripts(scripts) {
    for (const ds of DEFAULT_SCRIPTS) {
        const already = scripts.find(s => s.name === ds.name || s.id === 'default_' + ds.name);
        if (already) {
            // Always keep code in sync for built-in scripts the user hasn't edited
            // (detected by isDefault flag still being true on the record)
            if (already.isDefault) {
                already.code = ds.code;
            }
            continue;
        }
        scripts.push({
            id:        'default_' + ds.name,
            name:      ds.name,
            code:      ds.code,
            updatedAt: Date.now(),
            isDefault: true,
        });
    }
}
