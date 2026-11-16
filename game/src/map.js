// The Tidelock yard: a night shipyard, 72 x 56 m. Emberline spawns south
// and pushes north; Seawall holds the two sites. Site A is the drydock
// (west, under the gantry crane); site B is the slipway (east, under the
// hull on its cradle). Three lanes join them: A Long, the Causeway, B Long.
// Every solid is an AABB that is also its own collision box — what you see
// is exactly what stops bullets and bodies.
import * as THREE from "three";
import { PAL, mat, box, sign } from "./look.js";

// Layout entries: [cx, cz, w, d, h, materialKey]
// The yard is 72 x 56 m. Attackers (Emberline) spawn south, Seawall north.
const LAYOUT = [
  // perimeter
  [0, -28.5, 74, 1, 5, "wall"], [0, 28.5, 74, 1, 5, "wall"],
  [-36.5, 0, 1, 58, 5, "wall"], [36.5, 0, 1, 58, 5, "wall"],
  // site A (west): the drydock — basin walls, a hull on blocks, crate stacks.
  // The basin block sits north of the site centre so the plant spot itself
  // stays open ground, with the charge and the site ring in plain view.
  [-24, -15.5, 12, 4.5, 3.6, "dock"], [-24, -18.5, 18, 1, 3.2, "wallDark"],
  [-31, -3, 2.4, 2.4, 2.4, "crate"], [-28.6, -3, 2.4, 2.4, 1.2, "crateAlt"],
  [-17, -4, 2.4, 4.8, 1.2, "crateAlt"], [-13, -13, 1, 12, 3.4, "wall"],
  // site B (east): the slipway — hull cradle blocks + low cover
  [22, -13, 5, 5, 6.5, "hull"], [29, -7, 5, 5, 6.5, "hull"], [22, -1, 5, 5, 6.5, "hull"],
  [15, -11, 2.4, 2.4, 1.2, "crate"], [27, -17, 4.8, 2.4, 2.4, "crate"],
  [13, -13, 1, 12, 3.4, "wall"],
  // mid: the causeway wall splits the yard; two door gaps are the connectors
  [0, -15, 1.2, 14, 3.6, "wallDark"], [0, 7, 1.2, 18, 3.6, "wallDark"],
  [-6, 1, 6, 2.4, 1.2, "crateAlt"], [6, -3, 2.4, 2.4, 2.4, "crate"],
  // south lane cover (attacker approach)
  [-15, 13, 4.8, 2.4, 2.4, "crate"], [11, 15, 2.4, 2.4, 1.2, "crateAlt"],
  [21, 9, 6, 1, 2.6, "wall"], [-23, 7, 1, 8, 2.6, "wall"],
  // north lane cover (defender side)
  [-11, -23, 2.4, 2.4, 1.2, "crateAlt"], [9, -23, 4.8, 2.4, 2.4, "crate"],
  [0, -25, 8, 1, 2.6, "wall"],
  // container row (east edge): coloured stacks with two lanes cut between
  [31, 12, 6, 2.6, 2.6, "contA"], [31, 18.5, 6, 2.6, 5.2, "contB"], [31, 25, 6, 2.6, 2.6, "contC"],
  [26.5, 21.5, 2.4, 2.4, 1.2, "crate"],
  // fuel farm (north-west): two round tanks behind a low bund wall
  [-29, -23, 4, 4, 3.2, "rust"], [-21, -23, 4, 4, 3.2, "rust"],
  // pump house (mid-west): a small brick block with a vent stack
  [-17, 6, 4, 3, 2.8, "brick"],
  // barrel blocks: tight little cover squares out in the lanes
  [-7, 11, 1, 1, 1.1, "metal"], [13, -19, 1, 1, 1.1, "metal"], [-19, 15, 1, 1, 1.1, "metal"],
];

export const SITES = {
  A: { x: -24, z: -10, r: 6.5, color: PAL.siteA, name: "SITE A" },
  B: { x: 24, z: -8, r: 6.5, color: PAL.siteB, name: "SITE B" },
};
export const SPAWNS = {
  a: [[-8, 23], [-4, 24.5], [0, 23], [4, 24.5], [8, 23]],
  b: [[-19, -23], [19, -23], [-24, -20], [24, -20], [0, -25]],
};

