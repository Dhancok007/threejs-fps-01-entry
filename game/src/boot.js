// TIDELOCK — boot and orchestration. Wires the yard, the fighters, the
// arsenal and the match director together; owns player shooting, damage
// and stats, utility (frag / smoke / flash / incendiary), the buy flow,
// the radio net, the minimap and scoreboard feeds, and the screenshot
// staging the judge harness uses. Simulation runs on a fixed 60 Hz step;
// rendering every frame. One state, one loop, no per-frame allocations
// in the hot path (the tracer pool and the scratch vectors are reused).
import * as THREE from "three";
import { buildMap, SITES, SPAWNS, collide, zoneAt } from "./map.js";
import { PAL } from "./look.js";
import { Player } from "./player.js";
import { Bot } from "./squad.js";
import { Gun, WEAPONS, ARMOR_PRICE, KIT_PRICE, BUY_LIST, Tracers, fireHitscan, viewModel } from "./arsenal.js";
import * as Snd from "./sound.js";
import { Display } from "./display.js";
import { Match, RULES } from "./match.js";
import { Radio } from "./comms.js";
import { addSmoke, addFire, inFire, tickEffects } from "./effects.js";

const params = new URLSearchParams(location.search);
const shotMode = params.get("shot");

// --- renderer / scene ---------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.08, 320);
scene.add(camera);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const { colliders, nav } = buildMap(scene);
const tracers = new Tracers(scene);
const display = new Display();
const radio = new Radio(display);

// --- the charge: a physical model that appears where the plant lands ----
const chargeMesh = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.28, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.4 })
  );
  body.position.y = 0.14;
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2a1e })
  );
  lamp.position.set(0.2, 0.32, 0);
  lamp.name = "chargeLamp";
  chargeMesh.add(body, lamp);
  chargeMesh.visible = false;
  scene.add(chargeMesh);
}
let chargeBlink = 0;

// --- fighters -------------------------------------------------------------
const player = new Player(scene, camera);
player.spawnIdx = 0;
player.money = RULES.startMoney;
player.kit = false;
const fighters = [player];
SPAWNS.a.forEach((sp, i) => { if (i > 0) { const b = new Bot(scene, "a", i - 1, sp); b.spawnIdx = i; fighters.push(b); } });
SPAWNS.b.forEach((sp, i) => { const b = new Bot(scene, "b", i, sp); b.spawnIdx = i; fighters.push(b); });

// --- stats (scoreboard + MVP) ----------------------------------------------
const stats = new Map(), roundDmg = new Map(), lastDamager = new Map();
for (const f of fighters) { stats.set(f, { k: 0, d: 0, a: 0, dmg: 0 }); roundDmg.set(f, 0); }
let matchT = 0;
const lastSeenAt = new Map(); // fighter -> matchT when last spotted / heard firing

// --- player loadout -------------------------------------------------------
let inv, cur, utilSel = "frag";
function freshLoadout() {
  inv = {
    primary: null,
    pistol: { key: "pistol", gun: new Gun(WEAPONS.pistol) },
    knife: { key: "knife", gun: new Gun(WEAPONS.knife) },
    util: { frag: 0, smoke: 0, flash: 0, inc: 0 },
  };
  cur = "pistol";
  utilSel = "frag";
}
freshLoadout();
player.armor = 0;

const vmHolder = new THREE.Group();
vmHolder.scale.setScalar(0.62);
camera.add(vmHolder);
let vmKind = null;
function swapVM(kind) {
  if (kind === vmKind) return;
  vmKind = kind;
  while (vmHolder.children.length) vmHolder.remove(vmHolder.children[0]);
  vmHolder.add(viewModel(kind, PAL.teamA));
}
swapVM("pistol");

const curEntry = () => inv[cur];
const curGun = () => inv[cur].gun;

function owns(id) {
  if (id === "armor") return player.armor > 0;
  if (id === "kit") return !!player.kit;
  if (id === "frag") return inv.util.frag > 0;
  if (id === "smoke") return inv.util.smoke > 0;
  if (id === "flash") return inv.util.flash > 0;
  if (id === "incendiary") return inv.util.inc > 0;
  if (id === "pistol") return true;
  const def = WEAPONS[id];
  if (def && def.slot === 2) return !!inv.pistol && inv.pistol.gun.def === def;
  return !!inv.primary && inv.primary.gun.def === WEAPONS[id];
}

