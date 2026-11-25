'use strict';
/* CamPlan: floor plans + camera placement. All geometry is in "world units"; 20 units = 1 ft. */
const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const PPF = 20, WT = 8, G = 10, D2R = Math.PI / 180;
const uid = () => Math.random().toString(36).slice(2, 9);
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599'];
const TH = {
  light: { bg: '#f4f5f7', grid: '#e3e6ea', grid2: '#cfd5dc', wall: '#1f2328', win: '#2b8fd6', txt: '#1f2328', hl: '#1f6feb' },
  dark: { bg: '#14171b', grid: '#1f2328', grid2: '#2c323a', wall: '#e6e8eb', win: '#6cb6ff', txt: '#e6e8eb', hl: '#58a6ff' }
};

let S = { walls: [], openings: [], cameras: [], labels: [], pdf: null };
let pdfImg = null, view = { x: 80, y: 80, z: 1 }, tool = 'select', sel = new Set(), multi = false;
let undo = [], redo = [], drag = null, hover = null, drawing = null, calib = null, spaceDown = false;
let pending = null, gest = null, W = 0, H = 0, dpr = 1, Z = 1, VER = '?', raf = 0, panelId = null, pBefore = null;
const ptrs = new Map();
const cfg = Object.assign({ dark: false, grid: true, snap: true, block: true }, JSON.parse(localStorage.getItem('camplan-cfg') || '{}'));

/* ---------- helpers ---------- */
const arrs = () => [S.walls, S.openings, S.cameras, S.labels];
const byId = id => { for (const a of arrs()) { const o = a.find(x => x.id === id); if (o) return o; } return null; };
const wl = w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
const norm360 = a => Math.round(((a % 360) + 360) % 360 * 10) / 10;
const norm180 = a => ((a % 360) + 540) % 360 - 180;
const hexA = (h, a) => `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${a})`;
const ser = () => JSON.stringify({ walls: S.walls, openings: S.openings, cameras: S.cameras, labels: S.labels });
function restore(j) { Object.assign(S, JSON.parse(j)); sel = new Set([...sel].filter(byId)); drawing = null; }
function pushUndo(b) { undo.push(b); if (undo.length > 100) undo.shift(); redo = []; }
function mutate(fn) { const b = ser(); fn(); if (ser() !== b) pushUndo(b); afterChange(); }
function afterChange() { updatePanel(); draw(); }
function doUndo() { if (!undo.length) return; redo.push(ser()); restore(undo.pop()); afterChange(); }
function doRedo() { if (!redo.length) return; undo.push(ser()); restore(redo.pop()); afterChange(); }
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }

function segInfo(p, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t, y = ay + dy * t; return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}
function segInt(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) <= 0 && o(c, d, a) * o(c, d, b) <= 0;
}
function opGeo(o) {
  const w = S.walls.find(w => w.id === o.wall); if (!w) return null;
  const L = wl(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  return { w, L, ux, uy, nx: -uy, ny: ux, cx: w.x1 + (w.x2 - w.x1) * o.t, cy: w.y1 + (w.y2 - w.y1) * o.t, hw: o.w / 2 };
}
function nearestWall(p, width, tol) {
  tol = tol || 26 / view.z; let best = null;
  for (const w of S.walls) {
    const L = wl(w); if (L < 1) continue;
    const r = segInfo(p, w.x1, w.y1, w.x2, w.y2);
    if (r.d < tol && (!best || r.d < best.d)) {
      const hw = Math.min(width / 2, L / 2) / L;
      best = { w, d: r.d, t: Math.max(hw, Math.min(1 - hw, r.t)) };
    }
  }
  return best;
}
function endpointsAt(x, y) {
  const r = [];
  for (const w of S.walls) for (const k of [1, 2]) if (Math.hypot(w['x' + k] - x, w['y' + k] - y) < 0.5) r.push({ w, k });
  return r;
}

/* ---------- snapping ---------- */
function snapPt(p, from, skip) {
  const tol = 14 / view.z, ws = S.walls.filter(w => !skip || !skip.has(w.id));
  let best = null, bd = tol;
  for (const w of ws) for (const k of [1, 2]) { const x = w['x' + k], y = w['y' + k], d = Math.hypot(x - p.x, y - p.y); if (d < bd) { bd = d; best = { x, y, k: 'end' }; } }
  if (best) return best;
  for (const w of ws) { const r = segInfo(p, w.x1, w.y1, w.x2, w.y2); if (r.d < bd && r.t > 0 && r.t < 1) { bd = r.d; best = { x: r.x, y: r.y, k: 'wall' }; } }
  if (best) return best;
  let q = { x: p.x, y: p.y, k: 'free' };
  const grid = () => { if (cfg.snap) { q.x = Math.round(q.x / G) * G; q.y = Math.round(q.y / G) * G; } };
  if (from) {
    let L = Math.hypot(q.x - from.x, q.y - from.y), a = Math.atan2(q.y - from.y, q.x - from.x);
    const step = Math.PI / 4, na = Math.round(a / step) * step;
    if (L > 0 && Math.abs(a - na) < 0.1) {            // lock to 0/45/90... degrees
      a = na; if (cfg.snap) L = Math.round(L / G) * G;
      q = { x: from.x + Math.cos(a) * L, y: from.y + Math.sin(a) * L, k: 'ortho' };
      const hor = Math.abs(Math.sin(a)) < .01, ver = Math.abs(Math.cos(a)) < .01;
      for (const w of ws) for (const k of [1, 2]) { const x = w['x' + k], y = w['y' + k]; if (hor && Math.abs(x - q.x) < tol) q.x = x; if (ver && Math.abs(y - q.y) < tol) q.y = y; }
    } else grid();
  } else grid();
  q.x = Math.round(q.x * 100) / 100; q.y = Math.round(q.y * 100) / 100;
  return q;
}

/* ---------- camera field of view (clipped by walls) ---------- */
function seeThrough(w, s) {
  const L = wl(w);
  return S.openings.some(o => o.wall === w.id && o.type !== 'door' && Math.abs(s - o.t) * L <= o.w / 2);
}
function fovPoly(c) {
  const R = c.range * PPF, pts = [{ x: c.x, y: c.y }], n = Math.max(12, Math.ceil(c.fov / 1.5));
  for (let i = 0; i <= n; i++) {
    const a = (c.rot - c.fov / 2 + c.fov * i / n) * D2R, dx = Math.cos(a), dy = Math.sin(a); let r = R;
    if (cfg.block) for (const w of S.walls) {
      const ex = w.x2 - w.x1, ey = w.y2 - w.y1, den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const ax = w.x1 - c.x, ay = w.y1 - c.y, rr = (ax * ey - ay * ex) / den, s = (ax * dy - ay * dx) / den;
      if (rr > 0.01 && rr < r && s >= 0 && s <= 1 && !seeThrough(w, s)) r = rr;
    }
    pts.push({ x: c.x + dx * r, y: c.y + dy * r });
  }
  return pts;
}

/* ---------- rendering ---------- */
function strip(g, ax, ay, bx, by, t, e0, e1) {
  const L = Math.hypot(bx - ax, by - ay); if (!L) return;
  const ux = (bx - ax) / L, uy = (by - ay) / L, h = t / 2, nx = -uy * h, ny = ux * h;
  const sx = e0 ? ux * h : 0, sy = e0 ? uy * h : 0, ex = e1 ? ux * h : 0, ey = e1 ? uy * h : 0;
  g.beginPath(); g.moveTo(ax - sx + nx, ay - sy + ny); g.lineTo(bx + ex + nx, by + ey + ny); g.lineTo(bx + ex - nx, by + ey - ny); g.lineTo(ax - sx - nx, ay - sy - ny); g.closePath();
}
function wallSegs(w) {
  const L = wl(w), gaps = S.openings.filter(o => o.wall === w.id).map(o => [o.t - o.w / 2 / L, o.t + o.w / 2 / L]).sort((a, b) => a[0] - b[0]);
  const segs = []; let c = 0; for (const [a, b] of gaps) { if (a > c) segs.push([c, a]); c = Math.max(c, b); } if (c < 1) segs.push([c, 1]); return segs;
}
const lblBox = l => { ctx.font = `${l.size}px -apple-system,Segoe UI,Roboto,sans-serif`; const w = ctx.measureText(l.text).width; return { x: l.x - w / 2, y: l.y - l.size / 2, w, h: l.size }; };
const SW = [[1, 0], [1, 1], [-1, 1], [-1, 0]];
function cycleSwing(o) { let i = SW.findIndex(s => s[0] === (o.side || 1) && s[1] === (o.hinge || 0)); i = (i + 1) % 4; o.side = SW[i][0]; o.hinge = SW[i][1]; }

function glow(g, th, on) { if (on) { g.shadowColor = th.hl; g.shadowBlur = 12; } else g.shadowBlur = 0; }

function drawOp(g, o, th, selected, alpha) {
  const q = opGeo(o); if (!q) return; const { ux, uy, nx, ny, cx, cy, hw } = q;
  const ax = cx - ux * hw, ay = cy - uy * hw, bx = cx + ux * hw, by = cy + uy * hw;
  g.save(); g.globalAlpha = alpha || 1;
  if (selected) { strip(g, ax, ay, bx, by, WT + 12, false, false); glow(g, th, true); g.fillStyle = hexA(th.hl, .35); g.fill(); g.shadowBlur = 0; g.strokeStyle = th.hl; g.lineWidth = 2 / Z; g.stroke(); }
  g.strokeStyle = th.wall; g.lineWidth = 1.5 / Z;
  for (const [x, y] of [[ax, ay], [bx, by]]) { g.beginPath(); g.moveTo(x - nx * WT / 2, y - ny * WT / 2); g.lineTo(x + nx * WT / 2, y + ny * WT / 2); g.stroke(); }
  if (o.type === 'window') {
    g.strokeStyle = th.win; g.lineWidth = 1.6 / Z;
    for (const k of [-.3, 0, .3]) { g.beginPath(); g.moveTo(ax + nx * WT * k, ay + ny * WT * k); g.lineTo(bx + nx * WT * k, by + ny * WT * k); g.stroke(); }
  } else if (o.type === 'door') {
    const side = o.side || 1, hg = o.hinge ? 1 : 0, cd = hg ? -1 : 1, hx = hg ? bx : ax, hy = hg ? by : ay;
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + nx * side * o.w, hy + ny * side * o.w); g.lineWidth = 2.2 / Z; g.strokeStyle = th.wall; g.stroke();
    g.beginPath(); g.arc(hx, hy, o.w, Math.atan2(uy * cd, ux * cd), Math.atan2(ny * side, nx * side), cd * side < 0);
    g.lineWidth = 1 / Z; g.setLineDash([4 / Z, 3 / Z]); g.stroke(); g.setLineDash([]);
  }
  g.restore();
}
function drawCam(g, c, th, ui, alpha) {
  const r = 10 / Z; g.save(); g.globalAlpha = alpha || 1;
  if (ui && sel.has(c.id)) { glow(g, th, true); g.beginPath(); g.arc(c.x, c.y, r + 7 / Z, 0, 7); g.strokeStyle = th.hl; g.lineWidth = 3 / Z; g.stroke(); g.shadowBlur = 0; }
  const a = c.rot * D2R;
  g.beginPath(); g.moveTo(c.x + Math.cos(a) * r * 2, c.y + Math.sin(a) * r * 2); g.lineTo(c.x + Math.cos(a + 2.5) * r * 1.1, c.y + Math.sin(a + 2.5) * r * 1.1); g.lineTo(c.x + Math.cos(a - 2.5) * r * 1.1, c.y + Math.sin(a - 2.5) * r * 1.1); g.closePath(); g.fillStyle = c.color; g.fill();
  g.beginPath(); g.arc(c.x, c.y, r, 0, 7); g.fillStyle = c.color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2 / Z; g.stroke();
  g.beginPath(); g.arc(c.x, c.y, r * .35, 0, 7); g.fillStyle = '#fff'; g.fill();
  if (c.label) text(g, c.label, c.x, c.y + r + 12 / Z, 12 / Z, th);
  g.restore();
}
function text(g, s, x, y, size, th) {
  g.font = `${size}px -apple-system,Segoe UI,Roboto,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = size / 4; g.strokeStyle = th.bg; g.lineJoin = 'round'; g.strokeText(s, x, y); g.fillStyle = th.txt; g.fillText(s, x, y);
}
function handleDot(g, h, th) {
  g.beginPath(); g.arc(h.x, h.y, 8 / Z, 0, 7); g.fillStyle = h.k === 'swing' ? '#f5b301' : '#fff'; g.fill(); g.lineWidth = 2.5 / Z; g.strokeStyle = h.k === 'swing' ? '#8a6500' : th.hl; g.stroke();
}
function drawGrid(g, v, th) {
  const z = v.z; let s = PPF; while (s * z < 12) s *= 5;
  const x0 = -v.x / z, y0 = -v.y / z, x1 = (W - v.x) / z, y1 = (H - v.y) / z; g.lineWidth = 1 / z;
  for (let x = Math.floor(x0 / s) * s; x < x1; x += s) { g.strokeStyle = Math.round(x / s) % 5 === 0 ? th.grid2 : th.grid; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); }
  for (let y = Math.floor(y0 / s) * s; y < y1; y += s) { g.strokeStyle = Math.round(y / s) % 5 === 0 ? th.grid2 : th.grid; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
}
function render(g, v, ui, th, opt) {
  opt = opt || {}; Z = v.z; g.save(); g.translate(v.x, v.y); g.scale(v.z, v.z);
  if (S.pdf && pdfImg && pdfImg.complete && !opt.noPdf) { g.globalAlpha = S.pdf.opacity; g.drawImage(pdfImg, S.pdf.x, S.pdf.y, pdfImg.width * S.pdf.s, pdfImg.height * S.pdf.s); g.globalAlpha = 1; }
  if (ui && cfg.grid) drawGrid(g, v, th);
  for (const c of S.cameras) {
    const pts = fovPoly(c); g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath();
    g.fillStyle = hexA(c.color, .22); g.fill(); g.strokeStyle = hexA(c.color, .85); g.lineWidth = 1.2 / Z; g.stroke();
  }
  for (const w of S.walls) if (ui && sel.has(w.id)) {
    strip(g, w.x1, w.y1, w.x2, w.y2, WT + 10, true, true); glow(g, th, true); g.fillStyle = hexA(th.hl, .4); g.fill(); g.shadowBlur = 0; g.strokeStyle = th.hl; g.lineWidth = 2 / Z; g.stroke();
  }
  g.fillStyle = th.wall;
  for (const w of S.walls) for (const [a, b] of wallSegs(w)) {
    strip(g, w.x1 + (w.x2 - w.x1) * a, w.y1 + (w.y2 - w.y1) * a, w.x1 + (w.x2 - w.x1) * b, w.y1 + (w.y2 - w.y1) * b, WT, a === 0, b === 1); g.fill();
  }
  for (const o of S.openings) drawOp(g, o, th, ui && sel.has(o.id));
  for (const c of S.cameras) drawCam(g, c, th, ui);
  for (const l of S.labels) {
    if (ui && sel.has(l.id)) { const b = lblBox(l); g.save(); glow(g, th, true); g.fillStyle = hexA(th.hl, .25); g.strokeStyle = th.hl; g.lineWidth = 2 / Z; g.beginPath(); g.rect(b.x - 5, b.y - 4, b.w + 10, b.h + 8); g.fill(); g.stroke(); g.restore(); }
    text(g, l.text, l.x, l.y, l.size, th);
  }
  if (ui) renderUI(g, th);
  g.restore();
}
function renderUI(g, th) {
  for (const h of handlesFor()) handleDot(g, h, th);
  if (hover && !drag) {
    if (['door', 'doorway', 'window'].includes(tool)) {
      const w = (tool === 'window' ? 4 : 3) * PPF, n = nearestWall(hover, w);
      if (n) drawOp(g, { id: 'g', type: tool, wall: n.w.id, t: n.t, w, side: 1, hinge: 0 }, th, false, .6);
    } else if (tool === 'camera') drawCam(g, { x: hover.x, y: hover.y, rot: 0, color: COLORS[S.cameras.length % 6], label: '' }, th, true, .5);
  }
  if (tool === 'wall' && hover) {
    const q = snapPt(hover, drawing ? drawing.start : null);
    if (drawing) {
      g.beginPath(); g.moveTo(drawing.start.x, drawing.start.y); g.lineTo(q.x, q.y); g.strokeStyle = th.hl; g.lineWidth = WT; g.globalAlpha = .55; g.stroke(); g.globalAlpha = 1;
      text(g, ((Math.hypot(q.x - drawing.start.x, q.y - drawing.start.y)) / PPF).toFixed(1) + ' ft', (q.x + drawing.start.x) / 2, (q.y + drawing.start.y) / 2 - 16 / Z, 13 / Z, th);
    }
    g.beginPath(); g.arc(q.x, q.y, (q.k === 'end' ? 8 : 5) / Z, 0, 7); g.strokeStyle = q.k === 'end' ? '#2f9e44' : th.hl; g.lineWidth = 2 / Z; g.stroke();
  }
  if (calib) {
    g.strokeStyle = '#d6336c'; g.lineWidth = 2 / Z;
    const b = calib.p2 || hover; g.beginPath(); g.arc(calib.p1.x, calib.p1.y, 5 / Z, 0, 7); g.stroke();
    if (b) { g.beginPath(); g.moveTo(calib.p1.x, calib.p1.y); g.lineTo(b.x, b.y); g.stroke(); }
  }
  if (drag && drag.type === 'marquee') {
    const a = drag.a, b = drag.b, win = b.x >= a.x, col = win ? th.hl : '#2f9e44';
    g.beginPath(); g.rect(a.x, a.y, b.x - a.x, b.y - a.y); g.fillStyle = hexA(col, .12); g.fill(); g.strokeStyle = col; g.lineWidth = 1.5 / Z; g.setLineDash(win ? [] : [6 / Z, 4 / Z]); g.stroke(); g.setLineDash([]);
  }
}
function draw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }
function paint() {
  const th = TH[cfg.dark ? 'dark' : 'light'];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  render(ctx, view, true, th);
}

/* ---------- selection handles + hit testing ---------- */
function handlesFor() {
  if (tool !== 'select' || sel.size !== 1) return []; const o = byId([...sel][0]); if (!o) return []; const hs = [];
  if (o.fov !== undefined) {
    const R = o.range * PPF, a = o.rot * D2R, f = o.fov / 2 * D2R, at = (k, an) => ({ k, o, x: o.x + Math.cos(an) * R, y: o.y + Math.sin(an) * R });
    hs.push(at('cr', a), at('cf1', a - f), at('cf2', a + f));
  } else if (o.x1 !== undefined) hs.push({ k: 'w1', o, x: o.x1, y: o.y1 }, { k: 'w2', o, x: o.x2, y: o.y2 });
  else if (o.type === 'door') {
    const q = opGeo(o); if (q) { const side = o.side || 1, hg = o.hinge ? 1 : 0, hx = q.cx + (hg ? 1 : -1) * q.ux * q.hw, hy = q.cy + (hg ? 1 : -1) * q.uy * q.hw; hs.push({ k: 'swing', o, x: hx + q.nx * side * o.w, y: hy + q.ny * side * o.w }); }
  }
  return hs;
}
function hitHandle(p, pt) { const r = (pt === 'mouse' ? 12 : 22) / view.z; return handlesFor().find(h => Math.hypot(h.x - p.x, h.y - p.y) < r) || null; }
function hitObj(p, pt) {
  const tol = (pt === 'mouse' ? 8 : 16) / view.z;
  for (const c of S.cameras) if (Math.hypot(c.x - p.x, c.y - p.y) < Math.max(14 / view.z, tol)) return c;
  for (const o of S.openings) { const q = opGeo(o); if (q && segInfo(p, q.cx - q.ux * q.hw, q.cy - q.uy * q.hw, q.cx + q.ux * q.hw, q.cy + q.uy * q.hw).d < Math.max(WT, tol)) return o; }
  for (const l of S.labels) { const b = lblBox(l), m = tol / 2; if (p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m) return l; }
  let best = null, bd = Math.max(WT / 2 + 1, tol);
  for (const w of S.walls) { const d = segInfo(p, w.x1, w.y1, w.x2, w.y2).d; if (d < bd) { bd = d; best = w; } }
  return best;
}

/* ---------- tools ---------- */
const TOOLS = [
  ['select', '↖', 'Select', 'Tap to select. Drag empty space for a selection box. Shift or Multi-select adds more.'],
  ['pan', '✋', 'Pan', 'Drag to move around. Two fingers always pan and zoom.'],
  ['wall', '╱', 'Wall', 'Tap points to draw walls. Ends snap together. Double-tap, Enter or Done to finish.'],
  ['door', '🚪', 'Door', 'Tap a wall to place a door. Select it to change the swing with the yellow dot.'],
  ['doorway', '⛩', 'Doorway', 'Tap a wall to place a doorway.'],
  ['window', '▦', 'Window', 'Tap a wall to place a window.'],
  ['camera', '📷', 'Camera', 'Tap to place a camera, or drag to aim it. The tool stays active.'],
  ['label', 'T', 'Label', 'Tap where the label goes. The tool stays active.'],
  ['calibrate', '📏', 'Set scale', 'Tap two points on the imported plan, then enter their real distance.'],
  ['movepdf', '⤧', 'Move plan', 'Drag to reposition the imported PDF.']
];
function setTool(t) {
  tool = t; drawing = null; calib = null; pending = null;
  document.querySelectorAll('#tb .t').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#hintTxt').textContent = TOOLS.find(x => x[0] === t)[3];
  $('#bDone').hidden = t !== 'wall';
  cv.style.cursor = t === 'select' ? 'default' : t === 'pan' || t === 'movepdf' ? 'grab' : 'crosshair';
  draw();
}
$('#tb').innerHTML = TOOLS.map(t => `<button class="t" data-t="${t[0]}"><i>${t[1]}</i><span>${t[2]}</span></button>`).join('');
$('#tb').addEventListener('click', e => { const b = e.target.closest('.t'); if (b) setTool(b.dataset.t); });

function place(p) {
  if (tool === 'wall') return wallClick(p);
  if (['door', 'doorway', 'window'].includes(tool)) {
    const w = (tool === 'window' ? 4 : 3) * PPF, n = nearestWall(p, w), type = tool;
    if (n) mutate(() => S.openings.push({ id: uid(), type, wall: n.w.id, t: n.t, w, side: 1, hinge: 0 })); else toast('Tap on a wall to place it');
  } else if (tool === 'label') {
    setTimeout(() => {
      const t = prompt('Label text:'); ptrs.clear(); drag = null;
      if (t && t.trim()) mutate(() => S.labels.push({ id: uid(), x: p.x, y: p.y, text: t.trim(), size: 16 }));
    }, 0);
  } else if (tool === 'calibrate') {
    if (!S.pdf) return toast('Import a plan first');
    if (!calib) { calib = { p1: p }; return draw(); }
    const dist = Math.hypot(p.x - calib.p1.x, p.y - calib.p1.y), p1 = calib.p1; calib = null; draw();
    setTimeout(() => {
      const ft = parseFloat(prompt('Real distance between the two points (feet):')); ptrs.clear(); drag = null;
      if (!ft || ft <= 0 || dist < 1) return;
      const f = ft * PPF / dist; S.pdf.x = p1.x + (S.pdf.x - p1.x) * f; S.pdf.y = p1.y + (S.pdf.y - p1.y) * f; S.pdf.s *= f; draw(); toast('Plan scaled');
    }, 0);
  }
}
function wallClick(p) {
  const q = snapPt(p, drawing ? drawing.start : null);
  if (!drawing) { drawing = { start: q, first: q }; return draw(); }
  if (Math.hypot(q.x - drawing.start.x, q.y - drawing.start.y) < 3) return;
  const s = drawing.start; mutate(() => S.walls.push({ id: uid(), x1: s.x, y1: s.y, x2: q.x, y2: q.y }));
  if (S.walls.length > 2 && Math.hypot(q.x - drawing.first.x, q.y - drawing.first.y) < 1) drawing = null; else drawing.start = q;
  draw();
}
function placeCamera(p) {
  const before = ser(), q = cfg.snap ? { x: Math.round(p.x / G) * G, y: Math.round(p.y / G) * G } : p;
  const cam = { id: uid(), x: q.x, y: q.y, rot: 0, fov: 90, range: 30, label: 'Cam ' + (S.cameras.length + 1), color: COLORS[S.cameras.length % 6] };
  S.cameras.push(cam); sel = new Set([cam.id]); updatePanel(); drag = { type: 'aim', cam, before, s: down.s }; draw();
}

/* ---------- pointer input ---------- */
const P = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const W2 = s => ({ x: (s.x - view.x) / view.z, y: (s.y - view.y) / view.z });
let down = null;
function abortDrag() { if (drag && drag.before !== undefined && drag.type !== 'marquee') { restore(drag.before); updatePanel(); } drag = null; pending = null; }
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); const s = P(e); ptrs.set(e.pointerId, s);
  if (ptrs.size === 2) { abortDrag(); const [a, b] = [...ptrs.values()]; gest = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: { ...view } }; return draw(); }
  if (ptrs.size > 2) return;
  gest = null; const p = W2(s); hover = p; down = { s, p };
  if (e.button === 1 || e.button === 2 || spaceDown || tool === 'pan') { drag = { type: 'pan', s, v: { ...view } }; return; }
  const add = e.shiftKey || multi;
  if (tool === 'select') return selDown(p, add, e.pointerType);
  if (tool === 'camera') return placeCamera(p);
  if (tool === 'movepdf') { if (S.pdf) drag = { type: 'pdf', p, o: { x: S.pdf.x, y: S.pdf.y } }; return; }
  if (e.pointerType === 'mouse' && tool !== 'label') place(p); else pending = { p, s };
});
function selDown(p, add, pt) {
  const h = hitHandle(p, pt);
  if (h) {
    if (h.k === 'swing') return mutate(() => cycleSwing(h.o));
    const grp = h.k[0] === 'w' ? endpointsAt(h.x, h.y) : null; drag = { type: 'handle', h, grp, before: ser() }; return;
  }
  const o = hitObj(p, pt);
  if (o) {
    if (add) { sel.has(o.id) ? sel.delete(o.id) : sel.add(o.id); updatePanel(); return draw(); }
    if (!sel.has(o.id)) { sel = new Set([o.id]); updatePanel(); }
    return startMove(p, o);
  }
  if (!add) { sel = new Set(); updatePanel(); }
  drag = { type: 'marquee', a: p, b: p, base: new Set(sel), s: down.s }; draw();
}
function startMove(p, o) {
  const before = ser();
  if (sel.size === 1 && o.wall) { drag = { type: 'slide', o, before }; return draw(); }
  const items = [], extra = [], seen = new Set();
  for (const id of sel) {
    const x = byId(id); if (!x) continue;
    if (x.x1 !== undefined) items.push({ o: x, x1: x.x1, y1: x.y1, x2: x.x2, y2: x.y2 });
    else if (x.x !== undefined) items.push({ o: x, x: x.x, y: x.y });
  }
  for (const it of items) if (it.x1 !== undefined) for (const [x, y] of [[it.x1, it.y1], [it.x2, it.y2]])
    for (const r of endpointsAt(x, y)) { if (sel.has(r.w.id)) continue; const key = r.w.id + r.k; if (seen.has(key)) continue; seen.add(key); extra.push({ w: r.w, k: r.k, x: r.w['x' + r.k], y: r.w['y' + r.k] }); }
  drag = { type: 'move', p, items, extra, before };
}
cv.addEventListener('pointermove', e => {
  const s = P(e); if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, s);
  if (gest && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = Math.min(10, Math.max(.03, gest.v.z * d / gest.d)), wx = (gest.m.x - gest.v.x) / gest.v.z, wy = (gest.m.y - gest.v.y) / gest.v.z;
    view.z = z; view.x = m.x - wx * z; view.y = m.y - wy * z; return draw();
  }
  const p = W2(s); hover = p;
  if (pending && Math.hypot(s.x - pending.s.x, s.y - pending.s.y) > 10) { drag = { type: 'pan', s: pending.s, v: { ...view } }; pending = null; }
  if (drag) dragMove(s, p);
  draw();
});
function dragMove(s, p) {
  const d = drag;
  if (d.type === 'pan') { view.x = d.v.x + s.x - d.s.x; view.y = d.v.y + s.y - d.s.y; }
  else if (d.type === 'marquee') d.b = p;
  else if (d.type === 'pdf') { S.pdf.x = d.o.x + p.x - d.p.x; S.pdf.y = d.o.y + p.y - d.p.y; }
  else if (d.type === 'aim') { if (Math.hypot(s.x - d.s.x, s.y - d.s.y) > 8) d.cam.rot = norm360(Math.atan2(p.y - d.cam.y, p.x - d.cam.x) / D2R); }
  else if (d.type === 'move') {
    let dx = p.x - d.p.x, dy = p.y - d.p.y; if (cfg.snap) { dx = Math.round(dx / G) * G; dy = Math.round(dy / G) * G; }
    for (const it of d.items) { const o = it.o; if (it.x1 !== undefined) { o.x1 = it.x1 + dx; o.y1 = it.y1 + dy; o.x2 = it.x2 + dx; o.y2 = it.y2 + dy; } else { o.x = it.x + dx; o.y = it.y + dy; } }
    for (const r of d.extra) { r.w['x' + r.k] = r.x + dx; r.w['y' + r.k] = r.y + dy; }
  } else if (d.type === 'slide') {
    const n = nearestWall(p, d.o.w, 60 / view.z); if (n) { d.o.wall = n.w.id; d.o.t = n.t; }
  } else if (d.type === 'handle') {
    const h = d.h, c = h.o;
    if (h.k === 'cr') { const dx = p.x - c.x, dy = p.y - c.y; c.rot = norm360(Math.atan2(dy, dx) / D2R); c.range = Math.max(3, Math.round(Math.hypot(dx, dy) / PPF * 2) / 2); }
    else if (h.k === 'cf1' || h.k === 'cf2') c.fov = Math.max(5, Math.min(360, Math.round(Math.abs(norm180(Math.atan2(p.y - c.y, p.x - c.x) / D2R - c.rot)) * 2)));
    else { const other = h.k === 'w1' ? { x: c.x2, y: c.y2 } : { x: c.x1, y: c.y1 }, q = snapPt(p, other, new Set(d.grp.map(g => g.w.id))); for (const g of d.grp) { g.w['x' + g.k] = q.x; g.w['y' + g.k] = q.y; } }
  }
}
function endPtr(e) {
  ptrs.delete(e.pointerId); if (ptrs.size < 2) gest = null;
  if (pending && ptrs.size === 0) { const p = pending.p; pending = null; place(p); }
  if (drag && ptrs.size === 0) finishDrag();
  if (ptrs.size === 0) pending = null; draw();
}
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
function finishDrag() {
  const d = drag; drag = null;
  if (d.type === 'marquee') {
    if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) * view.z > 4) applyMarquee(d);
  } else if (d.before !== undefined && ser() !== d.before) pushUndo(d.before);
  updatePanel();
}
function applyMarquee(d) {
  const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y), win = d.b.x >= d.a.x, ids = new Set(d.base);
  const inR = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const R = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  for (const w of S.walls) {
    const a = inR(w.x1, w.y1), b = inR(w.x2, w.y2);
    if (win ? a && b : a || b || R.some((r, i) => segInt({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }, r, R[(i + 1) % 4]))) ids.add(w.id);
  }
  for (const c of S.cameras) if (inR(c.x, c.y)) ids.add(c.id);
  for (const o of S.openings) { const q = opGeo(o); if (q && inR(q.cx, q.cy)) ids.add(o.id); }
  for (const l of S.labels) { const b = lblBox(l); if (win ? inR(b.x, b.y) && inR(b.x + b.w, b.y + b.h) : !(b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0)) ids.add(l.id); }
  sel = ids;
}
cv.addEventListener('dblclick', () => { if (tool === 'wall') drawing = null; draw(); });
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => { e.preventDefault(); zoomAt(P(e), Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015))); draw(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());
function zoomAt(s, f) { const z = Math.min(10, Math.max(.03, view.z * f)), k = z / view.z; view.x = s.x - (s.x - view.x) * k; view.y = s.y - (s.y - view.y) * k; view.z = z; }
// two quick taps in wall tool also finish the chain on touch
let lastTap = 0; cv.addEventListener('pointerup', e => { if (tool === 'wall' && e.pointerType !== 'mouse') { const n = Date.now(); if (n - lastTap < 320) { drawing = null; draw(); } lastTap = n; } });

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { delSel(); e.preventDefault(); }
  else if (e.key === 'Escape') { drawing = null; calib = null; sel = new Set(); updatePanel(); draw(); }
  else if (e.key === 'Enter') { drawing = null; draw(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.shiftKey ? doRedo() : doUndo(); e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'y') { doRedo(); e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 's') { save(); e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'a') { sel = new Set(arrs().flat().map(o => o.id)); updatePanel(); draw(); e.preventDefault(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

/* ---------- editing actions ---------- */
function delSel() {
  if (!sel.size) return;
  mutate(() => {
    const ids = new Set(sel);
    S.walls = S.walls.filter(w => !ids.has(w.id)); S.cameras = S.cameras.filter(c => !ids.has(c.id)); S.labels = S.labels.filter(l => !ids.has(l.id));
    S.openings = S.openings.filter(o => !ids.has(o.id) && S.walls.some(w => w.id === o.wall)); sel = new Set();
  });
}
function tidy() {
  mutate(() => {
    const nodes = [], map = new Map(), tol = 15;
    for (const w of S.walls) for (const k of [1, 2]) {
      const x = w['x' + k], y = w['y' + k]; let n = nodes.find(n => Math.hypot(n.x - x, n.y - y) < tol);
      if (!n) { n = { x, y, sx: 0, sy: 0, c: 0, refs: [] }; nodes.push(n); }
      n.sx += x; n.sy += y; n.c++; n.x = n.sx / n.c; n.y = n.sy / n.c; n.refs.push({ w, k }); map.set(w.id + k, n);
    }
    for (const w of S.walls) {                      // make nearly-straight walls exactly straight
      const a = map.get(w.id + 1), b = map.get(w.id + 2); if (a === b) continue;
      const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) / D2R) % 180;
      if (ang < 8 || ang > 172) a.y = b.y = (a.y + b.y) / 2; else if (Math.abs(ang - 90) < 8) a.x = b.x = (a.x + b.x) / 2;
    }
    for (const ax of ['x', 'y']) {                  // line up parallel walls that are almost aligned
      const s = [...nodes].sort((p, q) => p[ax] - q[ax]); let g = [];
      for (let i = 0; i <= s.length; i++) {
        if (i < s.length && (!g.length || s[i][ax] - g[g.length - 1][ax] < 8)) g.push(s[i]);
        else { if (g.length) { const v = g.reduce((t, n) => t + n[ax], 0) / g.length; g.forEach(n => n[ax] = v); } g = i < s.length ? [s[i]] : []; }
      }
    }
    for (const n of nodes) for (const r of n.refs) { r.w['x' + r.k] = Math.round(n.x * 10) / 10; r.w['y' + r.k] = Math.round(n.y * 10) / 10; }
    const dead = new Set(S.walls.filter(w => wl(w) < 2).map(w => w.id));
    S.walls = S.walls.filter(w => !dead.has(w.id)); S.openings = S.openings.filter(o => !dead.has(o.wall));
  });
  toast('Walls tidied: joined, straightened and aligned');
}

/* ---------- properties panel ---------- */
const fld = (lbl, k, v, o) => `<label>${lbl}<input data-k="${k}" ${o || ''} value="${String(v).replace(/"/g, '&quot;')}"></label>`;
function updatePanel() {
  const P = $('#props'), items = [...sel].map(byId).filter(Boolean);
  if (!items.length) { P.hidden = true; panelId = null; return; }
  P.hidden = false; const o = items[0]; panelId = items.length === 1 ? o.id : null; let h = '';
  if (items.length > 1) h = `<b>${items.length} items selected</b>`;
  else if (o.fov !== undefined) h = `<b>Camera</b>${fld('Name', 'label', o.label, 'data-t="s"')}${fld('Field of view (°)', 'fov', Math.round(o.fov), 'type="number" min="5" max="360" inputmode="decimal"')}${fld('Range (ft)', 'range', o.range, 'type="number" min="1" inputmode="decimal"')}${fld('Direction (°)', 'rot', Math.round(o.rot), 'type="number" inputmode="decimal"')}`;
  else if (o.wall) h = `<b>${o.type[0].toUpperCase() + o.type.slice(1)}</b><label>Type<select data-k="type" data-t="s"><option ${o.type === 'door' ? 'selected' : ''}>door</option><option ${o.type === 'doorway' ? 'selected' : ''}>doorway</option><option ${o.type === 'window' ? 'selected' : ''}>window</option></select></label>${fld('Width (ft)', 'w', (o.w / PPF).toFixed(1), `type="number" min="1" step="0.5" data-m="${PPF}" inputmode="decimal"`)}${o.type === 'door' ? '<button id="pSwing">Change swing</button>' : ''}`;
  else if (o.text !== undefined) h = `<b>Label</b>${fld('Text', 'text', o.text, 'data-t="s"')}${fld('Size', 'size', o.size, 'type="number" min="6" inputmode="decimal"')}`;
  else h = `<b>Wall</b><span>Length ${(wl(o) / PPF).toFixed(1)} ft</span>`;
  P.innerHTML = h + '<button id="pDel" class="danger">Delete</button>';
}
$('#props').addEventListener('focusin', () => { pBefore = ser(); });
$('#props').addEventListener('input', e => {
  const t = e.target, o = panelId && byId(panelId); if (!o || !t.dataset.k) return; let v = t.value;
  if (t.dataset.t !== 's') { v = parseFloat(v); if (isNaN(v) || (t.min !== '' && v < +t.min) || (t.max !== '' && v > +t.max)) return; v *= parseFloat(t.dataset.m || 1); }
  o[t.dataset.k] = v; draw();
});
$('#props').addEventListener('focusout', () => { if (pBefore && ser() !== pBefore) pushUndo(pBefore); pBefore = null; });
$('#props').addEventListener('click', e => {
  if (e.target.id === 'pDel') delSel();
  if (e.target.id === 'pSwing') { const o = byId(panelId); mutate(() => cycleSwing(o)); }
});

