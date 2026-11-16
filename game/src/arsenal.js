// The arsenal. Accuracy beats speed: spread grows with movement and
// sustained fire, shrinks when crouched or walking; the first rounds of a
// burst are near-pinpoint, so bursting is a skill, not a dice roll.
// Headshots pay, running and gunning does not.
import * as THREE from "three";
import { PAL, mat } from "./look.js";
import { rayHit } from "./map.js";

export const WEAPONS = {
  knife:   { name: "RIGGER KNIFE", price: 0,    slot: 3, dmg: 55, head: 2.0, rpm: 0,   mag: 0,   reserve: 0,   reload: 0,   spread: 0,      kick: 0,    range: 2.2, auto: false, heavy: false },
  pistol:  { name: "P9 SIDEARM",   price: 300,  slot: 2, dmg: 26, head: 2.4, rpm: 380, mag: 12,  reserve: 48,  reload: 1.1, spread: 0.006,  kick: 0.55, range: 90,  auto: false, heavy: false },
  judge:   { name: "JUDGE",        price: 700,  slot: 2, dmg: 44, head: 2.8, rpm: 150, mag: 6,   reserve: 24,  reload: 2.2, spread: 0.003,  kick: 1.5,  range: 100, auto: false, heavy: true },
  breacher:{ name: "BREACHER",     price: 1100, slot: 1, dmg: 9,  head: 1.4, rpm: 75,  mag: 6,   reserve: 24,  reload: 2.6, spread: 0.052,  kick: 2.2,  range: 34,  auto: false, heavy: true, pellets: 8 },
  swarm:   { name: "SWARM SMG",    price: 1200, slot: 1, dmg: 19, head: 2.2, rpm: 780, mag: 30,  reserve: 90,  reload: 1.7, spread: 0.013,  kick: 0.4,  range: 80,  auto: true,  heavy: false },
  anvil:   { name: "ANVIL LMG",    price: 3300, slot: 1, dmg: 23, head: 2.0, rpm: 700, mag: 100, reserve: 100, reload: 4.2, spread: 0.021,  kick: 0.5,  range: 110, auto: true,  heavy: true },
  longarm: { name: "LONGARM",      price: 2700, slot: 1, dmg: 34, head: 2.6, rpm: 620, mag: 25,  reserve: 75,  reload: 2.0, spread: 0.008,  kick: 0.85, range: 120, auto: true,  heavy: false },
  farshot: { name: "FARSHOT DMR",  price: 4300, slot: 1, dmg: 96, head: 1.6, rpm: 55,  mag: 5,   reserve: 20,  reload: 2.8, spread: 0.0015, kick: 2.6,  range: 200, auto: false, heavy: true, scoped: true },
  frag:    { name: "FRAG",         price: 300,  slot: 3, dmg: 78, head: 1.0, rpm: 0,   mag: 1,   reserve: 0,   reload: 0,   spread: 0,      kick: 0,    range: 0,   auto: false, heavy: false, blast: 5.2 },
  smoke:   { name: "SMOKE",        price: 250,  slot: 3, dmg: 0,  head: 1.0, rpm: 0,   mag: 1,   reserve: 0,   reload: 0,   spread: 0,      kick: 0,    range: 0,   auto: false, heavy: false },
  flash:   { name: "FLASH",        price: 200,  slot: 3, dmg: 0,  head: 1.0, rpm: 0,   mag: 1,   reserve: 0,   reload: 0,   spread: 0,      kick: 0,    range: 0,   auto: false, heavy: false },
  incendiary: { name: "INCENDIARY", price: 350, slot: 3, dmg: 0, head: 1.0, rpm: 0,   mag: 1,   reserve: 0,   reload: 0,   spread: 0,      kick: 0,    range: 0,   auto: false, heavy: false },
};
export const ARMOR_PRICE = 650;
export const KIT_PRICE = 400;
export const BUY_LIST = [
  { key: "1", id: "pistol", label: "P9 Sidearm", cat: "SIDEARMS", desc: "Reliable. 2.4× headshots, always in the holster." },
  { key: "2", id: "judge", label: "Judge", cat: "SIDEARMS", desc: "44 a shot, 2.8× to the head. Six chances, make them count." },
  { key: "3", id: "breacher", label: "Breacher", cat: "PRIMARIES", desc: "8 pellets. Ends arguments up close." },
  { key: "4", id: "swarm", label: "Swarm SMG", cat: "PRIMARIES", desc: "Fast, loose, loud. Run-and-gun money." },
  { key: "5", id: "anvil", label: "Anvil LMG", cat: "PRIMARIES", desc: "100 rounds of area denial. Reload somewhere safe." },
  { key: "6", id: "longarm", label: "Longarm", cat: "PRIMARIES", desc: "The default answer at any range." },
  { key: "7", id: "farshot", label: "Farshot DMR", cat: "PRIMARIES", desc: "Scoped — right-click to aim. One breath, one round." },
  { key: "8", id: "armor", label: "Vest + helmet", cat: "GEAR", desc: "Soaks 45% of every hit." },
  { key: "k", id: "kit", label: "Cutting kit", cat: "GEAR", desc: "Defuse in 3s instead of 5. Second-half gold." },
  { key: "9", id: "frag", label: "Frag grenade", cat: "GRENADES", desc: "78 blast damage. Clears corners and planters." },
  { key: "0", id: "smoke", label: "Smoke grenade", cat: "GRENADES", desc: "Cuts a sight line for 15 seconds." },
  { key: "f", id: "flash", label: "Flash grenade", cat: "GRENADES", desc: "Blinds whoever is looking. Throw, then swing." },
  { key: "c", id: "incendiary", label: "Incendiary", cat: "GRENADES", desc: "A wall of fire for 7 seconds. Nobody holds that ground." },
];