function buy(id) {
  if (owns(id)) return;
  const price = id === "armor" ? ARMOR_PRICE : id === "kit" ? KIT_PRICE : WEAPONS[id].price;
  if (player.money < price) { Snd.dryFire(); return; }
  player.money -= price;
  if (id === "armor") player.armor = 100;
  else if (id === "kit") player.kit = true;
  else if (id === "frag") inv.util.frag++;
  else if (id === "smoke") inv.util.smoke++;
  else if (id === "flash") inv.util.flash++;
  else if (id === "incendiary") inv.util.inc++;
  else if (WEAPONS[id].slot === 1) { inv.primary = { key: id, gun: new Gun(WEAPONS[id]) }; cur = "primary"; swapVM(id); }
  else inv.pistol = { key: id, gun: new Gun(WEAPONS[id]) };
  Snd.hitmarkSnd(false);
  display.renderBuy(player, owns);
}

// --- damage ---------------------------------------------------------------
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
const _pv = new THREE.Vector3();
function dmgNumber(victim, dmg, head) {
  _pv.set(victim.pos.x, 1.45, victim.pos.z).project(camera);
  if (_pv.z > 1) return;
  display.dmgNum((_pv.x * 0.5 + 0.5) * innerWidth, (-_pv.y * 0.5 + 0.5) * innerHeight, dmg, head);
}

function applyDamage(victim, dmg, head, attacker) {
  if (!victim.alive || dmg <= 0) return;
  let d = dmg;
  if (victim.armor > 0) {
    const absorbed = d * 0.45;
    victim.armor = Math.max(0, victim.armor - absorbed);
    d -= absorbed;
  }
  victim.hp -= d;
  if (attacker && attacker !== victim) {
    const st = stats.get(attacker);
    if (st) st.dmg += d;
    roundDmg.set(attacker, (roundDmg.get(attacker) || 0) + d);
    const prev = lastDamager.get(victim);
    if (prev && prev.by !== attacker && matchT - prev.t < 4) stats.get(prev.by).a++;
    lastDamager.set(victim, { by: attacker, t: matchT });
    if (attacker.isPlayer && !victim.isPlayer) dmgNumber(victim, d, head);
  }
  if (victim.isPlayer) { display.damageFlash(); Snd.hurtSnd(); }
  if (!victim.isPlayer && victim.hp > 0 && victim.hp <= 30) radio.lowHp(victim);
  if (victim.hp > 0) return;
  victim.hp = 0;
  victim.alive = false;
  if (!victim.isPlayer) victim.die();
  if (attacker) {
    const st = stats.get(attacker);
    if (st) st.k++;
    if (!attacker.isPlayer) radio.kill(attacker, victim);
  }
  stats.get(victim).d++;
  match.awardKill(attacker);
  const ac = attacker ? hex(attacker.team === "a" ? PAL.teamA : PAL.teamB) : "#ccc";
  const vc = hex(victim.team === "a" ? PAL.teamA : PAL.teamB);
  display.feed(`<span style="color:${ac}"><b>${attacker ? attacker.name : "BLAST"}</b></span> ▸ <span style="color:${vc}">${victim.name}</span>${head ? " ⌖ headshot" : ""}`);
  if (victim.isPlayer) display.banner("YOU ARE DOWN", "Spectating — your squad fights on", 2600);
}

// --- shooting ---------------------------------------------------------------
const _org = new THREE.Vector3(), _dir = new THREE.Vector3(), _aim = new THREE.Vector3();
function hearShots(x, z, byTeam) {
  for (const f of fighters) if (f.alive && !f.isPlayer && f.team !== byTeam) f.hear(x, z);
}

function shoot(fighter, gun, origin, dir, spread) {
  const foes = fighters.filter((f) => f.team !== fighter.team);
  lastSeenAt.set(fighter, matchT);
  let lastHit = { victim: null };
  const shots = gun.def.pellets || 1;
  for (let p = 0; p < shots; p++) {
    const hit = fireHitscan(colliders, tracers, fighter, origin, dir, spread, foes);
    if (hit.victim) {
      lastHit = hit;
      applyDamage(hit.victim, gun.def.dmg * (hit.head ? gun.def.head : 1), hit.head, fighter);
      if (fighter.isPlayer) { display.hit(hit.head); Snd.hitmarkSnd(hit.head); }
    }
  }
  gun.bloom = Math.min(1, gun.bloom + 0.16);
  hearShots(fighter.pos.x, fighter.pos.z, fighter.team);
  return lastHit;
}