/* ---------- view ---------- */
function bounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  S.walls.forEach(w => { add(w.x1, w.y1); add(w.x2, w.y2); }); S.cameras.forEach(c => fovPoly(c).forEach(p => add(p.x, p.y)));
  S.labels.forEach(l => { const b = lblBox(l); add(b.x, b.y); add(b.x + b.w, b.y + b.h); });
  if (S.pdf && pdfImg && S.pdf.opacity > 0) { add(S.pdf.x, S.pdf.y); add(S.pdf.x + pdfImg.width * S.pdf.s, S.pdf.y + pdfImg.height * S.pdf.s); }
  return x0 > x1 ? { x0: 0, y0: 0, x1: 800, y1: 600 } : { x0, y0, x1, y1 };
}
function fit() {
  const b = bounds(), pad = 60, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2, z = Math.min(W / w, H / h, 3);
  view = { z, x: (W - (b.x1 - b.x0) * z) / 2 - b.x0 * z, y: (H - (b.y1 - b.y0) * z) / 2 - b.y0 * z }; draw();
}
function resize() { const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; draw(); }
new ResizeObserver(resize).observe(cv);

/* ---------- import PDF / image ---------- */
pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.js';
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    let src;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise; let n = 1;
      if (doc.numPages > 1) n = Math.min(doc.numPages, Math.max(1, parseInt(prompt(`This PDF has ${doc.numPages} pages. Which page?`, '1')) || 1));
      const page = await doc.getPage(n), v1 = page.getViewport({ scale: 1 }), sc = Math.min(3, 3600 / Math.max(v1.width, v1.height) );
      const c = document.createElement('canvas'), vp = page.getViewport({ scale: sc }); c.width = vp.width; c.height = vp.height;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise; src = c.toDataURL('image/jpeg', .9);
    } else src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    await loadPdfImg(src, { x: 0, y: 0, s: 0, opacity: .6 }); S.pdf.s = 1200 / pdfImg.width; $('#op').value = 60; fit();
    toast('Plan imported. Use Set scale to match real-world size.');
  } catch (err) { toast('Could not import file: ' + err.message, true); }
});
function loadPdfImg(src, meta) { return new Promise(res => { const im = new Image(); im.onload = () => { pdfImg = im; S.pdf = { src, ...meta }; draw(); res(); }; im.src = src; }); }
$('#op').addEventListener('input', e => { if (S.pdf) { S.pdf.opacity = e.target.value / 100; draw(); } });
$('#bRmPdf').onclick = () => { if (S.pdf && confirm('Remove the imported plan?')) { S.pdf = null; pdfImg = null; draw(); } };