// Named zones — the radio net and the minimap speak in these names, the way
// real squads do. First match wins; sites are checked before their lanes.
export const ZONES = [
  { name: "DRYDOCK", x: -24, z: -10, r: 9 },
  { name: "SLIPWAY", x: 24, z: -8, r: 9 },
  { name: "GANTRY", x: -24, z: -20, r: 9 },
  { name: "FUEL FARM", x: -25, z: -23, r: 8 },
  { name: "SLIPWAY", x: 26, z: -7, r: 11 },
  { name: "A LONG", x: -26, z: 5, r: 10 },
  { name: "CONTAINER ROW", x: 30, z: 19, r: 10 },
  { name: "B LONG", x: 24, z: 6, r: 10 },
  { name: "CAUSEWAY", x: 0, z: -3, r: 9 },
  { name: "NORTH GATE", x: 0, z: -24, r: 8 },
  { name: "SOUTH QUAY", x: 0, z: 23, r: 10 },
  { name: "PUMP HOUSE", x: -17, z: 6, r: 6 },
];
export function zoneAt(x, z) {
  for (const zn of ZONES) if (Math.hypot(x - zn.x, z - zn.z) <= zn.r) return zn.name;
  return z < -14 ? "NORTH LANE" : z > 12 ? "SOUTH LANE" : "THE YARD";
}

// Waypoint graph for bot navigation: nodes on the lanes, edges walkable.
const NODES = [
  [-6, 21], [6, 21], [-17, 15], [15, 13], [-25, 1], [-7, 3], [7, 1], [23, 3],
  [-24, -10], [-15, -10], [0, -9], [15, -8], [24, -8], [-7, -19], [7, -19],
  [-23, -22], [23, -22], [0, -23], [-15, 5], [17, 7],
  [26, 15], [26, 22], [32, 15], [32, 22],
];
const EDGES = [
  [0, 2], [0, 5], [1, 3], [1, 6], [2, 4], [2, 18], [3, 7], [3, 19], [4, 8],
  [4, 5], [5, 6], [5, 9], [6, 7], [6, 10], [7, 12], [7, 11], [8, 9], [9, 10],
  [9, 13], [10, 11], [10, 14], [11, 12], [12, 16], [13, 14], [13, 15], [14, 17],
  [15, 8], [16, 12], [17, 14], [18, 5], [19, 6], [18, 2], [19, 3],
  [3, 20], [7, 20], [20, 21], [20, 22], [21, 23], [22, 23],
];