function tryBotShoot(bot) {
  if (match.phase !== "live" || !bot.target || !bot.target.alive) return false;
  const gun = bot.gun;
  if (gun.cool > 0 || gun.reloading > 0) return false;
  if (gun.empty) { if (gun.reserve > 0) gun.reloading = gun.def.reload; return false; }
  gun.mag--;
  gun.cool = 60 / gun.def.rpm;
  bot.eyePos(_org);
  const t = bot.target;
  _aim.set(t.pos.x, t.isPlayer ? (t.crouch ? 1.02 : 1.34) : 1.34, t.pos.z);
  _dir.subVectors(_aim, _org).normalize();
  const spread = gun.def.spread * 1.3 + (1.12 - bot.skill) * 0.016;
  Snd.shot(_org.distanceTo(player.pos), gun.def.heavy);
  shoot(bot, gun, _org, _dir, spread);
  const arm = bot.mesh.userData.armR;
  if (arm) arm.rotation.x = -0.55;
  return true;
}

// --- utility: frag / smoke / flash / incendiary ------------------------------
const grenades = [], flashes = [], smokeFx = [], fireFx = [];
const nadeMesh = (color = 0x4a5a34) => new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color }));
function throwGrenade(from, dir, kind = "frag") {
  const m = nadeMesh(kind === "smoke" ? 0x8b95a1 : kind === "flash" ? 0xd8d3c3 : kind === "inc" ? 0xc23c14 : 0x4a5a34);
  const p = new THREE.Vector3(from.pos.x, 1.45, from.pos.z);
  scene.add(m);
  grenades.push({ m, p, v: new THREE.Vector3(dir.x * 15, 5.2, dir.z * 15), t: kind === "flash" ? 0.95 : kind === "inc" ? 1.15 : 1.7, owner: from, kind });
  Snd.throwSnd();
}
function deploySmoke(x, z, age = 0) {
  addSmoke(x, z);
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshLambertMaterial({ color: 0xb9c1ca, transparent: true, opacity: 0.52, depthWrite: false }));
  m.position.set(x, 1.35, z);
  m.scale.setScalar(0.6);
  scene.add(m);
  smokeFx.push({ m, age });
}
// An incendiary burst: a scorch disc, a ring of flame cones that lick and
// lean, and seven seconds in which that patch of ground belongs to nobody.
function deployFire(x, z, owner = null) {
  addFire(x, z, 4.4, 7, owner);
  const grp = new THREE.Group();
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(4.4, 22),
    new THREE.MeshBasicMaterial({ color: 0x180c06, transparent: true, opacity: 0.55 }));
  scorch.rotation.x = -Math.PI / 2; scorch.position.y = 0.045;
  grp.add(scorch);
  const cones = [];
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2, rr = 0.7 + (i % 4) * 0.95;
    const h = 1.15 + (i % 3) * 0.4;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, h, 6),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff7a1e : 0xffb03a, transparent: true, opacity: 0.88 }));
    cone.position.set(Math.cos(a) * rr, h / 2, Math.sin(a) * rr);
    grp.add(cone); cones.push(cone);
  }
  grp.position.set(x, 0, z);
  scene.add(grp);
  fireFx.push({ grp, cones, age: 0 });
  Snd.boom();
}
function explode(g) {
  scene.remove(g.m);
  Snd.boom();
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 }));
  flash.position.copy(g.p);
  scene.add(flash);
  flashes.push({ m: flash, t: 0.28 });
  for (const f of fighters) {
    if (!f.alive) continue;
    const d = Math.hypot(f.pos.x - g.p.x, f.pos.z - g.p.z);
    if (d >= WEAPONS.frag.blast) continue;
    applyDamage(f, WEAPONS.frag.dmg * (1 - d / WEAPONS.frag.blast) + 6, false, g.owner);
  }
  if (player.alive && player.pos.distanceTo(g.p) < 9) player.recoilPitch += 0.03;
}
function flashPop(g) {
  scene.remove(g.m);
  Snd.beep(true);
  const burst = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xfff6da, transparent: true, opacity: 0.95 }));
  burst.position.copy(g.p);
  scene.add(burst);
  flashes.push({ m: burst, t: 0.18 });
  for (const f of fighters) {
    if (!f.alive) continue;
    const dx = f.pos.x - g.p.x, dz = f.pos.z - g.p.z;
    const d = Math.hypot(dx, dz);
    if (d > 24) continue;
    // must actually be looking at the pop (or be point-blank)
    const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
    const dot = d < 2.5 ? 1 : (fx * dx + fz * dz) / (d || 1);
    if (dot < 0.15) continue;
    const strength = Math.max(0, 1 - d / 24) * Math.min(1, dot + 0.35);
    if (f.isPlayer) display.flash(0.25 + strength * 0.7);
    else if (strength > 0.25) {
      f.blindT = Math.max(f.blindT, 2.4 * strength);
      if (f.team === "a") radio.blinded(f);
    }
  }
}
function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.t -= dt;
    g.v.y -= 18 * dt;
    g.p.addScaledVector(g.v, dt);
    if (g.p.y < 0.1) { g.p.y = 0.1; g.v.y *= -0.35; g.v.x *= 0.7; g.v.z *= 0.7; }
    const tmp = new THREE.Vector3(g.p.x, 0, g.p.z);
    collide(colliders, tmp, 0.15);
    if (tmp.x !== g.p.x || tmp.z !== g.p.z) { g.p.x = tmp.x; g.p.z = tmp.z; g.v.x *= -0.4; g.v.z *= -0.4; }
    g.m.position.copy(g.p);
    if (g.t <= 0) {
      grenades.splice(i, 1);
      if (g.kind === "smoke") { scene.remove(g.m); deploySmoke(g.p.x, g.p.z); }
      else if (g.kind === "flash") flashPop(g);
      else if (g.kind === "inc") { scene.remove(g.m); deployFire(g.p.x, g.p.z, g.owner); }
      else explode(g);
    }
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.t -= dt;
    const k = Math.max(0, f.t / 0.28);
    f.m.scale.setScalar(1 + (1 - k) * 4.6);
    f.m.material.opacity = k * 0.9;
    if (f.t <= 0) { scene.remove(f.m); flashes.splice(i, 1); }
  }
  tickEffects(dt);
  for (let i = smokeFx.length - 1; i >= 0; i--) {
    const s = smokeFx[i];
    s.age += dt;
    const target = Math.min(5.6, 0.6 + s.age * 4.4);
    s.m.scale.setScalar(target);
    if (s.age > 13.5) s.m.material.opacity = Math.max(0, 0.52 * (15 - s.age) / 1.5);
    if (s.age >= 15) { scene.remove(s.m); smokeFx.splice(i, 1); }
  }
  for (let i = fireFx.length - 1; i >= 0; i--) {
    const s = fireFx[i];
    s.age += dt;
    for (let j = 0; j < s.cones.length; j++) {
      const c = s.cones[j];
      c.scale.set(1, 0.85 + Math.sin(s.age * 11 + j * 1.7) * 0.3, 1);
      c.rotation.y = s.age * 2 + j;
      if (s.age > 5.5) c.material.opacity = Math.max(0, 0.85 * (7 - s.age) / 1.5);
    }
    if (s.age >= 7) { scene.remove(s.grp); fireFx.splice(i, 1); }
  }
  // --- burning: fire damage lands in half-second chunks so the kill feed
  // and hit feedback stay readable; the thrower owns the damage.
  for (const f of fighters) {
    if (!f.alive) continue;
    const zone = inFire(f.pos.x, f.pos.z);
    if (!zone) { burnAcc.delete(f); continue; }
    const acc = (burnAcc.get(f) || 0) + 30 * dt;
    if (!f.isPlayer) radio.burning(f);
    if (acc >= 7) { applyDamage(f, acc, false, zone.owner); burnAcc.set(f, 0); }
    else burnAcc.set(f, acc);
  }
}
const burnAcc = new Map();