export class Gun {
  constructor(def) {
    this.def = def; this.mag = def.mag; this.reserve = def.reserve;
    this.cool = 0; this.reloading = 0; this.bloom = 0;
  }
  get empty() { return this.mag <= 0; }
}

// One shared tracer pool: thin stretched boxes that fade in ~70 ms.
// No allocations in the hot loop — the pool is built once at boot.
export class Tracers {
  constructor(scene) {
    this.pool = [];
    const geo = new THREE.BoxGeometry(0.02, 0.02, 1);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: PAL.tracer, transparent: true, opacity: 0 }));
      m.visible = false; scene.add(m); this.pool.push({ m, life: 0 });
    }
    this.i = 0;
  }
  fire(from, to) {
    const t = this.pool[this.i++ % this.pool.length];
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length(); if (len < 0.1) return;
    t.m.position.copy(from).addScaledVector(dir, 0.5);
    t.m.scale.set(1, 1, len);
    t.m.lookAt(to); t.m.visible = true; t.life = 0.07;
    t.m.material.opacity = 0.85;
  }
  update(dt) {
    for (const t of this.pool) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.m.material.opacity = Math.max(0, t.life / 0.07) * 0.85;
      if (t.life <= 0) t.m.visible = false;
    }
  }
}

const _dir = new THREE.Vector3(), _end = new THREE.Vector3();
// Resolve one hitscan shot. targets: fighters with hitTest(org,dir,maxD)
// returning {fighter, dist, head} or null. Returns the impact point + victim.
export function fireHitscan(colliders, tracers, shooter, origin, dir, spread, targets) {
  _dir.copy(dir);
  _dir.x += (Math.random() - 0.5) * 2 * spread;
  _dir.y += (Math.random() - 0.5) * 2 * spread;
  _dir.z += (Math.random() - 0.5) * 2 * spread;
  _dir.normalize();
  const wallD = rayHit(colliders, origin.x, origin.y, origin.z, _dir.x, _dir.y, _dir.z, 260);
  let best = null;
  for (const t of targets) {
    if (!t.alive || t === shooter) continue;
    const hit = t.hitTest(origin, _dir, Math.min(wallD, 260));
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  const dist = best ? best.dist : wallD;
  _end.copy(origin).addScaledVector(_dir, dist);
  tracers.fire(origin, _end);
  return { point: _end.clone(), victim: best ? best.fighter : null, head: best ? best.head : false, dist };
}

export function viewModel(kind, teamColor) {
  // A low-poly gun built from boxes, parented to the camera.
  const g = new THREE.Group();
  const body = mat(0x23252b), accent = mat(teamColor), grip = mat(0x17181c);
  const add = (w, h, d, x, y, z, m = body) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); g.add(b); return b;
  };
  if (kind === "pistol") {
    add(0.07, 0.11, 0.3, 0, 0, -0.1); add(0.06, 0.16, 0.09, 0, -0.1, 0.02, grip);
    add(0.02, 0.03, 0.02, 0, 0.07, -0.22, accent);
  } else if (kind === "judge") {
    add(0.08, 0.1, 0.42, 0, 0.01, -0.16); // long barrel
    add(0.11, 0.11, 0.13, 0, 0, 0.02, grip); // cylinder block
    add(0.06, 0.17, 0.09, 0, -0.11, 0.06, grip);
    add(0.02, 0.03, 0.02, 0, 0.08, -0.34, accent);
  } else if (kind === "knife") {
    add(0.03, 0.05, 0.14, 0, -0.02, 0.02, grip);
    add(0.012, 0.045, 0.3, 0, 0.01, -0.2, mat(0xb9c2cc));
  } else if (kind === "frag") {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mat(0x44502e));
    s.position.set(0, -0.02, -0.08); g.add(s);
    add(0.03, 0.05, 0.03, 0, 0.05, -0.08, mat(0x777777));
  } else { // long guns share a silhouette, sized per kind
    const L = kind === "farshot" ? 0.86 : kind === "swarm" ? 0.52 : kind === "breacher" ? 0.5 : kind === "anvil" ? 0.78 : 0.68;
    add(0.075, 0.13, L, 0, 0, -L / 2 + 0.08);
    add(0.05, 0.05, L * 0.5, 0, 0.015, -L - 0.02, grip);
    add(0.055, 0.2, 0.09, 0, -0.14, -0.08, grip);
    add(0.06, 0.11, 0.07, 0, 0.12, -0.18, body);
    add(0.02, 0.035, 0.02, 0, 0.1, -L + 0.06, accent);
    if (kind === "farshot") add(0.045, 0.07, 0.2, 0, 0.13, -0.34, grip);
    if (kind === "anvil") { // the belt box is the whole personality
      add(0.13, 0.16, 0.2, 0, -0.1, -0.3, grip);
      add(0.04, 0.3, 0.04, -0.09, -0.2, -0.62, body); // folded bipod legs
      add(0.04, 0.3, 0.04, 0.09, -0.2, -0.62, body);
    }
  }
  g.position.set(0.28, -0.26, -0.5);
  return g;
}