export function buildMap(scene) {
  scene.background = new THREE.Color(PAL.sky);
  scene.fog = new THREE.Fog(PAL.fog, PAL.fogNear, PAL.fogFar);
  scene.add(new THREE.HemisphereLight(0xaebfcf, 0x35302a, 1.5));
  const sun = new THREE.DirectionalLight(0xffd2a0, 1.9);
  sun.position.set(-28, 40, 20);
  scene.add(sun);
  const lampLight = new THREE.PointLight(PAL.lamp, 55, 24, 1.8);
  lampLight.position.set(-24, 3.2, -10);
  scene.add(lampLight);

  // dusk sky dome: a vertical gradient painted on a canvas, deep blue up
  // top, a sodium-orange glow at the horizon where the sun just went down.
  {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#101a28");
    grad.addColorStop(0.55, "#232f3d");
    grad.addColorStop(0.82, "#4a3a34");
    grad.addColorStop(1, "#8a4a26");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const skyTex = new THREE.CanvasTexture(c);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(160, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    scene.add(dome);
  }

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(74, 58),
    mat(0xb4bac2, { tex: "cobble" })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // darker aprons under the sites so the zones read from across the yard
  for (const s of [SITES.A, SITES.B]) {
    const apron = new THREE.Mesh(new THREE.CircleGeometry(s.r + 1.2, 28), mat(PAL.groundAlt));
    apron.rotation.x = -Math.PI / 2; apron.position.set(s.x, 0.02, s.z);
    scene.add(apron);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(s.r - 0.35, s.r, 40),
      new THREE.MeshBasicMaterial({ color: s.color, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.set(s.x, 0.04, s.z);
    scene.add(ring);
    // beacon pillar of light so a planted site is findable
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.5, 9, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
    );
    beam.position.set(s.x, 4.5, s.z);
    scene.add(beam);
  }

  const colliders = [];
  const mats = {
    wall: mat(0xd0c2aa, { tex: "brick" }), wallDark: mat(0x93876f, { tex: "brick" }),
    crate: mat(0xd9b98c, { tex: "plank" }), crateAlt: mat(0xb9c4cc, { tex: "steel" }),
    metal: mat(0xc3ccd4, { tex: "steel" }), dock: mat(0x9c8f7a, { tex: "concrete" }),
    hull: mat(0x3a6b76, { tex: "hull" }), rust: mat(0x8a5a34, { tex: "rust" }),
    brick: mat(0xa08a6a, { tex: "brick" }),
    contA: mat(0xc05a30, { tex: "steel" }), contB: mat(0x2e8f96, { tex: "steel" }), contC: mat(0xd9a92c, { tex: "steel" }),
  };
  for (const [cx, cz, w, d, h, key] of LAYOUT) {
    const m = box(w, h, d, mats[key]);
    m.position.set(cx, h / 2, cz);
    scene.add(m);
    colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, h });
  }
  // the drydock's ship: a hull block on cradles, glowing work lamps along it
  const hullBlock = box(9, 2.2, 3.4, mats.hull);
  hullBlock.position.set(-24, 4.7, -15.5);
  scene.add(hullBlock);
  const keel = box(9, 0.5, 0.8, mats.metal);
  keel.position.set(-24, 3.8, -15.5);
  scene.add(keel);
  for (const [x, z] of [[-27.5, -15.5], [-24, -15.5], [-20.5, -15.5]]) {
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      new THREE.MeshBasicMaterial({ color: PAL.lamp })
    );
    lamp.position.set(x, 3.7, z + 1.9);
    scene.add(lamp);
  }

  // --- signage: painted site letters on the ground, stencil signs on walls.
  for (const s of [SITES.A, SITES.B]) {
    const letter = sign(s.name.slice(-1), 7, 3.5, s === SITES.A ? "#ffb347" : "#2fd4c4", 120);
    letter.rotation.x = -Math.PI / 2;
    letter.position.set(s.x, 0.06, s.z + 3.4);
    scene.add(letter);
  }
  const signs = [
    ["SITE A", -24, 2.3, -13.1, 0, "#ffb347"], ["SITE B", 12.3, 2.3, -13, -Math.PI / 2, "#2fd4c4"],
    ["DRYDOCK", -24, 3.0, -7.4, 0, "#f5ede0"], ["SLIPWAY", 22, 4.0, 1.6, 0, "#f5ede0"],
    ["CAUSEWAY", 0.7, 2.1, 7, Math.PI / 2, "#f5ede0"], ["A LONG", -31.9, 1.9, 1, Math.PI / 2, "#f5ede0"],
    ["CONTAINERS", 27.9, 3.4, 18.5, -Math.PI / 2, "#f5ede0"], ["CRANE 1", 34.4, 9.6, 18.5, -Math.PI / 2, "#ffb347"],
  ];
  for (const [text, x, y, z, ry, color] of signs) {
    const p = sign(text, 4.6, 2.3, color, 64);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    scene.add(p);
  }

  // --- the gantry crane over site A: two legs, a beam, a jib, and a
  // container hanging from the hook. Pure theatre above the dock — it gives
  // the west lane a skyline of its own and a landmark every callout can use.
  const craneBeam = box(0.8, 0.9, 15.5, mats.metal);
  craneBeam.position.set(-24, 10.6, -14);
  scene.add(craneBeam);
  const legL = box(0.7, 10.6, 0.7, mats.metal);
  legL.position.set(-31.5, 5.3, -14);
  scene.add(legL);
  const legR = box(0.7, 10.6, 0.7, mats.metal);
  legR.position.set(-16.5, 5.3, -14);
  scene.add(legR);
  const hookLine = box(0.08, 3.0, 0.08, mat(0x333333));
  hookLine.position.set(-27, 8.6, -14);
  scene.add(hookLine);
  const hanging = box(5.4, 2.4, 2.2, mats.contA);
  hanging.position.set(-27, 5.9, -14);
  hanging.rotation.z = 0.02;
  scene.add(hanging);
  // gantry beam over the causeway door, high enough to duck nothing
  const gantry = box(7.2, 0.5, 0.7, mats.metal);
  gantry.position.set(0, 5.4, -4);
  scene.add(gantry);
  const gantrySign = sign("CAUSEWAY GANTRY", 3.8, 0.9, "#f5ede0", 48);
  gantrySign.position.set(0, 5.35, -3.6);
  scene.add(gantrySign);

  // --- dressing: barrel clusters on their collider blocks, oil stains,
  // and the world outside the walls — silhouettes and smokestacks so the
  // yard reads as one corner of a much bigger port.
  for (const [x, z] of [[-7, 11], [13, -19], [-19, 15]]) {
    for (const [ox, oz, c] of [[-0.24, -0.24, 0x7a4a21], [0.24, 0.2, 0x31556b], [0, 0.28, 0x5d6d35]]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 1.1, 10), mat(c, { tex: "steel" }));
      b.position.set(x + ox, 0.55, z + oz);
      scene.add(b);
    }
  }
  for (const [x, z, r] of [[-4, -13, 2.6], [17, 19, 3.2], [-28, 11, 2.2], [7, -25, 2.8], [28, -15, 2.4]]) {
    const stain = new THREE.Mesh(new THREE.CircleGeometry(r, 18), new THREE.MeshBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.35 }));
    stain.rotation.x = -Math.PI / 2; stain.position.set(x, 0.03, z);
    scene.add(stain);
  }
  const silhouette = mat(0x39434f, { tex: "concrete" });
  for (const [x, z, w, h] of [[-50, -19, 10, 13], [-38, -44, 14, 19], [2, -48, 18, 11], [30, -45, 12, 23], [52, -26, 10, 15], [54, 8, 12, 17], [48, 36, 16, 9], [-48, 30, 12, 14], [-54, -2, 10, 21]]) {
    const m = box(w, h, w, silhouette);
    m.position.set(x, h / 2, z);
    scene.add(m);
  }
  for (const [x, z, h] of [[-43, -15, 16], [-45, -3, 12]]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, h, 12), silhouette);
    stack.position.set(x, h / 2, z);
    scene.add(stack);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), mat(0xff7733, { emissive: PAL.emberGlow, ei: 1.2 }));
    tip.position.set(x, h + 0.4, z);
    scene.add(tip);
  }

  const nav = NODES.map(([x, z], i) => ({ i, x, z, next: [] }));
  for (const [a, b] of EDGES) { nav[a].next.push(b); nav[b].next.push(a); }
  return { colliders, nav };
}