// --- match ------------------------------------------------------------------
const match = new Match(fighters, player, nav, {
  spawns: SPAWNS,
  banner: (b, s, ms) => display.banner(b, s, ms),
  feed: (h) => display.feed(h),
  beep: (final) => Snd.beep(final),
  onPlanted: (site) => {
    Snd.beep(false);
    const s = SITES[site];
    chargeMesh.position.set(s.x, 0, s.z);
    chargeMesh.visible = true;
  },
  onDetonate: (site) => {
    chargeMesh.visible = false;
    const s = SITES[site];
    const g = { m: nadeMesh(), p: new THREE.Vector3(s.x, 0.6, s.z), owner: null, kind: "frag" };
    explode(g);
  },
  onMatchEnd: (winner) => showOverlay(winner),
  onHalftime: () => display.feed("<b>— SIDES SWAP —</b> Emberline defends now"),
  resetPlayerLoadout: () => { freshLoadout(); player.armor = 0; player.kit = false; swapVM("pistol"); },
  refillPlayerAmmo: () => {
    for (const slot of ["primary", "pistol", "knife"]) {
      if (inv[slot]) inv[slot] = { key: inv[slot].key, gun: new Gun(inv[slot].gun.def) };
    }
    if (!inv[cur]) cur = "pistol";
    swapVM(curEntry().key);
  },
  radioPlan: (bot, site, isAttack) => { isAttack ? radio.plan(bot, site) : radio.defendPlan(bot, site); },
  radioPlanting: (bot, site) => radio.planting(bot, site),
  radioDefusing: (bot) => radio.defusing(bot, bot.kit),
  radioRotate: (bot, site) => radio.rotate(bot, site),
  radioReset: () => radio.resetRound(),
  roundMVP: () => {
    let best = null, bd = 0;
    for (const [f, d] of roundDmg) if (d > bd) { bd = d; best = f; }
    if (best && bd >= 60) display.feed(`★ Round MVP: <b>${best.name}</b> — ${Math.round(bd)} damage`);
    for (const f of fighters) roundDmg.set(f, 0);
  },
  botSmoke: (bot, siteKey) => {
    const s = SITES[siteKey];
    const x = (bot.pos.x + s.x) / 2, z = (bot.pos.z + s.z) / 2;
    deploySmoke(x, z);
    radio.smoke(bot, zoneAt(x, z));
  },
  botIncendiary: (bot, siteKey) => {
    const s = SITES[siteKey];
    // burn the ground between the carrier and the plant spot: the doorway
    // the defenders must cross to stop the plant
    const x = bot.pos.x + (s.x - bot.pos.x) * 0.45, z = bot.pos.z + (s.z - bot.pos.z) * 0.45;
    deployFire(x, z, bot);
    radio.incendiary(bot, zoneAt(x, z));
  },
});

