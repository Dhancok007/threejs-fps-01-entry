// TIDELOCK look: a night shipyard at last light. Cold steel-blue dusk
// against warm sodium lamps and amber team colour; the defenders read teal.
// Every surface texture is painted once on a small canvas and tiled, so the
// yard looks built instead of flat-shaded — no image files anywhere.
import * as THREE from "three";

export const PAL = {
  sky: 0x232f3d, fog: 0x232f3d, fogNear: 55, fogFar: 135,
  ground: 0x3a3f45, groundAlt: 0x32373d,
  wall: 0x8d7c66, wallDark: 0x6a5f4e, trim: 0x4c4234,
  crate: 0x9a6b3e, crateAlt: 0x7c8894, metal: 0x6f7a84,
  rust: 0x7a4a28, hull: 0x2e5f6b, emberGlow: 0xff7a1e,
  siteA: 0xffb347, siteB: 0x2fd4c4,
  teamA: 0xff8a2a, teamADark: 0xb34d12, teamB: 0x2fd4c4, teamBDark: 0x177a72,
  tracer: 0xffd9a0, lamp: 0xffc46b,
};

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + "|" + (opts.tex ?? "") + "|" + (opts.emissive ?? 0);
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshLambertMaterial({ color });
  if (opts.tex) m.map = tex(opts.tex);
  if (opts.emissive) {
    m.emissive = new THREE.Color(opts.emissive);
    m.emissiveIntensity = opts.ei ?? 1;
  }
  matCache.set(key, m);
  return m;
}