// Circle (x,z,r) vs AABB colliders: push out along the smallest penetration.
export function collide(colliders, pos, r) {
  for (const c of colliders) {
    const nx = Math.max(c.minX, Math.min(pos.x, c.maxX));
    const nz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2), push = (r - d) / d;
      pos.x += dx * push; pos.z += dz * push;
    } else {
      // centre inside the box: push out the shallowest face
      const pl = pos.x - c.minX, pr = c.maxX - pos.x, pt = pos.z - c.minZ, pb = c.maxZ - pos.z;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) pos.x = c.minX - r; else if (m === pr) pos.x = c.maxX + r;
      else if (m === pt) pos.z = c.minZ - r; else pos.z = c.maxZ + r;
    }
  }
  pos.x = Math.max(-35.4, Math.min(35.4, pos.x));
  pos.z = Math.max(-27.4, Math.min(27.4, pos.z));
}

// Segment vs colliders for bullets: returns nearest hit distance or Infinity.
export function rayHit(colliders, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist;
  for (const c of colliders) {
    let t0 = 0, t1 = best;
    // X slab
    if (Math.abs(dx) < 1e-9) { if (ox < c.minX || ox > c.maxX) continue; }
    else {
      let ta = (c.minX - ox) / dx, tb = (c.maxX - ox) / dx;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    // Y slab (boxes sit on the ground, top at c.h)
    if (Math.abs(dy) < 1e-9) { if (oy < 0 || oy > c.h) continue; }
    else {
      let ta = (0 - oy) / dy, tb = (c.h - oy) / dy;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-9) { if (oz < c.minZ || oz > c.maxZ) continue; }
    else {
      let ta = (c.minZ - oz) / dz, tb = (c.maxZ - oz) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) continue;
    }
    if (t0 < best && t0 >= 0) best = t0;
  }
  // ground plane
  if (dy < -1e-9) { const t = -oy / dy; if (t >= 0 && t < best) best = t; }
  return best;
}

// Breadth-first path over the waypoint graph; returns node indices to walk.
export function findPath(nav, fromIdx, toIdx) {
  if (fromIdx === toIdx) return [toIdx];
  const prev = new Map([[fromIdx, -1]]);
  const queue = [fromIdx];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toIdx) break;
    for (const n of nav[cur].next) if (!prev.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  if (!prev.has(toIdx)) return [toIdx];
  const path = [];
  for (let c = toIdx; c !== -1; c = prev.get(c)) path.push(c);
  return path.reverse();
}
export function nearestNode(nav, x, z) {
  let best = 0, bd = Infinity;
  for (const n of nav) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n.i; } }
  return best;
}