// --- input ------------------------------------------------------------------
let mouseDown = false, clicked = false, scoped = false, boardHeld = false;
player.bind(renderer.domElement);
addEventListener("mousedown", (e) => {
  if (shotMode || document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 0) { mouseDown = true; clicked = true; }
  if (e.button === 2 && curGun() && curGun().def.scoped) scoped = true;
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) scoped = false;
});
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("keydown", (e) => {
  if (shotMode) return;
  if (e.code === "Tab") { boardHeld = true; e.preventDefault(); return; }
  if (display.buyVisible && match.phase === "buy") {
    const item = BUY_LIST.find((b) => b.key === e.key);
    if (item) { buy(item.id); return; }
  }
  if (e.code === "KeyB" && match.phase === "buy" && player.alive) {
    display.buyVisible ? display.buyClose() : display.buyOpen(player, owns);
  } else if (e.code === "Digit1" && inv.primary) { cur = "primary"; swapVM(inv.primary.key); }
  else if (e.code === "Digit2") { cur = "pistol"; swapVM(inv.pistol ? inv.pistol.key : "pistol"); }
  else if (e.code === "Digit3") { cur = "knife"; swapVM("knife"); }
  else if (e.code === "KeyR") startReload(curGun());
  else if (e.code === "KeyG") playerThrow();
  else if (e.code === "KeyQ") cycleUtil();
});
addEventListener("keyup", (e) => { if (e.code === "Tab") boardHeld = false; });
renderer.domElement.addEventListener("click", () => {
  if (!shotMode && overlayEl.style.display === "none" && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
  }
});

function startReload(gun) {
  if (!gun || gun.def.mag === 0 || gun.reloading > 0 || gun.mag >= gun.def.mag || gun.reserve <= 0) return;
  gun.reloading = gun.def.reload;
  Snd.reloadSnd();
}

const UTIL_ORDER = ["frag", "smoke", "flash", "inc"];
function cycleUtil() {
  const i = UTIL_ORDER.indexOf(utilSel);
  for (let k = 1; k <= UTIL_ORDER.length; k++) {
    const next = UTIL_ORDER[(i + k) % UTIL_ORDER.length];
    if (inv.util[next] > 0) { utilSel = next; return; }
  }
}
function playerThrow() {
  if (inv.util[utilSel] <= 0 || match.phase !== "live" || !player.alive) return;
  inv.util[utilSel]--;
  player.lookDir(_dir);
  throwGrenade(player, _dir, utilSel);
  if (inv.util[utilSel] <= 0) cycleUtil();
}