export function box(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

// --- seeded painter -------------------------------------------------------
// One tiny deterministic PRNG per texture kind, so every load paints the
// same yard. The seed is a hash of the kind name — no shared global state.
function painter(seedWord) {
  let s = 0;
  for (let i = 0; i < seedWord.length; i++) s = ((s * 31 + seedWord.charCodeAt(i)) >>> 0);
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTex(paint, repeat = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  paint(c.getContext("2d"), 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const texCache = new Map();
export function tex(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const R = painter("tidelock:" + kind);
  let t;
  if (kind === "brick") {
    t = canvasTex((g, S) => {
      g.fillStyle = "#5f5142"; g.fillRect(0, 0, S, S);
      const bh = 14, bw = 30;
      for (let y = 0; y < S / bh; y++) {
        for (let x = -1; x < S / bw + 1; x++) {
          const off = y % 2 ? bw / 2 : 0;
          const v = 0.8 + R() * 0.4;
          g.fillStyle = `rgb(${Math.round(150 * v)},${Math.round(118 * v)},${Math.round(86 * v)})`;
          g.fillRect(x * bw + off + 1, y * bh + 1, bw - 2, bh - 2);
        }
      }
      g.fillStyle = "rgba(20,16,12,0.3)";
      for (let i = 0; i < 220; i++) g.fillRect(R() * S, R() * S, 2, 2);
    });
  } else if (kind === "cobble") {
    t = canvasTex((g, S) => {
      g.fillStyle = "#33363c"; g.fillRect(0, 0, S, S);
      const cell = S / 4;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const v = 0.85 + R() * 0.3;
        g.fillStyle = `rgb(${Math.round(88 * v)},${Math.round(94 * v)},${Math.round(104 * v)})`;
        g.beginPath();
        g.roundRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4, 8);
        g.fill();
        g.fillStyle = "rgba(255,200,120,0.06)";
        g.fillRect(x * cell + 5, y * cell + 4, cell - 10, 2);
      }
    }, 14);
  } else if (kind === "plank") {
    t = canvasTex((g, S) => {
      g.fillStyle = "#6b4423"; g.fillRect(0, 0, S, S);
      for (let p = 0; p < 5; p++) {
        const v = 0.82 + R() * 0.36;
        g.fillStyle = `rgb(${Math.round(148 * v)},${Math.round(100 * v)},${Math.round(56 * v)})`;
        g.fillRect(0, p * 26 + 1, S, 24);
        g.strokeStyle = "rgba(46,28,12,0.55)"; g.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
          g.beginPath();
          const y = p * 26 + 4 + R() * 18;
          g.moveTo(0, y); g.bezierCurveTo(36, y + 4, 84, y - 4, S, y + 2); g.stroke();
        }
        g.fillStyle = "rgba(30,20,10,0.9)";
        g.beginPath(); g.arc(7, p * 26 + 13, 2, 0, 7); g.fill();
        g.beginPath(); g.arc(S - 7, p * 26 + 13, 2, 0, 7); g.fill();
      }
    });
  } else if (kind === "concrete") {
    t = canvasTex((g, S) => {
      g.fillStyle = "#575046"; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 1100; i++) {
        const v = 0.7 + R() * 0.6;
        g.fillStyle = `rgba(${Math.round(104 * v)},${Math.round(96 * v)},${Math.round(82 * v)},0.5)`;
        g.fillRect(R() * S, R() * S, 2, 2);
      }
      g.strokeStyle = "rgba(24,20,16,0.5)"; g.lineWidth = 2;
      g.strokeRect(1, 1, S - 2, S - 2);
      g.fillStyle = "rgba(16,14,10,0.3)";
      for (let i = 0; i < 6; i++) g.fillRect(R() * S, R() * S, 18 + R() * 30, 3);
    });
  } else if (kind === "rust") {
    // streaked rusted plate: vertical runs of orange-brown over dark steel
    t = canvasTex((g, S) => {
      g.fillStyle = "#4c4640"; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 60; i++) {
        const x = R() * S, w = 2 + R() * 7, len = 20 + R() * 90;
        const v = 0.7 + R() * 0.6;
        g.fillStyle = `rgba(${Math.round(122 * v)},${Math.round(74 * v)},${Math.round(40 * v)},${0.25 + R() * 0.45})`;
        g.fillRect(x, R() * 20, w, len);
      }
      g.fillStyle = "rgba(20,18,16,0.5)";
      for (let i = 0; i < 140; i++) g.fillRect(R() * S, R() * S, 2, 2);
    });
  } else if (kind === "hull") {
    // painted ship steel: broad teal-grey panels with rivet seams
    t = canvasTex((g, S) => {
      g.fillStyle = "#33565e"; g.fillRect(0, 0, S, S);
      for (let y = 0; y < 4; y++) {
        const v = 0.88 + R() * 0.24;
        g.fillStyle = `rgb(${Math.round(58 * v)},${Math.round(98 * v)},${Math.round(106 * v)})`;
        g.fillRect(0, y * 32 + 2, S, 28);
        g.fillStyle = "rgba(10,16,18,0.65)";
        g.fillRect(0, y * 32, S, 2);
      }
      g.fillStyle = "rgba(10,16,18,0.8)";
      for (let x = 8; x < S; x += 16) for (let y = 16; y < S; y += 32) {
        g.beginPath(); g.arc(x, y, 1.8, 0, 7); g.fill();
      }
      g.fillStyle = "rgba(255,170,80,0.08)";
      for (let i = 0; i < 30; i++) g.fillRect(R() * S, R() * S, 4, 2);
    });
  } else { // steel: brushed plate with rivets and a frame line
    t = canvasTex((g, S) => {
      g.fillStyle = "#666f78"; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 52; i++) {
        g.fillStyle = `rgba(26,30,34,${0.05 + R() * 0.13})`;
        g.fillRect(0, R() * S, S, 1.3);
      }
      g.fillStyle = "rgba(18,20,22,0.85)";
      for (const [x, y] of [[7, 7], [121, 7], [7, 121], [121, 121]]) {
        g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill();
      }
      g.strokeStyle = "rgba(20,22,24,0.6)"; g.lineWidth = 2;
      g.strokeRect(1, 1, S - 2, S - 2);
    });
  }
  texCache.set(kind, t);
  return t;
}

// A stencil sign: one word or letter, painted on a transparent plane so it
// can sit on a wall, a gantry beam, or flat on the ground.
export function signTexture(text, color = "#f5ede0", fontPx = 92) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 256, 128);
  g.font = `900 ${fontPx}px system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = color;
  g.globalAlpha = 0.92;
  g.fillText(text, 128, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function sign(text, w, h, color, fontPx) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: signTexture(text, color, fontPx), transparent: true, side: THREE.DoubleSide })
  );
}