/* ---------- save / open / delete ---------- */
const pname = () => $('#pname').value.trim() || 'Untitled';
async function save() {
  const name = pname(), data = { app: 'camplan', version: VER, name, walls: S.walls, openings: S.openings, cameras: S.cameras, labels: S.labels, pdf: S.pdf, view };
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); toast(`Saved “${name}” to the plans folder`);
  } catch (err) { toast('Save failed: ' + err.message, true); }
}
async function loadProject(name) {
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(name)); if (!r.ok) throw new Error(await r.text()); const d = await r.json();
    S = { walls: d.walls || [], openings: d.openings || [], cameras: d.cameras || [], labels: d.labels || [], pdf: null }; pdfImg = null; sel = new Set(); undo = []; redo = []; drawing = null;
    if (d.pdf) { await loadPdfImg(d.pdf.src, { x: d.pdf.x, y: d.pdf.y, s: d.pdf.s, opacity: d.pdf.opacity }); $('#op').value = Math.round(d.pdf.opacity * 100); }
    $('#pname').value = d.name || name; if (d.view) view = d.view; else fit(); updatePanel(); draw(); closeModals(); toast(`Opened “${name}”`);
  } catch (err) { toast('Open failed: ' + err.message, true); }
}
async function listProjects() {
  const box = $('#plist'); box.textContent = 'Loading…';
  try {
    const l = await (await fetch('/api/projects')).json();
    if (!l.length) { box.textContent = 'No saved projects yet. Press Save to create one.'; return; }
    box.innerHTML = ''; for (const p of l) {
      const row = document.createElement('div'); row.className = 'pi';
      row.innerHTML = `<div class="n">${p.name.replace(/</g, '&lt;')}<small>${new Date(p.modified).toLocaleString()} · ${(p.size / 1048576).toFixed(1)} MB</small></div><button>Open</button><button class="danger">Delete</button>`;
      const [o, d] = row.querySelectorAll('button'); o.onclick = () => loadProject(p.name);
      d.onclick = async () => { if (!confirm(`Delete “${p.name}” permanently?`)) return; const r = await fetch('/api/projects/' + encodeURIComponent(p.name), { method: 'DELETE' }); toast(r.ok ? 'Deleted' : 'Delete failed', !r.ok); listProjects(); };
      box.appendChild(row);
    }
  } catch (err) { box.textContent = 'Could not reach the server: ' + err.message; }
}