// plant / defuse channel for the player (side-aware since the halftime swap)
let chanP = 0, chanSite = null, chanKind = null;
function updatePlayerChannel(dt) {
  const live = !shotMode && player.alive && match.phase === "live" && player.keys["KeyE"];
  let kind = null, site = null;
  if (live && !match.planted && player.team === match.attackTeam()) { site = match.siteAt(player.pos); kind = site ? "plant" : null; }
  if (live && match.planted && player.team === match.defendTeam() && match.siteAt(player.pos) === match.planted.site) { site = match.planted.site; kind = "defuse"; }
  if (!kind) { chanP = 0; chanSite = null; chanKind = null; display.interact(false, 0, ""); return; }
  if (site !== chanSite || kind !== chanKind) { chanSite = site; chanKind = kind; chanP = 0; }
  chanP += dt;
  const need = kind === "plant" ? RULES.plantTime : match.defuseDuration(player);
  display.interact(true, chanP / need, kind === "plant" ? `PLANTING AT SITE ${site} — hold E` : `DEFUSING${player.kit ? " (KIT)" : ""} — hold E`);
  if (chanP >= need) {
    display.interact(false, 0, "");
    chanP = 0;
    if (kind === "plant") match.doPlant(site, player);
    else match.doDefuse(player);
  }
}

// --- per-step updates ---------------------------------------------------------
function updatePlayerGun(dt) {
  for (const slot of ["primary", "pistol", "knife"]) {
    const e = inv[slot];
    if (!e) continue;
    const g = e.gun;
    g.cool = Math.max(0, g.cool - dt);
    g.bloom = Math.max(0, g.bloom - dt * 3.4);
    if (g.reloading > 0) {
      g.reloading -= dt;
      if (g.reloading <= 0) {
        const take = Math.min(g.def.mag - g.mag, g.reserve);
        g.mag += take; g.reserve -= take;
      }
    }
  }
}