/* ---------- export ---------- */
function exportCanvas(noPdf) {
  const b = bounds(), pad = 40, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2, k = Math.min(3200 / w, 3200 / h, 3);
  const c = document.createElement('canvas'); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  render(g, { x: (pad - b.x0) * k, y: (pad - b.y0) * k, z: k }, false, { ...TH.light, bg: '#ffffff' }, { noPdf }); return c;
}
function dl(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
$('#bDoExport').onclick = () => {
  const fmt = document.querySelector('input[name=fmt]:checked').value, c = exportCanvas(!$('#exPdf').checked), name = pname().replace(/[^\w\- ]/g, '_');
  if (fmt === 'jpg') c.toBlob(b => dl(b, name + '.jpg'), 'image/jpeg', .92);
  else {
    const land = c.width >= c.height, pw = land ? 792 : 612, ph = land ? 612 : 792, m = 24, k = Math.min((pw - 2 * m) / c.width, (ph - 2 * m) / c.height);
    const pdf = new window.jspdf.jsPDF({ orientation: land ? 'l' : 'p', unit: 'pt', format: 'letter' });
    pdf.addImage(c.toDataURL('image/jpeg', .92), 'JPEG', (pw - c.width * k) / 2, (ph - c.height * k) / 2, c.width * k, c.height * k); pdf.save(name + '.pdf');
  }
  closeModals();
};

/* ---------- modals, settings, buttons ---------- */
const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.hidden = true);
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModals);
document.querySelectorAll('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) closeModals(); }));
$('#bOpen').onclick = () => { $('#mOpen').hidden = false; listProjects(); };
$('#bExport').onclick = () => { $('#exPdf').checked = !!S.pdf; $('#exPdf').disabled = !S.pdf; $('#mExport').hidden = false; };
$('#bSet').onclick = () => $('#mSet').hidden = false;
$('#bSave').onclick = save; $('#bUndo').onclick = doUndo; $('#bRedo').onclick = doRedo;
$('#bNew').onclick = () => { if (!confirm('Start a new project? Unsaved changes will be lost.')) return; S = { walls: [], openings: [], cameras: [], labels: [], pdf: null }; pdfImg = null; sel = new Set(); undo = []; redo = []; $('#pname').value = 'Untitled'; updatePanel(); draw(); };
$('#bDel').onclick = delSel; $('#bTidy').onclick = tidy; $('#bFit').onclick = fit; $('#bDone').onclick = () => { drawing = null; draw(); };
$('#bZi').onclick = () => { zoomAt({ x: W / 2, y: H / 2 }, 1.3); draw(); }; $('#bZo').onclick = () => { zoomAt({ x: W / 2, y: H / 2 }, 1 / 1.3); draw(); };
$('#bMulti').onclick = e => { multi = !multi; e.currentTarget.classList.toggle('on', multi); };
$('#tg').onclick = () => $('#tools').classList.toggle('collapsed');
function applyCfg() {
  document.documentElement.dataset.theme = cfg.dark ? 'dark' : 'light'; localStorage.setItem('camplan-cfg', JSON.stringify(cfg));
  $('#sDark').checked = cfg.dark; $('#sGrid').checked = cfg.grid; $('#sSnap').checked = cfg.snap; $('#sBlock').checked = cfg.block; draw();
}
for (const [id, k] of [['sDark', 'dark'], ['sGrid', 'grid'], ['sSnap', 'snap'], ['sBlock', 'block']]) $('#' + id).onchange = e => { cfg[k] = e.target.checked; applyCfg(); };

fetch('/api/version').then(r => r.json()).then(v => { VER = v.version; $('#ver').textContent = VER; }).catch(() => { $('#ver').textContent = 'unknown'; });
applyCfg(); setTool('select'); resize();