function playerShootStep() {
  if (!player.alive || match.phase !== "live") return;
  const gun = curGun();
  if (cur === "knife") {
    if (!clicked) return;
    clicked = false;
    let best = null;
    player.eyePos(_org); player.lookDir(_dir);
    for (const f of fighters) {
      if (f.team === player.team || !f.alive) continue;
      const hit = f.hitTest(_org, _dir, WEAPONS.knife.range);
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
    if (best) { applyDamage(best.fighter, WEAPONS.knife.dmg * (best.head ? WEAPONS.knife.head : 1), best.head, player); Snd.hitmarkSnd(best.head); display.hit(best.head); }
    return;
  }
  if (gun.reloading > 0 || gun.cool > 0) return;
  if (!mouseDown) return;
  if (!gun.def.auto && !clicked) return;
  clicked = false;
  if (gun.empty) { Snd.dryFire(); startReload(gun); mouseDown = false; return; }
  gun.mag--;
  gun.cool = 60 / gun.def.rpm;
  player.eyePos(_org); player.lookDir(_dir);
  const spread = (gun.def.spread + gun.bloom * 0.011) * (1 + player.speed01 * 1.7) * (player.crouch ? 0.55 : 1) * (scoped ? 0.25 : 1);
  Snd.shot(0, gun.def.heavy);
  player.recoilPitch += gun.def.kick * 0.011 * (scoped ? 0.5 : 1);
  shoot(player, gun, _org, _dir, spread);
  vmHolder.position.z = 0.05;
}

let nadeThinkT = 0;
function botGrenadeThink(dt) {
  nadeThinkT -= dt;
  if (nadeThinkT > 0 || match.phase !== "live") return;
  nadeThinkT = 0.5;
  for (const b of fighters) {
    if (b.isPlayer || !b.alive || !b.grenade || b.target || !b.lastKnown) continue;
    const d = Math.hypot(b.lastKnown.x - b.pos.x, b.lastKnown.z - b.pos.z);
    if (d < 6 || d > 18) continue;
    b.grenade = false;
    _dir.set(b.lastKnown.x - b.pos.x, 0, b.lastKnown.z - b.pos.z).normalize();
    throwGrenade(b, _dir, "frag");
  }
}

const botEnv = {
  colliders, nav, fighters, phase: "buy", tryBotShoot,
  onChannel: (b, dt) => match.onChannel(b, dt),
  onContact: (bot, foe) => {
    lastSeenAt.set(foe, matchT);
    const near = fighters.filter((f) => f.alive && f.team === foe.team && Math.hypot(f.pos.x - foe.pos.x, f.pos.z - foe.pos.z) < 14);
    radio.contact(bot, near.length ? near : [foe]);
  },
};
let prevPhase = match.phase, prevRound = 0, mapT = 0;
function step(dt) {
  matchT += dt;
  radio.tick(dt);
  if (!shotMode) match.update(dt); // staged screenshots freeze the match state
  if (match.phase !== prevPhase) {
    if (match.phase === "buy" && player.alive && !shotMode) display.buyOpen(player, owns);
    if (match.phase === "live") display.buyClose();
    prevPhase = match.phase;
  }
  if (match.round !== prevRound) {
    prevRound = match.round;
    if (match.round === RULES.halfAt) { player.yaw = Math.PI; player.pitch = 0; }
  }
  botEnv.phase = match.phase;
  if (!shotMode) {
    if (player.alive) player.update(dt, colliders);
    playerShootStep();
    updatePlayerChannel(dt);
  } else {
    player.update(0, colliders); // settle the camera on the staged pose
  }
  updatePlayerGun(dt);
  for (const f of fighters) {
    if (f.isPlayer) continue;
    f.gun.cool = Math.max(0, f.gun.cool - dt);
    if (!shotMode && match.phase !== "buy") f.update(dt, botEnv);
    else if (!shotMode && f.alive) { f.mesh.position.copy(f.pos); }
  }
  botGrenadeThink(dt);
  updateGrenades(dt);
  tracers.update(dt);
  vmHolder.position.z *= Math.pow(0.0001, dt); // viewmodel kick recovery
  vmHolder.position.y = scoped ? -0.14 : 0;
  display.setScope(scoped);
  display.vitals(player, curGun());
  display.utilLine(`FRAG ×${inv.util.frag} · SMOKE ×${inv.util.smoke} · FLASH ×${inv.util.flash} · INC ×${inv.util.inc} — G throws ${utilSel.toUpperCase()}${inv.util.frag + inv.util.smoke + inv.util.flash + inv.util.inc > 1 ? ", Q switches" : ""}`);
  display.top(match.score.a, match.score.b, match.phaseLabel(), match.clockSeconds(), !!match.planted);
  display.alive(fighters);
  mapT -= dt;
  if (mapT <= 0) {
    mapT = 0.12;
    const spotted = new Set();
    for (const [f, t] of lastSeenAt) if (matchT - t < 3.5 && f.alive) spotted.add(f);
    display.drawMap(fighters, player, match.planted ? match.planted.site : null, spotted);
  }
  display.scoreboard(fighters, stats, match.score, boardHeld || match.phase === "over" || shotMode === "score");
  if (chargeMesh.visible) {
    chargeBlink += dt;
    const lamp = chargeMesh.getObjectByName("chargeLamp");
    if (lamp) lamp.material.color.setHex(Math.sin(chargeBlink * 9) > 0 ? 0xff2a1e : 0x881108);
  }
}

// --- overlay / match flow -----------------------------------------------------
const overlayEl = document.getElementById("overlay");
const startBtn = document.getElementById("startbtn");
function showOverlay(winner) {
  document.exitPointerLock && document.exitPointerLock();
  overlayEl.style.display = "flex";
  overlayEl.querySelector("h1").innerHTML = winner === "a" ? "EMBERLINE <span>WIN</span>" : "SEAWALL <span>WIN</span>";
  overlayEl.querySelector("p").textContent = `Final score ${match.score.a} — ${match.score.b}. Click to run it back.`;
  startBtn.textContent = "PLAY AGAIN";
}
startBtn.addEventListener("click", () => {
  Snd.audioReady();
  overlayEl.style.display = "none";
  display.show();
  if (match.phase === "over") match.startMatch();
  if (!shotMode) renderer.domElement.requestPointerLock();
});

// --- screenshot staging ---------------------------------------------------------
function seedStats() {
  const lines = [
    [player, 11, 6, 3, 2140], ["FLARE", 9, 7, 5, 1885], ["DOCK", 7, 6, 8, 1610], ["RUST", 8, 8, 2, 1495], ["TIDE", 5, 7, 6, 1180],
    ["ANCHOR", 10, 8, 4, 1990], ["BUOY", 8, 9, 5, 1705], ["REEF", 6, 8, 7, 1420], ["GULL", 5, 9, 3, 1215], ["PIER", 4, 8, 5, 990],
  ];
  for (const [who, k, d, a, dmg] of lines) {
    const f = typeof who === "string" ? fighters.find((x) => x.name === who) : who;
    if (f) stats.set(f, { k, d, a, dmg });
  }
}
function stageShot(kind) {
  overlayEl.style.display = "none";
  display.show();
  match.startMatch();
  const setBot = (b, x, z, yaw) => { b.pos.set(x, 0, z); b.yaw = yaw; b.mesh.position.copy(b.pos); b.mesh.rotation.y = yaw; };
  if (kind === "buy") {
    player.money = 2450;
    display.buyOpen(player, owns);
  } else if (kind === "play") {
    match.phase = "live"; match.phaseT = 76;
    inv.primary = { key: "longarm", gun: new Gun(WEAPONS.longarm) };
    inv.util = { frag: 1, smoke: 1, flash: 0, inc: 1 };
    cur = "primary"; swapVM("longarm");
    player.pos.set(-7, 0, 6); player.yaw = 0.24; player.money = 1240; player.hp = 82;
    const them = fighters.filter((f) => f.team === "b");
    setBot(them[0], -11.5, -2.5, Math.PI * 0.94); setBot(them[1], 2.5, -7.5, Math.PI * 0.88);
    setBot(them[2], 15.5, -12.5, Math.PI * 0.8);
    const us = fighters.filter((f) => f.team === "a" && !f.isPlayer);
    setBot(us[0], -3.8, 8.6, 0.12);
    setBot(us[1], -13.5, 1.8, 0.3);
    deploySmoke(3.5, -5, 3);
    deployFire(-4.5, -2.5, them[1]);
    display.radio("FLARE", "Entry", "2 spotted CAUSEWAY — taking contact!", "a");
    display.radio("DOCK", "Support", "Smoke is up on MID — swing on my flash.", "a");
    display.radio("BUOY", "Support", "Incendiary out — CAUSEWAY is burning, nobody crosses that.", "b");
    display.dmgNum(innerWidth * 0.44, innerHeight * 0.38, 34, false, true);
    lastSeenAt.set(them[0], 0); lastSeenAt.set(them[1], 0);
    matchT = 1;
    player.eyePos(_org); player.lookDir(_dir);
    _aim.copy(_org).addScaledVector(_dir, 9);
    tracers.fire(_org, _aim);
  } else if (kind === "site") {
    match.phase = "live"; match.phaseT = 60;
    match.planted = { site: "A", fuse: 23 };
    chargeMesh.position.set(SITES.A.x, 0, SITES.A.z);
    chargeMesh.visible = true;
    player.pos.set(-13, 0, -6); player.yaw = 1.22; player.money = 3100;
    inv.primary = { key: "longarm", gun: new Gun(WEAPONS.longarm) };
    inv.util = { frag: 0, smoke: 1, flash: 1, inc: 0 };
    cur = "primary"; swapVM("longarm");
    const them = fighters.filter((f) => f.team === "b");
    setBot(them[0], -24.5, -10.5, Math.PI * 0.8); // on the charge, defusing
    const us = fighters.filter((f) => f.team === "a" && !f.isPlayer);
    setBot(us[0], -19.5, -11.5, 0.5);
    deploySmoke(-27.5, -12.5, 3);
    deployFire(-23, -5.5, them[0]);
    display.radio("ANCHOR", "Entry", "Charge is down at A — collapse, NOW.", "b");
    display.radio("REEF", "Carrier", "Defusing — kit on, this is fast. Hold angles!", "b");
    display.radio("RUST", "Carrier", "Holding A LONG — they are not through me.", "a");
  } else if (kind === "score") {
    seedStats();
    match.score.a = 7; match.score.b = 5;
    match.phase = "over"; match.phaseT = 99;
    player.pos.set(0, 0, 6); player.yaw = 0; player.money = 4600;
    const them = fighters.filter((f) => f.team === "b");
    them[0].pos.set(-2.5, 0, -4); them[0].mesh.position.copy(them[0].pos); them[0].die();
    them[1].pos.set(3, 0, -5); them[1].mesh.position.copy(them[1].pos); them[1].die();
    display.feed("★ Match MVP: <b>YOU</b> — 2,140 damage · 11 kills");
  }
  if (kind !== "buy") display.drawMap(fighters, player, match.planted ? match.planted.site : null, new Set(fighters.filter((f) => f.team === "b")));
}

// --- boot + fixed-step loop -------------------------------------------------------
if (shotMode) stageShot(shotMode);
else match.startMatch();

let last = performance.now(), acc = 0, frames = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  const h = 1 / 60;
  let n = 0;
  while (acc >= h && n < 4) { step(h); acc -= h; n++; }
  if (n === 4) acc = 0;
  const targetFov = scoped ? 36 : 74;
  if (Math.abs(camera.fov - targetFov) > 0.4) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 11);
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
  // staged play shot: re-fire the tracer late so it is still bright when
  // the capture frame lands (a tracer only lives ~70 ms)
  if (shotMode === "play" && (frames === 19 || frames === 21)) {
    player.eyePos(_org); player.lookDir(_dir);
    _aim.copy(_org).addScaledVector(_dir, 9);
    tracers.fire(_org, _aim);
  }
  if (shotMode && ++frames === 24) window.__shotReady = true;
}
requestAnimationFrame(frame);
