/* ==========================================================
   satele's logbook — tracker engine
   ----------------------------------------------------------
   Two layers:
   1. DATA  — the official lists, fetched from /data/<game>.json.
              Edit that file + redeploy and every visitor gets the update.
   2. U     — this visitor's own layer, kept in localStorage:
              ticks/pins/notes keyed by each entry's permanent `id`,
              plus anything they add, rename or hide themselves.
   The page shows `state` = DATA merged with U. On every change we
   pull the visitor's bits back out of `state` into U and save U.
   ========================================================== */
(function () {
'use strict';

const GAME = document.body.dataset.game;

/* ---------- switches ---------- */
// Turn these back on once the lists are complete and you're adding brand-new game content:
const SHOW_NEW_BADGES = false;  // "new!" badge + "N new entries" pop-up for entries added since someone's last visit
const SHOW_AVAILABLE = false;   // "available" pill once an entry's "after" quest/bundle is done (locks always show)
const KEY = `satele:${GAME}:v1`;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const rid = () => 'u-' + Math.random().toString(36).slice(2, 10);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const splitQty = label => { const m = String(label).match(/^(.*?)\s*[×x]\s*(\d+)\s*$/i); return m ? [m[1].trim(), +m[2]] : [String(label).trim(), 1]; };
const partKey = label => splitQty(label)[0].toLowerCase();
// "Dew ×10000" -> "Dew ×10,000" for display
const fmtQty = label => { const [n, q] = splitQty(label); return /[×x]\s*\d+\s*$/i.test(label) ? `${n} ×${q.toLocaleString('en-US')}` : label; };

const EMOJIS = ['🍳','🧵','🪚','🔧','⚗️','🛠️','🪴','🌱','🍰','🍜','🧋','🐟','🏺','📟','💭','🐾','👗','🪑','🧸','🌸','⭐','💎','🗝️','📝','☀️','🌙','🎀','🍓','🦋','🐚','🎣','🏝️','📜','🔬','💡','🔁'];
const MENU_COLORS = [['#ff9ec7','#f472a8'],['#9fd5ff','#5bb2ee'],['#9be7c4','#4cc794'],['#c9b6ff','#9b83f0'],['#ffc2a1','#f59a6c'],['#ffe08a','#e6b93b']];
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ---------- storage ---------- */
let storageOK = true;
try { const t = '__satele_test'; localStorage.setItem(t, '1'); localStorage.removeItem(t); } catch (e) { storageOK = false; }

const freshUser = () => ({
  v: 1, dataVersion: null, known: [],
  ui: { menu: null, cat: {}, hideDone: false, pinOnly: false, sort: 'order', q: '' },
  items: {}, cats: {}, menus: {},
  hidden: { items: {}, cats: {}, menus: {} },
  order: { menus: [], cats: {} },
  orderCustom: { menus: false, cats: {} }, // only set when the visitor moves things themselves
  custom: { menus: [], cats: {}, items: {} }
});
function normalizeUser(u) {
  const f = freshUser();
  if (!u || typeof u !== 'object') return f;
  const out = Object.assign(f, u);
  out.ui = Object.assign(freshUser().ui, u.ui || {});
  out.hidden = Object.assign(freshUser().hidden, u.hidden || {});
  out.order = Object.assign(freshUser().order, u.order || {});
  out.orderCustom = Object.assign(freshUser().orderCustom, u.orderCustom || {});
  out.custom = Object.assign(freshUser().custom, u.custom || {});
  ['items', 'cats', 'menus'].forEach(k => { if (!out[k] || typeof out[k] !== 'object') out[k] = {}; });
  if (!Array.isArray(out.known)) out.known = [];
  return out;
}
function loadUser() {
  if (!storageOK) return freshUser();
  try { return normalizeUser(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { return freshUser(); }
}

let DATA = null, IDX = null, U = loadUser(), state = null, NEW = new Set();

/* ---------- entries you've moved/merged in the data file ---------- */
// data file: "moved": { "old-id": { "to": "new-id", "part": "Tag name (optional)" } }
// Carries a visitor's ticks/pins on the old entry over to the new one, once.
function applyMoves() {
  const mv = DATA.moved || {};
  Object.keys(mv).forEach(oldId => {
    const p = U.items[oldId], m = mv[oldId];
    if (!p || !m || !IDX.items[m.to]) return;
    const q = U.items[m.to] = U.items[m.to] || {};
    const target = IDX.items[m.to];
    if (q.d && !q.parts && target.needs && target.needs.length) { // it was ticked before it had parts
      q.parts = {}; target.needs.forEach(l => { q.parts[partKey(l)] = 1; });
    }
    const wasDone = p.d || (p.parts && Object.keys(p.parts).length) || (p.p && p.p.some(Boolean));
    if (m.part) { if (wasDone) { q.parts = q.parts || {}; q.parts[partKey(m.part)] = 1; } }
    else {
      if (p.d) q.d = 1;
      if (p.parts) q.parts = Object.assign({}, q.parts, p.parts);
      if (p.p) q.p = p.p;
    }
    if (p.pin) q.pin = 1;
    if (p.fav) q.fav = 1;
    if (p.note && !q.note) q.note = p.note;
    delete U.items[oldId];
  });
}

/* ---------- daily contribution bins ---------- */
// A category with "bins" gets one entry per bin holding *today's* request, worked out the same way the game
// picks it (ported from loftiacodex.com/bins — checked against it day by day). No data updates needed.
// port of the Codex's (game's) daily bin rotation
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(s) { let c = 0xFFFFFFFF; for (const ch of s) { let cp = ch.codePointAt(0); for (let n = 0; n < 4; n++) { c = (c >>> 8) ^ CRC[(c ^ cp) & 255]; cp >>>= 8; } } return (c ^ 0xFFFFFFFF) >>> 0; }
function mix(a, b) { let c = 2654435769; a >>>= 0; b >>>= 0;
  a = a - b >>> 0; a = (a ^ b >>> 13) >>> 0; c = c - a - b >>> 0; c = (c ^ a << 8) >>> 0; b = b - c - a >>> 0; b = (b ^ c >>> 13) >>> 0;
  a = a - b - c >>> 0; a = (a ^ b >>> 12) >>> 0; c = c - a - b >>> 0; c = (c ^ a << 16) >>> 0; b = b - c - a >>> 0; b = (b ^ c >>> 5) >>> 0;
  a = a - b - c >>> 0; a = (a ^ b >>> 3) >>> 0; c = c - a - b >>> 0; c = (c ^ a << 10) >>> 0; b = b - c - a >>> 0; b = (b ^ c >>> 15) >>> 0; return b; }
const dv = new DataView(new ArrayBuffer(4));
function rand01(x) { const t = Math.imul(x >>> 0, 196314165) + 907633515 >>> 0; dv.setUint32(0, (t >>> 9 | 1065353216) >>> 0); return dv.getFloat32(0) - 1; }
function binPick(bin, now, tz = -3) {
  const H = 36e5, period = Math.floor(((now + 621355968e5) / H + tz) / bin.hours);
  const ids = Object.keys(bin.bundles).map(k => 'Bundles.Bins.' + k).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  return ids[Math.trunc(rand01(mix(period, crc32(bin.id))) * ids.length)].replace('Bundles.Bins.', '');
}
const BIN_TITLE = { 'Fish Repopulation': 'Fish', 'Global Village': 'Global Village', 'Museum Artifact Hunt': 'Museum' };
const binSlug = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function refreshBins(now = Date.now()) {
  DATA.menus.forEach(m => m.cats.forEach(c => {
    if (!Array.isArray(c.bins)) return;
    if (!c._base) c._base = c.items || [];
    c.items = c._base.concat(c.bins.map(b => ({
      id: c.id + '.bin.' + binSlug(b.name), name: `${BIN_TITLE[b.effort] || b.effort} Bin Lv. ${b.lv}`, badges: [b.name],
      needs: b.bundles[binPick(b, now)] || []
    })));
  }));
}

/* ---------- merge DATA + U  →  state ---------- */
function indexData() {
  IDX = { menus: {}, cats: {}, items: {}, names: {} };
  DATA.menus.forEach(m => {
    IDX.menus[m.id] = m;
    m.cats.forEach(c => { IDX.cats[c.id] = c; c.items.forEach(it => { IDX.items[it.id] = it; }); });
  });
}
function sortBy(arr, order) {
  if (!order || !order.length) return arr;
  const pos = new Map(order.map((id, i) => [id, i]));
  const keyed = arr.map((x, i) => [pos.has(x.id) ? pos.get(x.id) : 1e6 + i, x]);
  keyed.sort((a, b) => a[0] - b[0]);
  keyed.forEach((k, i) => { arr[i] = k[1]; });
  return arr;
}
function mergeItem(it, C) {
  const p = U.items[it.id] || {};
  return {
    id: it.id, official: true, name: it.name, note: it.note || '', myNote: p.note || '', after: it.after || '',
    // if this entry was ticked before it had materials, carry the tick over to all of them
    parts: (it.needs || []).map(l => ({ label: l, on: !!(p.parts && p.parts[partKey(l)]) || (!!p.d && !p.parts) })),
    pips: C.pipLabels.map((_, i) => !!(p.p && p.p[i])),
    done: (it.needs && it.needs.length) ? false : !!p.d, pinned: !!p.pin, fav: !!p.fav, autoPin: !!p.ap,
    // before turn-in existed, fully gathered meant finished — so count those as handed in
    turned: p.ti != null ? !!p.ti : !!(C.turnIn && it.needs && it.needs.length && it.needs.every(l => (p.parts && p.parts[partKey(l)]) || (p.d && !p.parts))),
    once: !!it.once, // tools & upgrades you only ever craft once — no "make again"
    pick: it.pick && it.needs && it.pick < it.needs.length ? it.pick : 0,  // "any N of these"
    badges: Array.isArray(it.badges) ? it.badges : [],
    price: it.price != null ? String(it.price) : '', cur: (it.cur || C.currency || 'dew').toLowerCase(),
    // tiered upgrades: [{label, needs}] + how many tiers are done
    levels: (it.levels || []).map(l => ({ label: l.name, needs: l.needs || [] })),
    startLv: Math.min(it.startLv || 0, (it.levels || []).length),
    lv: Math.min(p.lv != null ? p.lv : (it.startLv || 0), (it.levels || []).length)
  };
}
const customItem = x => ({ id: x.id || rid(), official: false, name: x.name || '?', note: x.note || '', myNote: '', after: x.after || '',
  parts: (x.parts || []).map(p => ({ label: p.label, on: !!p.on })), pips: (x.pips || []).map(Boolean), done: !!x.done, pinned: !!x.pinned, fav: !!x.fav,
  badges: [], levels: (x.levels || []).map(l => ({ label: l.label, needs: l.needs || [] })), lv: x.lv || 0 });
const customCat = x => ({ id: x.id || rid(), official: false, name: x.name || 'List', icon: x.icon || '⭐', pipLabels: x.pipLabels || [], ordered: !!x.ordered,
  reset: x.reset || '', resetHour: x.resetHour || 0, resetDay: x.resetDay != null ? x.resetDay : 1, lastReset: x.lastReset || 0, items: (x.items || []).map(customItem) });
const customMenu = x => ({ id: x.id || rid(), official: false, name: x.name || 'My list', icon: x.icon || '⭐', color: x.color || 0, cats: (x.cats || []).map(customCat) });

function buildState() {
  const menus = [];
  DATA.menus.forEach(m => {
    if (U.hidden.menus[m.id]) return;
    const mo = U.menus[m.id] || {};
    const M = { id: m.id, official: true, name: mo.name || m.name, icon: mo.icon || m.icon, color: mo.color != null ? mo.color : (m.color || 0), cats: [] };
    m.cats.forEach(c => {
      if (U.hidden.cats[c.id]) return;
      const co = U.cats[c.id] || {};
      const C = { id: c.id, official: true, name: co.name || c.name, icon: co.icon || c.icon, note: c.note || '', pipLabels: c.tags || [], ordered: !!c.ordered, currency: c.currency || '', turnIn: !!c.turnIn, dishes: !!c.dishes, repeat: !!c.repeat, choice: c.choice || '',
        reset: co.reset !== undefined ? co.reset : (c.reset || ''),
        // server resets are stored in UTC in the data file so they're right in every timezone
        resetUtcHour: (co.resetHour == null && co.reset === undefined && c.resetUtcHour != null) ? c.resetUtcHour : null,
        userReset: co.resetHour != null || co.reset !== undefined,
        resetHour: co.resetHour != null ? co.resetHour : (c.resetUtcHour != null ? new Date(Date.UTC(2000, 0, 3, c.resetUtcHour)).getHours() : (c.resetHour || 0)),
        resetDay: co.resetDay != null ? co.resetDay : (c.resetDay != null ? c.resetDay : 1),
        lastReset: co.lastReset || 0, items: [] };
      c.items.forEach(it => { if (!U.hidden.items[it.id]) C.items.push(mergeItem(it, C)); });
      (U.custom.items[c.id] || []).forEach(x => C.items.push(customItem(x)));
      M.cats.push(C);
    });
    (U.custom.cats[m.id] || []).forEach(x => M.cats.push(customCat(x)));
    if (U.orderCustom.cats[m.id]) sortBy(M.cats, U.order.cats[m.id]);
    menus.push(M);
  });
  (U.custom.menus || []).forEach(x => menus.push(customMenu(x)));
  if (U.orderCustom.menus) sortBy(menus, U.order.menus);
  return { menus };
}

/* ---------- state  →  U (only the visitor's own bits) ---------- */
const stripItem = I => ({ id: I.id, name: I.name, note: I.note, after: I.after || undefined, parts: I.parts.map(p => ({ label: p.label, on: p.on })), pips: I.pips, done: I.done, pinned: I.pinned, fav: I.fav,
  levels: I.levels && I.levels.length ? I.levels : undefined, lv: I.lv || undefined });
const stripCat = C => ({ id: C.id, name: C.name, icon: C.icon, pipLabels: C.pipLabels, ordered: C.ordered, reset: C.reset, resetHour: C.resetHour, resetDay: C.resetDay, lastReset: C.lastReset, items: C.items.map(stripItem) });
function persist() {
  const items = Object.assign({}, U.items), cats = Object.assign({}, U.cats), menus = Object.assign({}, U.menus);
  const custom = { menus: [], cats: {}, items: {} };
  const seenCats = new Set(), seenMenus = new Set();
  state.menus.forEach(M => {
    if (!M.official) { custom.menus.push({ id: M.id, name: M.name, icon: M.icon, color: M.color, cats: M.cats.map(stripCat) }); return; }
    seenMenus.add(M.id);
    const dm = IDX.menus[M.id], mo = {};
    if (M.name !== dm.name) mo.name = M.name;
    if (M.icon !== dm.icon) mo.icon = M.icon;
    if (M.color !== (dm.color || 0)) mo.color = M.color;
    if (Object.keys(mo).length) menus[M.id] = mo; else delete menus[M.id];
    M.cats.forEach(C => {
      if (!C.official) { (custom.cats[M.id] = custom.cats[M.id] || []).push(stripCat(C)); return; }
      seenCats.add(C.id);
      const dc = IDX.cats[C.id], co = {};
      if (C.name !== dc.name) co.name = C.name;
      if (C.icon !== dc.icon) co.icon = C.icon;
      if (C.userReset) { co.reset = C.reset; co.resetHour = C.resetHour; co.resetDay = C.resetDay; } // only when the visitor changed it
      if (C.lastReset) co.lastReset = C.lastReset;
      if (Object.keys(co).length) cats[C.id] = co; else delete cats[C.id];
      C.items.forEach(I => {
        if (!I.official) { (custom.items[C.id] = custom.items[C.id] || []).push(stripItem(I)); return; }
        const p = {};
        if (I.done) p.d = 1;
        if (I.turned) p.ti = 1; else if (C.turnIn && I.parts.length && I.parts.every(pt => pt.on)) p.ti = 0; // remembered 'not yet'
        if (I.pinned) p.pin = 1;
        if (I.pinned && I.autoPin) p.ap = 1;
        if (I.fav) p.fav = 1;
        if (I.levels.length && I.lv !== (I.startLv || 0)) p.lv = I.lv;
        if (I.myNote) p.note = I.myNote;
        if (I.pips.some(Boolean)) p.p = I.pips.map(b => b ? 1 : 0);
        const pk = {}; I.parts.forEach(pt => { if (pt.on) pk[partKey(pt.label)] = 1; });
        if (Object.keys(pk).length) p.parts = pk;
        if (Object.keys(p).length) items[I.id] = p; else delete items[I.id];
      });
    });
  });
  // keep the visitor's additions that live inside things they've hidden
  Object.keys(U.custom.items || {}).forEach(k => { if (!seenCats.has(k) && !custom.items[k]) custom.items[k] = U.custom.items[k]; });
  Object.keys(U.custom.cats || {}).forEach(k => { if (!seenMenus.has(k) && !custom.cats[k]) custom.cats[k] = U.custom.cats[k]; });
  U.items = items; U.cats = cats; U.menus = menus; U.custom = custom;
  // remember an order only where the visitor rearranged things, so list-order changes in the data file still reach everyone else
  U.order = {
    menus: U.orderCustom.menus ? state.menus.map(m => m.id) : [],
    cats: Object.fromEntries(state.menus.filter(m => U.orderCustom.cats[m.id]).map(m => [m.id, m.cats.map(c => c.id)]))
  };
}

let saveFail = false;
function save() {
  persist();
  if (!storageOK) return;
  try { localStorage.setItem(KEY, JSON.stringify(U)); saveFail = false; setPill('💾 saved in this browser'); }
  catch (e) { if (!saveFail) toast("⚠️ couldn't save — browser storage may be full"); saveFail = true; setPill('⚠️ not saved'); }
}
function setPill(t) { const p = $('#savePill'); if (p) p.textContent = t; }
function rebuild() { state = buildState(); indexTwins(); indexDishes(); }
// dishes you cook (categories marked "dishes": true) — Pinned breaks them down into their ingredients
let DISHES = new Map();
// pin a daily bin (or anything that asks for a dish) and the dish's recipe card gets pinned with it;
// unpin it (or the bin's request changes at reset) and recipes it pinned for you get unpinned again
function dishesWanted() {
  const want = new Set();
  state.menus.forEach(m => m.cats.forEach(c => c.items.forEach(it => {
    if (!it.pinned || it.autoPin || isDone(c, it)) return;
    it.parts.forEach(pt => { if (pt.on) return; const k = splitQty(pt.label)[0].toLowerCase(); const r = DISHES.get(k); if (r && r.it !== it) want.add(k); });
  })));
  return want;
}
function syncAutoPins() {
  const want = dishesWanted(); let added = 0;
  DISHES.forEach((r, k) => {
    if (want.has(k) && !r.it.pinned) { r.it.pinned = true; r.it.autoPin = true; added++; }
    else if (!want.has(k) && r.it.autoPin) { if (r.it.pinned) r.it.pinned = false; r.it.autoPin = false; }
  });
  return added;
}
function indexDishes() {
  DISHES = new Map();
  state.menus.forEach(m => m.cats.forEach(c => { if (c.dishes) c.items.forEach(it => { if (it.parts.length && !DISHES.has(it.name.toLowerCase())) DISHES.set(it.name.toLowerCase(), { c, it }); }); }));
}
// shop blueprints <-> the recipe that crafts them share a name: they act as one wish
let TWINS = new Map();
function indexTwins() {
  TWINS = new Map();
  state.menus.forEach(m => m.cats.forEach(c => c.items.forEach(it => {
    if (!it.official) return;
    const k = it.name.toLowerCase(), t = TWINS.get(k) || { shop: null, craft: null };
    if (it.price && !t.shop) t.shop = { c, it }; else if (it.parts.length && !it.price && !t.craft) t.craft = { c, it };
    TWINS.set(k, t);
  })));
}
// only shop items and tiered upgrades (permits) can be wished; a wished blueprint brings its recipe along
const hasWishables = () => state.menus.some(m => m.cats.some(c => c.items.some(canWish))); // games with no shops/permits skip the Wishlist tab
const canWish = it => !!(it.official && (it.price || (it.levels && it.levels.length)));
const isWished = it => it.fav && (canWish(it) || !!(shopTwin(it) && shopTwin(it).it.fav));
const shopTwin = it => { const t = TWINS.get(it.name.toLowerCase()); return t && t.shop && t.shop.it !== it ? t.shop : null; };

/* ---------- derived ---------- */
function curMenu() { return state.menus.find(m => m.id === U.ui.menu) || state.menus[0]; }
function isNeeded() { return U.ui.menu === 'needed'; }
function isWish() { return U.ui.menu === 'wish'; }
function isSpecial() { return isNeeded() || isWish(); }
function curCat() {
  const m = curMenu(); if (!m || !m.cats.length) return null;
  let c = m.cats.find(x => x.id === U.ui.cat[m.id]);
  if (!c) { c = m.cats[0]; U.ui.cat[m.id] = c.id; }
  return c;
}
// "turn in" lists (dailies, inspirations): gathering everything isn't the finish line — handing it in is
const needsTurnIn = (c, it) => !!(c.turnIn && it.official && it.parts.length);
function units(c, it) {
  if (it.levels && it.levels.length) return [it.lv, it.levels.length];
  if (needsTurnIn(c, it)) return [it.turned ? 1 : 0, 1];
  if (it.parts.length) { const on = it.parts.filter(p => p.on).length, need = it.pick || it.parts.length; return [Math.min(on, need), need]; }
  if (c.pipLabels.length) return [c.pipLabels.filter((_, i) => it.pips[i]).length, c.pipLabels.length];
  return [it.done ? 1 : 0, 1];
}
const isDone = (c, it) => { const u = units(c, it); return u[0] === u[1]; };
function setAll(c, it, val) {
  if (it.levels && it.levels.length) { it.lv = val ? it.levels.length : 0; return; }
  if (it.parts.length) { it.parts.forEach(p => { p.on = val; }); if (needsTurnIn(c, it)) it.turned = val; }
  else if (c.pipLabels.length) it.pips = c.pipLabels.map(() => val);
  else it.done = val;
}
function catStats(c) {
  let n = 0, total = 0, full = 0;
  c.items.forEach(it => { const u = units(c, it); n += u[0]; total += u[1]; if (u[0] === u[1]) full++; });
  return { n, total, full, items: c.items.length };
}
function menuStats(m) { let n = 0, t = 0; m.cats.forEach(c => { const s = catStats(c); n += s.full; t += s.items; }); return { n, t }; }
function allPinned() { const out = []; state.menus.forEach(m => m.cats.forEach(c => c.items.forEach(it => { if (it.pinned && !it.price) out.push({ m, c, it }); /* shop items use the wishlist, not pins */ }))); return out; }
function locate(id) { for (const m of state.menus) for (const c of m.cats) { const it = c.items.find(x => x.id === id); if (it) return { m, c, it }; } return null; }
function questDone(name) {
  const k = name.toLowerCase();
  for (const m of state.menus) for (const c of m.cats) for (const it of c.items) if (it.name.toLowerCase() === k) return isDone(c, it);
  return null;
}

/* ---------- daily / weekly resets ---------- */
function lastBoundary(c, now) {
  if (c.resetUtcHour != null) {
    const u = new Date(now); u.setUTCHours(c.resetUtcHour, 0, 0, 0);
    if (u.getTime() > now) u.setUTCDate(u.getUTCDate() - 1);
    if (c.reset === 'weekly') { const want = c.resetDay == null ? 1 : c.resetDay; while (u.getUTCDay() !== want) u.setUTCDate(u.getUTCDate() - 1); }
    return u.getTime();
  }
  const d = new Date(now); d.setHours(c.resetHour || 0, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  if (c.reset === 'weekly') { const want = c.resetDay == null ? 1 : c.resetDay; while (d.getDay() !== want) d.setDate(d.getDate() - 1); }
  return d.getTime();
}
function nextBoundary(c, now) {
  const l = new Date(lastBoundary(c, now)), days = c.reset === 'weekly' ? 7 : 1;
  if (c.resetUtcHour != null) l.setUTCDate(l.getUTCDate() + days); else l.setDate(l.getDate() + days);
  return l.getTime();
}
function checkResets() {
  const now = Date.now(); let changed = false;
  state.menus.forEach(m => m.cats.forEach(c => {
    if (c.reset !== 'daily' && c.reset !== 'weekly') return;
    if (!c.lastReset) { c.lastReset = now; changed = true; return; }
    if (c.lastReset < lastBoundary(c, now)) { c.items.forEach(it => setAll(c, it, false)); c.lastReset = now; changed = true; }
  }));
  return changed;
}
function fmtLeft(ms) { const h = Math.floor(ms / 36e5), mn = Math.floor(ms % 36e5 / 6e4); if (h >= 48) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; if (h >= 1) return h + 'h ' + mn + 'm'; return Math.max(mn, 1) + 'm'; }

/* ---------- render ---------- */
function render() { renderTabs(); renderChips(); renderCat(); renderBubble(); }

function renderTabs() {
  const pins = allPinned(), left = pins.filter(p => !isDone(p.c, p.it)).length;
  const h = state.menus.map(m => {
    const s = menuStats(m), col = MENU_COLORS[(m.color || 0) % MENU_COLORS.length];
    return `<button class="tab ${!isSpecial() && m.id === curMenu().id ? 'on' : ''}" style="--tabc:${col[0]};--tabd:${col[1]}" data-act="menu" data-id="${esc(m.id)}"><span>${esc(m.icon)}</span>${esc(m.name)}<span class="cnt">${m.cats.length && m.cats.every(x => x.repeat) ? s.t : `${s.n}/${s.t}`}</span></button>`;
  }).join('');
  const tabs = $('#tabs');
  tabs.innerHTML = `<button class="tab ${isNeeded() ? 'on' : ''}" style="--tabc:#ffb3c8;--tabd:#ef7f9f" data-act="menu" data-id="needed"><span>📌</span>Pinned<span class="cnt">${left}</span></button>${hasWishables() ? `<button class="tab ${isWish() ? 'on' : ''}" style="--tabc:#ffc4dc;--tabd:#e9719f" data-act="menu" data-id="wish"><span>💝</span>Wishlist<span class="cnt">${wishGoals().filter(g => !g.done).length}</span></button>` : ''}` + h + `<button class="tab add" data-act="addMenu">＋ new menu</button>`;
  const on = tabs.querySelector('.tab.on'); // keep the active tab visible on phones
  if (on && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = on.offsetLeft - tabs.clientWidth / 2 + on.offsetWidth / 2;
}
function renderChips() {
  const el = $('#chips');
  if (isSpecial()) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const m = curMenu(), c = curCat();
  el.innerHTML = m.cats.map(x => {
    const s = catStats(x), all = !x.repeat && s.items > 0 && s.full === s.items;
    return `<button class="chip ${c && x.id === c.id ? 'on' : ''} ${all ? 'done-all' : ''}" data-act="cat" data-id="${esc(x.id)}"><span>${esc(x.icon)}</span>${esc(x.name)}<span class="mini">${x.repeat ? s.items : `${all ? '✓ ' : ''}${s.full}/${s.items}`}</span></button>`;
  }).join('') + `<button class="chip add" data-act="addCat">＋ add category</button>`;
}

const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// smaller places borrow their region's tag colour (Hanging Gardens green, Loftia City blue, Gridfall brick)
const PLACE_REGION = {
  'floating-village': 'hanging-gardens', 'central-lake': 'hanging-gardens', 'overgrowth': 'hanging-gardens', 'the-overgrowth': 'hanging-gardens',
  'the-grove': 'hanging-gardens', 'the-hills': 'hanging-gardens', 'bamboo-forest': 'hanging-gardens', 'secret-lake': 'hanging-gardens',
  'global-village': 'loftia-city', 'the-park': 'loftia-city', 'scrap-quarter': 'loftia-city',
  'museum': 'gridfall', 'historical-quarter': 'gridfall', 'concrete-jungle': 'gridfall'
};
// tag text that starts with one of these gets that look (FFXIV duties and side chains)
const BADGE_KIND = [['⚔️', 'dungeon'], ['🔥', 'trial'], ['↳', 'branch']];
const CURRENCY = { dew: '💧', bloom: '🌸' };
const CUR_NAME = { dew: 'Dew', bloom: 'Bloom' };
const priceRange = p => { const m = String(p).replace(/,/g, '').match(/(\d+)(?:\s*[–-]\s*(\d+))?/); return m ? [+m[1], +(m[2] || m[1])] : [0, 0]; };
const fmtRange = (a, b) => a === b ? a.toLocaleString('en-US') : `${a.toLocaleString('en-US')}–${b.toLocaleString('en-US')}`;
const priceTag = needs => needs.length ? needs.map(n => { const [nm, q] = splitQty(n); const ic = CURRENCY[nm.toLowerCase()]; return ic ? `${ic} ${q.toLocaleString('en-US')}` : esc(fmtQty(n)); }).join(' + ') : '?';
function levelCard(c, it, where) {
  const n = it.levels.length, maxed = it.lv >= n, nx = it.levels[it.lv];
  let track = '';
  it.levels.forEach((l, i) => {
    if (i) track += `<span class="lv-seg ${i < it.lv ? 'on' : ''}"></span>`;
    track += `<button class="lv-dot ${i < it.lv ? 'on' : ''}" data-act="lvl" data-id="${esc(it.id)}" data-i="${i}" title="${esc(l.label)}${l.needs.length ? ' · ' + esc(l.needs.map(fmtQty).join(' + ')) : ''}" aria-label="${esc(l.label)}${i < it.lv ? ' (done)' : ''}"></button>`;
  });
  return `<div class="item lvl-card ${maxed ? 'done' : ''} ${it.pinned ? 'pinned' : ''}">
    ${it.pinned && !it.price ? '<span class="fav-badge">📌</span>' : isWished(it) ? '<span class="fav-badge">💝</span>' : ''}
    <div class="lc-top">
      <div class="txt">${where ? `<div class="where">${where}</div>` : ''}<div class="nm">${esc(it.name)}</div>${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}${it.myNote ? `<div class="mynote">📝 ${esc(it.myNote)}</div>` : ''}</div>
      <div class="acts">
        <button class="pin ${it.pinned ? 'on' : ''}" data-act="pin" data-id="${esc(it.id)}" title="${it.pinned ? 'Unpin' : 'Pin — add the next upgrade to your gather list'}" aria-label="${it.pinned ? 'Unpin' : 'Pin'} ${esc(it.name)}">${it.pinned ? '📌' : '📍'}</button>
        ${canWish(it) ? `<button class="fav ${it.fav ? 'on' : ''}" data-act="fav" data-id="${esc(it.id)}" title="${it.fav ? 'Remove from wishlist' : 'Add to wishlist'}" aria-label="${it.fav ? 'Remove' : 'Add'} ${esc(it.name)} ${it.fav ? 'from' : 'to'} wishlist">${it.fav ? '💝' : '🤍'}</button>` : ''}
        <button data-act="editItem" data-id="${esc(it.id)}" title="Notes" aria-label="Edit ${esc(it.name)}">✏️</button>
      </div>
    </div>
    <div class="lc-bottom">
      <div class="lv-track" role="group" aria-label="${esc(it.name)}: tier ${it.lv} of ${n}">${track}</div>
      ${maxed ? `<span class="lc-up max">✨ maxed</span>` : `<button class="lc-up" data-act="lvlup" data-id="${esc(it.id)}" title="Bought it? Tap to move to ${esc(nx.label)}">${priceTag(nx.needs)}</button>`}
    </div>
  </div>`;
}
function itemCard(c, it, where) {
  if (it.levels && it.levels.length) return levelCard(c, it, where);
  const d = isDone(c, it);
  let tags = '', dots = '';
  if (it.levels && it.levels.length) {
    tags = `<div class="tiers">${it.levels.map((l, i) => {
      const st = i < it.lv ? 'done' : i === it.lv ? 'next' : '';
      return `<div class="tier ${st}"><span class="tier-n">${i < it.lv ? '✓' : i === it.lv ? '→' : '·'} ${esc(l.label)}</span><span class="tier-c">${l.needs.length ? l.needs.map(n => esc(fmtQty(n))).join(' + ') : 'cost not listed yet'}</span></div>`;
    }).join('')}</div>`;
    dots = `<div class="lv-dots" role="group" aria-label="${esc(it.name)} progress: ${it.lv} of ${it.levels.length}">${it.levels.map((l, i) => `<button class="lv-dot ${i < it.lv ? 'on' : ''}" data-act="lvl" data-id="${esc(it.id)}" data-i="${i}" title="${esc(l.label)}" aria-label="${esc(l.label)}${i < it.lv ? ' (done)' : ''}"></button>`).join('')}</div>`;
  } else if (it.parts.length) tags = `<div class="pips">${it.parts.map((p, i) => `<button class="pip part ${p.on ? 'on' : ''}" data-act="part" data-id="${esc(it.id)}" data-i="${i}" aria-pressed="${p.on}">${esc(p.label)}</button>`).join('')}</div>`;
  else if (c.pipLabels.length) tags = `<div class="pips">${c.pipLabels.map((p, i) => `<button class="pip ${it.pips[i] ? 'on' : ''}" data-act="pip" data-id="${esc(it.id)}" data-i="${i}" aria-pressed="${!!it.pips[i]}">${esc(p)}</button>`).join('')}</div>`;
  let status = '', locked = false, next = false;
  if (!d && it.after) {
    const dep = questDone(it.after);
    if (dep === false) { locked = true; status = `<div class="qs lock">🔒 after “${esc(it.after)}”</div>`; }
    else if (SHOW_AVAILABLE) status = `<div class="qs open">✨ available</div>`;
  }
  if (it.price) status = `<span class="qs price ${d ? 'got' : ''}">${d ? '✓ bought · ' : ''}${CURRENCY[it.cur] || ''} ${esc(it.price)}</span>` + status;
  if (it.badges && it.badges.length) status = it.badges.map(b => { const k = String(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); const kind = BADGE_KIND.find(x => String(b).startsWith(x[0])); return `<span class="qs badge badge-${esc(k)}${PLACE_REGION[k] ? ' badge-' + PLACE_REGION[k] : ''}${kind ? ' badge-' + kind[1] : ''}${/^Lv \d+$/.test(b) ? ' badge-lvnum' : ''}">${esc(b)}</span>`; }).join(' ') + status;
  if (it.pick) { const on = it.parts.filter(p => p.on).length; status += `<div class="qs pick">${Math.min(on, it.pick)}/${it.pick} — pick any ${it.pick}</div>`; }
  if (needsTurnIn(c, it)) {
    const ready = it.parts.every(p => p.on);
    const lbl = it.turned ? '✓ turned in' : ready ? '📦 turn in' : 'turn in';
    tags += `<button class="turnin ${it.turned ? 'done' : ready ? 'ready' : ''}" data-act="turnin" data-id="${esc(it.id)}" aria-pressed="${it.turned}" title="${it.turned ? 'Undo — not handed in yet' : ready ? 'Got everything — mark it handed in' : 'Mark it handed in (ticks every item too)'}">${lbl}</button>`;
  }
  if (c.repeat && !it.once && d && it.parts.length) tags += `<button class="turnin again" data-act="again" data-id="${esc(it.id)}" title="Untick the ingredients so you can make it again">🔁 make again</button>`;
  if (!d && !locked && c.ordered && c.items.find(x => !isDone(c, x)) === it) next = true;
  return `<div class="item ${d ? 'done' : ''} ${it.pinned ? 'pinned' : ''} ${locked ? 'locked' : ''} ${next ? 'next' : ''} ${dots ? 'has-levels' : ''}">${dots}
    ${next ? '<span class="next-badge">▶ next up</span>' : ''}
    ${it.pinned && !it.price ? '<span class="fav-badge">📌</span>' : isWished(it) ? '<span class="fav-badge">💝</span>' : ''}
    <button class="check" data-act="toggle" data-id="${esc(it.id)}" aria-label="${d ? 'Untick' : 'Tick'} ${esc(it.name)}">${CHECK_SVG}</button>
    <div class="txt">${where ? `<div class="where">${where}</div>` : ''}<div class="nm">${esc(it.name)}${SHOW_NEW_BADGES && NEW.has(it.id) ? '<span class="new-pill">new!</span>' : ''}${!it.official ? '<span class="mine">✎ mine</span>' : ''}</div>${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}${it.myNote ? `<div class="mynote">📝 ${esc(it.myNote)}</div>` : ''}${status}${tags}</div>
    <div class="acts">
      ${it.price ? '' : `<button class="pin ${it.pinned ? 'on' : ''}" data-act="pin" data-id="${esc(it.id)}" title="${it.pinned ? 'Unpin' : 'Pin — keep it in your Pinned tab'}" aria-label="${it.pinned ? 'Unpin' : 'Pin'} ${esc(it.name)}">${it.pinned ? '📌' : '📍'}</button>`}
      ${canWish(it) ? `<button class="fav ${it.fav ? 'on' : ''}" data-act="fav" data-id="${esc(it.id)}" title="${it.fav ? 'Remove from wishlist' : 'Add to wishlist'}" aria-label="${it.fav ? 'Remove' : 'Add'} ${esc(it.name)} ${it.fav ? 'from' : 'to'} wishlist">${it.fav ? '💝' : '🤍'}</button>` : ''}
      <button data-act="editItem" data-id="${esc(it.id)}" title="Edit / notes" aria-label="Edit ${esc(it.name)}">✏️</button>
    </div>
  </div>`;
}

function renderNeeded() {
  const v = $('#catView'), pins = allPinned(), hide = U.ui.hideDone;
  const shown = pins.filter(p => !hide || !isDone(p.c, p.it));
  const tally = new Map();
  const picks = [];
  pins.forEach(({ it }) => {
    if (it.levels.length) {
      const nx = it.levels[it.lv]; if (!nx) return;
      nx.needs.forEach(lbl => { const [n, q] = splitQty(lbl), k = n.toLowerCase(); const t = tally.get(k) || { n, q: 0, qtyKnown: /[×x]\s*\d+\s*$/i.test(lbl), for: [] }; t.q += q; t.for.push(`${it.name} → ${nx.label}`); tally.set(k, t); });
      return;
    }
    if (it.pick) {
      const left = it.pick - it.parts.filter(p => p.on).length;
      if (left > 0) picks.push({ name: it.name, left, opts: it.parts.filter(p => !p.on).map(p => p.label) });
      return;
    }
    it.parts.forEach(p => {
      if (p.on) return;
      const [n, q] = splitQty(p.label), k = n.toLowerCase();
      // a dish (e.g. a bin wants Fries) is cooked, not gathered — its recipe card is pinned alongside instead
      const r = DISHES.get(k);
      if (r && r.it !== it && r.it.pinned) return;
      const t = tally.get(k) || { n, q: 0, qtyKnown: /[×x]\s*\d+\s*$/i.test(p.label), for: [] };
      t.q += q; t.for.push(it.name); tally.set(k, t);
    });
  });

  const gather = [...tally.values()].sort((a, b) => a.n.localeCompare(b.n));
  const s = pins.reduce((a, p) => { const u = units(p.c, p.it); a.n += u[0]; a.t += u[1]; return a; }, { n: 0, t: 0 });
  const pct = s.t ? Math.round(s.n / s.t * 100) : 0;
  const groups = new Map();
  shown.forEach(p => { if (!groups.has(p.c.id)) groups.set(p.c.id, { m: p.m, c: p.c, items: [] }); groups.get(p.c.id).items.push(p.it); });
  const po = U.ui.pinOrder || [], rank = id => { const k = po.indexOf(id); return k < 0 ? 1e6 : k; };
  const grp = [...groups.values()].map((g, k) => [g, k]).sort((a, b) => rank(a[0].c.id) - rank(b[0].c.id) || a[1] - b[1]).map(x => x[0]); // your own section order
  v.innerHTML = `
    <div class="cat-head">
      <h2>📌 Pinned</h2>
      <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${s.n}/${s.t} · ${pct}%</span></div>
      ${pins.some(p => isDone(p.c, p.it)) ? `<button class="small-btn" data-act="unpinDone">✓ unpin finished</button>` : ''}
    </div>
    <div class="toolbar"><label class="toggle"><input type="checkbox" id="hideDone" ${hide ? 'checked' : ''}> hide done</label></div>
    ${pins.length === 0 ? `<div class="empty"><div class="big">📍</div>Nothing pinned yet!<br>Tap the <b>📍</b> on any quest, bundle or recipe to add it here — it's your “working on it right now” list. Pin a story quest and the pin hops to the next one when you finish it ✨</div>` : `
      ${gather.length || picks.length ? `<div class="gather"><div class="gather-h">🧺 Stuff to gather <span>${gather.length + picks.length} thing${gather.length + picks.length === 1 ? '' : 's'}</span></div>
        <div class="gather-list">${gather.map(g => `<span class="g" title="for: ${esc(g.for.join(', '))}">${esc(g.n)}${g.qtyKnown ? ` <b>×${g.q.toLocaleString('en-US')}</b>` : (g.for.length > 1 ? ` <b>(${g.for.length} bundles)</b>` : '')}</span>`).join('')}</div>
        ${picks.map(pk => `<div class="gather-pick"><b>${esc(pk.name)}:</b> any ${pk.left} more of ${esc(pk.opts.join(', '))}</div>`).join('')}
        <div class="hint">Unticked items from your pinned entries, added up. Tick them off on the cards below as you hand them in.</div></div>` : ''}
      ${grp.length ? `<div class="pin-grps">${grp.map((g, gi) => `<section class="pin-grp" data-cat="${esc(g.c.id)}"><div class="grp-h">${esc(g.c.icon)} ${esc(g.c.name)} <span>· ${esc(g.m.name)}</span>${grp.length > 1 ? `<span class="grp-move"><button data-act="grpMove" data-cat="${esc(g.c.id)}" data-dir="-1" ${gi ? '' : 'disabled'} aria-label="Move ${esc(g.c.name)} up">▲</button><button data-act="grpMove" data-cat="${esc(g.c.id)}" data-dir="1" ${gi < grp.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(g.c.name)} down">▼</button></span>` : ''}</div><div class="list">${g.items.map(it => itemCard(g.c, it)).join('')}</div></section>`).join('')}</div>` : ''}${grp.length ? '' : `<div class="empty"><div class="big">🎉</div>Everything you pinned is done!</div>`}
    `}`;
}

function wishGoals() {
  const goals = new Map();
  state.menus.forEach(m => m.cats.forEach(c => c.items.forEach(it => {
    if (!it.fav) return;
    const k = it.official && TWINS.has(it.name.toLowerCase()) ? 'n:' + it.name.toLowerCase() : 'i:' + it.id;
    const g = goals.get(k) || { name: it.name, members: [] };
    g.members.push({ m, c, it }); goals.set(k, g);
  })));
  return [...goals.values()].filter(g => g.members.some(x => canWish(x.it))).map(g => (g.done = g.members.every(x => isDone(x.c, x.it)), g));
}
function renderWish() {
  const v = $('#catView'), goals = wishGoals(), hide = U.ui.hideDone;
  const cost = {}, tally = new Map();
  const addCost = (cur, a, b) => { const x = cost[cur] = cost[cur] || [0, 0]; x[0] += a; x[1] += b; };
  goals.forEach(g => g.members.forEach(({ c, it }) => {
    if (isDone(c, it)) return;
    if (it.price) { const [a, b] = priceRange(it.price); addCost(it.cur, a, b); return; }
    if (it.levels.length) { // next tier of a permit
      const nx = it.levels[it.lv]; if (!nx) return;
      nx.needs.forEach(lbl => { const [n, q] = splitQty(lbl), k = n.toLowerCase(); if (CUR_NAME[k]) addCost(k, q, q); else { const t = tally.get(k) || { n, q: 0, qtyKnown: true, for: [] }; t.q += q; t.for.push(it.name + ' → ' + nx.label); tally.set(k, t); } });
      return;
    }
    it.parts.forEach(p => {
      if (p.on) return;
      const [n, q] = splitQty(p.label), k = n.toLowerCase();
      if (CUR_NAME[k]) { addCost(k, q, q); return; }
      const t = tally.get(k) || { n, q: 0, qtyKnown: /[×x]\s*\d+\s*$/i.test(p.label), for: [] };
      t.q += q; t.for.push(it.name); tally.set(k, t);
    });
  }));
  const gather = [...tally.values()].sort((a, b) => a.n.localeCompare(b.n));
  U.ui.have = U.ui.have || {};
  const curs = Object.keys(cost).sort((a, b) => (a === 'dew' ? -1 : 1));
  const savings = curs.map(cur => {
    const [lo, hi] = cost[cur], have = +U.ui.have[cur] || 0, pct = hi ? Math.min(100, Math.round(have / hi * 100)) : 100;
    const left = Math.max(0, hi - have);
    return `<div class="save-row">
      <div class="save-top"><b>${CURRENCY[cur]} ${CUR_NAME[cur]}</b><span>need <b>${fmtRange(lo, hi)}</b></span>
        <label class="have">I have <input type="number" min="0" inputmode="numeric" data-have="${cur}" value="${have || ''}" placeholder="0" aria-label="${CUR_NAME[cur]} you have"></label></div>
      <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${left ? `${left.toLocaleString('en-US')} to go` : 'you can afford it all! ✨'}</span></div>
    </div>`;
  }).join('');
  const done = goals.filter(g => g.done).length, pct = goals.length ? Math.round(done / goals.length * 100) : 0;
  const shown = goals.filter(g => !hide || !g.done);
  const groups = new Map();
  shown.forEach(g => g.members.forEach(p => { if (!groups.has(p.c.id)) groups.set(p.c.id, { m: p.m, c: p.c, items: [] }); groups.get(p.c.id).items.push(p.it); }));
  const order = new Map(); let i = 0; state.menus.forEach(m => m.cats.forEach(c => order.set(c.id, i++)));
  const rank = g => (g.c.currency ? 0 : 1e6) + order.get(g.c.id); // shops first: buy the blueprint, then craft
  const grp = [...groups.values()].sort((a, b) => rank(a) - rank(b));
  v.innerHTML = `
    <div class="cat-head">
      <h2>💝 Wishlist</h2>
      <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${done}/${goals.length} · ${pct}%</span></div>
      ${done ? `<button class="small-btn" data-act="unwishDone">✓ clear finished</button>` : ''}
    </div>
    <div class="toolbar"><label class="toggle"><input type="checkbox" id="hideDone" ${hide ? 'checked' : ''}> hide done</label></div>
    ${goals.length === 0 ? `<div class="empty"><div class="big">🤍</div>Your wishlist is empty!<br>Tap the <b>🤍</b> on anything in the 🛍️ Shops tab, or on a building permit. Wishing a blueprint adds its recipe too, so you see both the price and the materials ✨</div>` : `
      ${savings ? `<div class="savings"><div class="gather-h">🐷 Saving up <span>for the stuff you haven't bought yet</span></div>${savings}</div>` : ''}
      ${gather.length ? `<div class="gather"><div class="gather-h">🧺 Materials to craft it all <span>${gather.length} thing${gather.length === 1 ? '' : 's'}</span></div>
        <div class="gather-list">${gather.map(g => `<span class="g" title="for: ${esc(g.for.join(', '))}">${esc(g.n)}${g.qtyKnown ? ` <b>×${g.q.toLocaleString('en-US')}</b>` : ''}</span>`).join('')}</div>
        <div class="hint">Tick the blueprint when you buy it and the materials as you gather them — the totals shrink as you go.</div></div>` : ''}
      ${grp.map(g => `<div class="grp-h">${esc(g.c.icon)} ${esc(g.c.name)} <span>· ${esc(g.m.name)}</span></div><div class="list">${g.items.map(it => itemCard(g.c, it)).join('')}</div>`).join('') || `<div class="empty"><div class="big">🎉</div>Every wish came true!</div>`}
    `}`;
}

function renderCat() {
  if (isNeeded()) return renderNeeded();
  if (isWish()) return renderWish();
  const c = curCat(), v = $('#catView');
  if (!c) { v.innerHTML = `<div class="empty"><div class="big">🌤️</div>This menu has no categories yet — add one above!</div>`; return; }
  const s = catStats(c), pct = s.total ? Math.round(s.n / s.total * 100) : 0;
  const q = (U.ui.q || '').trim().toLowerCase();
  let items = c.items.slice();
  if (q) items = items.filter(it => (it.name + ' ' + it.note + ' ' + it.myNote + ' ' + it.parts.map(p => p.label).join(' ')).toLowerCase().includes(q));
  if (U.ui.hideDone) items = items.filter(it => !isDone(c, it));
  if (U.ui.pinOnly) items = items.filter(it => it.pinned);
  const sort = U.ui.sort;
  if (sort === 'az') items.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'todo') items.sort((a, b) => isDone(c, a) - isDone(c, b));
  else if (sort === 'fav') items.sort((a, b) => b.fav - a.fav);
  else if (sort === 'pin') items.sort((a, b) => b.pinned - a.pinned);
  const emptyMsg = c.items.length === 0
    ? `<div class="empty"><div class="big">🌱</div>No entries yet${c.official ? ' — this list is still being filled in' : '! Add them one at a time above, or paste a whole list with <b>⚙ Edit → Paste a list</b>'}.</div>`
    : U.ui.pinOnly && !q ? `<div class="empty"><div class="big">📍</div>Nothing pinned in ${esc(c.name)} yet — tap 📍 on anything you're working towards.</div>`
    : `<div class="empty"><div class="big">${U.ui.hideDone ? '🎉' : '🔍'}</div>${U.ui.hideDone && !q ? 'Everything here is done — yay!' : 'Nothing matches that search.'}</div>`;
  const choiceCats = curMenu().cats.filter(x => x.choice && x.choice === c.choice);
  const picker = c.choice && choiceCats.length > 1 ? `<div class="choice-bar"><b>Which city did you start in?</b><span>${choiceCats.map(x => `<button class="small-btn" data-act="pickChoice" data-id="${esc(x.id)}">${esc(x.icon)} ${esc(x.name.split(' · ').pop())}</button>`).join('')}</span><small>The other starting chains get tucked away (bring them back anytime from 🧺).</small></div>` : '';
  v.innerHTML = `${picker}
    <div class="cat-head">
      <h2>${esc(c.icon)} ${esc(c.name)}${c.reset ? `<span class="reset-pill" title="Ticks clear automatically">🔁 resets in ${fmtLeft(nextBoundary(c, Date.now()) - Date.now())}</span>` : ''}</h2>
      ${c.repeat ? `<span class="pct count-only">${s.items} recipe${s.items === 1 ? '' : 's'}</span>` : `<div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${s.n}/${s.total} · ${pct}%</span></div>`}
      ${c.reset && c.items.length ? `<button class="small-btn" data-act="pinAll">${c.items.every(it => it.pinned) ? 'unpin all' : '📌 pin all'}</button>` : ''}
      <button class="small-btn" data-act="editCat">⚙ Edit</button>
    </div>
    ${c.note ? `<div class="cat-note">${esc(c.note)}</div>` : ''}
    <div class="toolbar">
      <label class="search">🔍<input id="q" placeholder="search ${esc(c.name.toLowerCase())}…" value="${esc(U.ui.q || '')}" aria-label="Search"></label>
      <label class="toggle"><input type="checkbox" id="hideDone" ${U.ui.hideDone ? 'checked' : ''}> hide done</label>
      <label class="toggle"><input type="checkbox" id="pinOnly" ${U.ui.pinOnly ? 'checked' : ''}> 📌 only</label>
      <select class="sort" id="sort" aria-label="Sort">
        <option value="order" ${sort === 'order' ? 'selected' : ''}>list order</option>
        <option value="az" ${sort === 'az' ? 'selected' : ''}>A → Z</option>
        <option value="todo" ${sort === 'todo' ? 'selected' : ''}>to-do first</option>
        <option value="fav" ${sort === 'fav' ? 'selected' : ''}>💝 first</option>
        <option value="pin" ${sort === 'pin' ? 'selected' : ''}>📌 first</option>
      </select>
    </div>
    ${c.official ? '' : `<form class="add-row" id="addForm"><input id="newItem" placeholder="add to ${esc(c.name)}…  (tip: “Name - note”)" autocomplete="off" aria-label="Add an entry"><button type="submit">add</button></form>`}
    ${items.length ? `<div class="list">${items.map(it => itemCard(c, it)).join('')}</div>` : emptyMsg}`;
}

function renderBubble() {
  const b = $('#bubble');
  if (isWish()) {
    const g = wishGoals(), left = g.filter(x => !x.done).length;
    b.textContent = !g.length ? 'tap 🤍 on anything you dream of & i\'ll save up with you 💝' : left ? `${left} dream${left === 1 ? '' : 's'} on the list — keep farming 💸` : 'every wish came true!! 🎉';
    return;
  }
  if (isNeeded()) {
    const pins = allPinned(), left = pins.filter(p => !isDone(p.c, p.it)).length;
    b.textContent = !pins.length ? "pin what you're working on & i'll keep it here 📌" : left ? `${left} thing${left === 1 ? '' : 's'} on the go — you got this 🍊` : 'every pinned thing is done!! 🎉';
    return;
  }
  const c = curCat();
  if (!c || !c.items.length) { b.textContent = 'a fresh page! what shall we track? 🌸'; return; }
  const s = catStats(c), p = s.total ? s.n / s.total : 0;
  const lines = p >= 1 ? [`${c.name} complete!! you're amazing 🎉`, 'all done! time for a nap in the sun ☀️']
    : p >= .75 ? [`sooo close on ${c.name}! ✨`, 'almost there, keep going 💪']
    : p >= .4 ? ['over halfway-ish! 🍊', 'nice progress, friend 🌿']
    : p > 0 ? [`good start on ${c.name}! 🌱`, 'one tick at a time 🐾']
    : [`let's start ${c.name}! ☁️`, 'a brand-new adventure awaits ☁️'];
  b.textContent = lines[(s.n + c.name.length) % lines.length];
}

function renderDataInfo() {
  const src = (DATA.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`).join(' · ');
  $('#dataInfo').innerHTML = `<span>📦 lists v${esc(DATA.version)}${DATA.gameVersion ? ` · ${esc(DATA.gameVersion)}` : ''}</span>${src ? `<span>sources: ${src}</span>` : ''}`;
}

/* ---------- interactions ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || !state) return;
  const act = t.dataset.act;
  const hit = t.dataset.id && act !== 'menu' && act !== 'cat' ? locate(t.dataset.id) : null;
  if (act === 'menu') { U.ui.menu = t.dataset.id; U.ui.q = ''; save(); render(); }
  else if (act === 'cat') { U.ui.cat[curMenu().id] = t.dataset.id; U.ui.q = ''; save(); render(); }
  else if (act === 'toggle' && hit) {
    const before = isDone(hit.c, hit.it);
    if (hit.it.levels.length) hit.it.lv = before ? 0 : hit.it.lv + 1; // tiered: each tick climbs one tier
    else if (needsTurnIn(hit.c, hit.it) && before) hit.it.turned = false; // untick = not handed in yet (keeps what you gathered)
    else setAll(hit.c, hit.it, !before);
    afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it);
  }
  else if (act === 'lvlup' && hit) { const before = isDone(hit.c, hit.it); hit.it.lv = Math.min(hit.it.lv + 1, hit.it.levels.length); afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it); }
  else if (act === 'lvl' && hit) { const before = isDone(hit.c, hit.it), i = +t.dataset.i; hit.it.lv = hit.it.lv === i + 1 ? i : i + 1; afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it); }
  else if (act === 'pip' && hit) { const before = isDone(hit.c, hit.it), i = +t.dataset.i; hit.it.pips[i] = !hit.it.pips[i]; afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it); }
  else if (act === 'grpMove') {
    const ids = [...document.querySelectorAll('.pin-grps > .pin-grp')].map(x => x.dataset.cat), i = ids.indexOf(t.dataset.cat), j = i + +t.dataset.dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]]; savePinOrder(ids);
  }
  else if (act === 'pickChoice') {
    const m = curMenu(), pick = m.cats.find(x => x.id === t.dataset.id); if (!pick) return;
    persist(); m.cats.forEach(x => { if (x.choice === pick.choice && x !== pick) U.hidden.cats[x.id] = 1; });
    U.ui.cat[m.id] = pick.id; rebuild(); save(); render(); toast(`${pick.icon} ${pick.name.split(' · ').pop()} it is!`);
  }
  else if (act === 'again' && hit) { setAll(hit.c, hit.it, false); save(); render(); toast(`🔁 ready to make ${hit.it.name} again`); }
  else if (act === 'turnin' && hit) {
    const before = isDone(hit.c, hit.it);
    if (hit.it.turned) hit.it.turned = false; else { hit.it.turned = true; hit.it.parts.forEach(p => { p.on = true; }); }
    afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it);
  }
  else if (act === 'part' && hit) { const before = isDone(hit.c, hit.it), p = hit.it.parts[+t.dataset.i]; p.on = !p.on; afterChange(hit.c, before, isDone(hit.c, hit.it), t, hit.it); }
  else if (act === 'fav' && hit) {
    const on = !hit.it.fav; hit.it.fav = on;
    const t = TWINS.get(hit.it.name.toLowerCase()); // wishing a blueprint wishes its recipe too (and back)
    if (t && hit.it.official) [t.shop, t.craft].forEach(x => { if (x) x.it.fav = on; });
    save(); render(); toast(on ? '💝 added to your wishlist' : 'removed from wishlist');
  }
  else if (act === 'unwishDone') { wishGoals().forEach(g => { if (g.done) g.members.forEach(x => { x.it.fav = false; }); }); save(); render(); toast('tidied up ✨'); }
  else if (act === 'pin' && hit) {
    hit.it.pinned = !hit.it.pinned; hit.it.autoPin = false;
    const added = syncAutoPins(); save(); render();
    toast(hit.it.pinned ? (added ? `📌 pinned + ${added} recipe${added === 1 ? '' : 's'} to cook` : '📌 pinned!') : 'unpinned');
  }
  else if (act === 'pinAll') {
    const c = curCat(), all = c.items.every(it => it.pinned);
    c.items.forEach(it => { it.pinned = !all; it.autoPin = false; });
    const added = syncAutoPins(); save(); render();
    toast(all ? 'unpinned everything here' : `📌 pinned all${added ? ` + ${added} recipe${added === 1 ? '' : 's'} to cook` : ''}`);
  }
  else if (act === 'unpinDone') { allPinned().forEach(p => { if (isDone(p.c, p.it)) p.it.pinned = false; }); syncAutoPins(); save(); render(); toast('tidied up ✨'); }
  else if (act === 'editItem' && hit) openItemModal(hit);
  else if (act === 'editCat') openCatModal(curCat());
  else if (act === 'addCat') openCatModal(null);
  else if (act === 'addMenu') openMenuModal(null);
});
// games where the whole story is one long chain (FFXIV): after a category, carry on into the next one
function chainCats() { const out = []; state.menus.forEach(m => m.cats.forEach(c => { if (c.ordered) out.push(c); })); return out; }
function nextInChain(c) {
  const cs = chainCats(), i = cs.indexOf(c);
  for (const x of cs.slice(i + 1)) { if (x.choice) continue; const n = x.items.find(y => !isDone(x, y)); if (n) return n; }
  return null;
}
function doneUpTo(c, it) { // tick every quest in the chain up to (and including) this one
  const cs = chainCats(), undecided = g => cs.filter(x => x.choice === g).length > 1;
  let n = 0, hadPin = false;
  for (const x of cs) {
    if (x.choice && x !== c && undecided(x.choice)) continue; // starting city not picked yet: leave those alone
    let hit = false;
    for (const y of x.items) {
      if (!isDone(x, y)) { setAll(x, y, true); n++; }
      if (y.pinned) { y.pinned = false; hadPin = true; }
      if (y === it) { hit = true; break; }
    }
    if (hit) break;
  }
  if (hadPin) { const nx = c.items.find(y => !isDone(c, y)) || nextInChain(c); if (nx) nx.pinned = true; }
  return n;
}
function afterChange(c, before, after, el, it) {
  const all = c.items.length && catStats(c).full === c.items.length;
  // ordered chains (main story, character quests): a finished pinned quest hands its pin to the next one
  let moved = null;
  if (!before && after && it && it.pinned && c.ordered) {
    const next = c.items.find(x => x !== it && !isDone(c, x)) || (DATA.chain ? nextInChain(c) : null);
    it.pinned = false;
    if (next) { next.pinned = true; moved = next; }
  }
  save(); render();
  if (moved) setTimeout(() => toast(`📌 next up: ${moved.name}`), all ? 1600 : 350);
  if (!before && after) {
    const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 7);
    if (all) setTimeout(() => { burst(innerWidth / 2, innerHeight / 3, 26); toast(`🎉 ${c.name} complete!`); }, 150);
  }
}
/* put the sections on the Pinned page in your own order (▲ ▼) */
function savePinOrder(ids) {
  const keep = (U.ui.pinOrder || []).filter(id => !ids.includes(id)); // remember sections that aren't pinned right now too
  U.ui.pinOrder = ids.concat(keep); save(); renderCat();
}
document.addEventListener('input', e => {
  if (e.target.id === 'q') { U.ui.q = e.target.value; const pos = e.target.selectionStart; renderCat(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); }
});
document.addEventListener('change', e => {
  if (!state) return;
  if (e.target.id === 'hideDone') { U.ui.hideDone = e.target.checked; save(); renderCat(); }
  if (e.target.id === 'pinOnly') { U.ui.pinOnly = e.target.checked; save(); renderCat(); }
  if (e.target.id === 'sort') { U.ui.sort = e.target.value; save(); renderCat(); }
  if (e.target.dataset && e.target.dataset.have) { U.ui.have = U.ui.have || {}; U.ui.have[e.target.dataset.have] = Math.max(0, Math.floor(+e.target.value || 0)); save(); renderCat(); }
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'addForm') return;
  e.preventDefault();
  const v = $('#newItem').value.trim(); if (!v) return;
  curCat().items.push(parseLine(v)); save(); render(); $('#newItem').focus(); toast('added ✨');
});
function parseLine(line) { const m = line.split(/\s+[-–—|]\s+/); return customItem({ name: m[0].trim(), note: m.slice(1).join(' - ').trim() }); }
$('#menuSettingsBtn').onclick = () => { if (!state) return; if (isSpecial()) { toast('pick a menu tab to edit it 🙂'); return; } openMenuModal(curMenu()); };
$('#backupBtn').onclick = () => { if (state) openBackupModal(); };

/* ---------- modals ---------- */
const scrim = $('#scrim'), modal = $('#modal');
let lastFocus = null;
function openModal(html, mount) {
  lastFocus = document.activeElement;
  modal.innerHTML = html; scrim.classList.add('open'); mount && mount(modal);
  const f = modal.querySelector('input:not([type=checkbox]):not([type=file]),textarea'); setTimeout(() => (f || modal.querySelector('button')).focus(), 60);
}
function closeModal() { scrim.classList.remove('open'); modal.innerHTML = ''; if (lastFocus) lastFocus.focus(); }
scrim.addEventListener('mousedown', e => { if (e.target === scrim) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && scrim.classList.contains('open')) closeModal(); });
function askConfirm(title, msg, yesLabel, onYes) {
  openModal(`<h3>${esc(title)}</h3><p style="font-weight:600;color:var(--ink-soft);margin:0">${msg}</p>
    <div class="m-actions"><button class="btn ghost" data-m="no">never mind</button><button class="btn danger" data-m="yes">${esc(yesLabel)}</button></div>`, m => {
    m.querySelector('[data-m=no]').onclick = closeModal;
    m.querySelector('[data-m=yes]').onclick = () => { closeModal(); onYes(); };
  });
}
const emojiPicker = sel => `<div class="emoji-row">${EMOJIS.map(e => `<button type="button" class="${e === sel ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>`;
function wireEmoji(m, cb) { m.querySelectorAll('[data-emoji]').forEach(b => { b.onclick = () => { m.querySelectorAll('[data-emoji]').forEach(x => x.classList.remove('on')); b.classList.add('on'); cb(b.dataset.emoji); }; }); }

function openItemModal({ m: menu, c, it }) {
  if (it.official) {
    openModal(`<h3>📝 Notes</h3>
      <div class="ro-name">${esc(it.name)}</div>
      <div class="ro-hint">${it.note ? esc(it.note) + '<br>' : ''}This entry comes from the shared list, so it updates by itself — you can add your own note.</div>
      <div class="field"><label>My note</label><input id="iMy" value="${esc(it.myNote)}" placeholder="e.g. need to grow more tomatoes first"></div>
      <label class="toggle" style="height:44px"><input type="checkbox" id="iPin" ${it.pinned ? 'checked' : ''}> 📌 pin this</label>
      ${DATA.chain && c.ordered ? `<button class="btn" data-m="upto" style="margin-top:10px;width:100%">✓ I've done everything up to here</button>` : ''}
      <div class="m-actions"><button class="btn" data-m="hide">🙈 hide from my list</button><span style="flex:1"></span><button class="btn ghost" data-m="x">cancel</button><button class="btn primary" data-m="ok">save</button></div>`, m => {
      m.querySelector('[data-m=x]').onclick = closeModal;
      m.querySelector('[data-m=hide]').onclick = () => { persist(); U.hidden.items[it.id] = 1; rebuild(); save(); closeModal(); render(); toast('hidden — bring it back from 🧺'); };
      const up = m.querySelector('[data-m=upto]');
      if (up) up.onclick = () => { const n = doneUpTo(c, it); save(); closeModal(); render(); toast(n ? `✓ caught up — ticked ${n.toLocaleString('en-US')} quest${n === 1 ? '' : 's'}` : 'already all ticked ✨'); };
      const ok = () => { it.myNote = m.querySelector('#iMy').value.trim(); it.pinned = m.querySelector('#iPin').checked; save(); closeModal(); render(); };
      m.querySelector('[data-m=ok]').onclick = ok;
      m.querySelector('#iMy').onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
    return;
  }
  const others = menu.cats.filter(x => x.id !== c.id);
  const hasAfter = it.after || menu.cats.some(x => x.items.some(i => i.after));
  openModal(`<h3>✏️ Edit entry</h3>
    <div class="field"><label>Name</label><input id="iName" value="${esc(it.name)}"></div>
    <div class="field"><label>Note</label><input id="iNote" value="${esc(it.note)}" placeholder="where to find it, what it unlocks…"></div>
    ${hasAfter ? `<div class="field"><label>Unlocks after (quest name)</label><input id="iAfter" value="${esc(it.after)}" placeholder="leave blank if always available"></div>` : ''}
    <div class="field"><label>Needs (optional)</label><textarea id="iParts" placeholder="One per line, e.g.\nTomato ×2\nPlank">${esc(it.parts.map(p => p.label).join('\n'))}</textarea>
      <div class="hint">Each line becomes a tag you can tick. Add “×3” for amounts and they'll add up in 📌 Pinned.</div></div>
    <label class="toggle" style="height:44px;margin-bottom:6px"><input type="checkbox" id="iPin" ${it.pinned ? 'checked' : ''}> 📌 pin this</label>
    ${others.length ? `<div class="field"><label>Move to</label><select id="iMove" class="sort" style="width:100%"><option value="">— stay in ${esc(c.name)} —</option>${others.map(o => `<option value="${esc(o.id)}">${esc(o.icon)} ${esc(o.name)}</option>`).join('')}</select></div>` : ''}
    <div class="m-actions"><button class="btn danger" data-m="del">🗑 delete</button><span style="flex:1"></span><button class="btn ghost" data-m="x">cancel</button><button class="btn primary" data-m="ok">save</button></div>`, m => {
    m.querySelector('[data-m=x]').onclick = closeModal;
    m.querySelector('[data-m=del]').onclick = () => { c.items = c.items.filter(x => x !== it); save(); closeModal(); render(); toast('deleted'); };
    const ok = () => {
      const n = m.querySelector('#iName').value.trim(); if (!n) return;
      it.name = n; it.note = m.querySelector('#iNote').value.trim(); it.pinned = m.querySelector('#iPin').checked;
      const af = m.querySelector('#iAfter'); if (af) it.after = af.value.trim();
      const wasDone = isDone(c, it), old = new Map(it.parts.map(p => [p.label.toLowerCase(), p.on]));
      it.parts = m.querySelector('#iParts').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => ({ label: l, on: old.has(l.toLowerCase()) ? old.get(l.toLowerCase()) : wasDone }));
      const mv = m.querySelector('#iMove');
      if (mv && mv.value) { const dest = menu.cats.find(x => x.id === mv.value); c.items = c.items.filter(x => x !== it); dest.items.push(it); toast(`moved to ${dest.name}`); }
      save(); closeModal(); render();
    };
    m.querySelector('[data-m=ok]').onclick = ok;
    m.querySelectorAll('input:not([type=checkbox])').forEach(i => { i.onkeydown = e => { if (e.key === 'Enter') ok(); }; });
  });
}

function resetFields(c) {
  return `<div class="field"><label>Auto-reset ticks</label>
    <div class="row">
      <select id="cReset" class="sort"><option value="">never</option><option value="daily" ${c && c.reset === 'daily' ? 'selected' : ''}>every day</option><option value="weekly" ${c && c.reset === 'weekly' ? 'selected' : ''}>every week</option></select>
      <select id="cDay" class="sort">${WEEKDAYS.map((d, i) => `<option value="${i}" ${(c && c.resetDay != null ? c.resetDay : 1) === i ? 'selected' : ''}>on ${d}</option>`).join('')}</select>
      <select id="cHour" class="sort">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${((c && c.resetHour) || 0) === h ? 'selected' : ''}>at ${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}</option>`).join('')}</select>
    </div><div class="hint">Your local time — match it to the game's server reset.</div></div>`;
}
function openCatModal(c) {
  const isNew = !c, official = c && c.official; let icon = c ? c.icon : '⭐';
  const menu = curMenu();
  openModal(`<h3>${isNew ? '🌸 New category' : '⚙ ' + esc(c.name)}</h3>
    <div class="field"><label>Name</label><input id="cName" value="${esc(c ? c.name : '')}" placeholder="e.g. Baking, Furniture, Bugs…"></div>
    <div class="field"><label>Icon</label>${emojiPicker(icon)}</div>
    ${resetFields(c)}
    ${official ? '' : `<div class="field"><label>Condition / tier tags (optional)</label><input id="cPips" value="${esc(c ? c.pipLabels.join(', ') : '')}" placeholder="e.g. Battered, Used, Spotless">
      <div class="hint">Comma-separated. Each entry gets little tags to tick. Leave blank for a simple checkbox.</div></div>`}
    <div class="field"><label>Paste a list${isNew ? '' : ' (adds your own entries)'}</label><textarea id="cBulk" placeholder="One per line. Add a note after a dash:\nMiso Soup - needs soybeans\nCroissant"></textarea></div>
    ${isNew ? '' : `<div class="m-sec"><div class="row">
      <button class="btn" data-m="uncheck">↺ untick everything</button>
      <button class="btn" data-m="left">◀ move left</button>
      <button class="btn" data-m="right">move right ▶</button>
      ${official ? '<button class="btn" data-m="hide">🙈 hide category</button>' : '<button class="btn danger" data-m="del">🗑 delete category</button>'}
    </div>${official ? '<div class="hint" style="margin-top:8px">This is a shared list — it updates by itself. Renaming only changes it for you.</div>' : ''}</div>`}
    <div class="m-actions"><button class="btn ghost" data-m="x">cancel</button><button class="btn primary" data-m="ok">${isNew ? 'create' : 'save'}</button></div>`, m => {
    wireEmoji(m, e => { icon = e; });
    const sync = () => { const v = m.querySelector('#cReset').value; m.querySelector('#cDay').style.display = v === 'weekly' ? '' : 'none'; m.querySelector('#cHour').style.display = v ? '' : 'none'; };
    m.querySelector('#cReset').onchange = sync; sync();
    m.querySelector('[data-m=x]').onclick = closeModal;
    m.querySelector('[data-m=ok]').onclick = () => {
      const name = m.querySelector('#cName').value.trim(); if (!name) { m.querySelector('#cName').focus(); return; }
      const pipsEl = m.querySelector('#cPips');
      const pips = pipsEl ? pipsEl.value.split(',').map(s => s.trim()).filter(Boolean) : null;
      const bulk = m.querySelector('#cBulk').value.split('\n').map(s => s.trim()).filter(Boolean).map(parseLine);
      const rs = m.querySelector('#cReset').value, rh = +m.querySelector('#cHour').value, rd = +m.querySelector('#cDay').value;
      let target = c;
      if (isNew) { target = customCat({ name, icon, pipLabels: pips || [] }); menu.cats.push(target); U.ui.cat[menu.id] = target.id; }
      else {
        target.name = name; target.icon = icon;
        if (pips && pips.join('|') !== target.pipLabels.join('|')) {
          target.items.forEach(it => {
            if (it.parts.length) return;
            if (!target.pipLabels.length) it.pips = pips.map(() => it.done);
            else if (!pips.length) it.done = target.pipLabels.every((_, i) => it.pips[i]);
            else it.pips = pips.map((_, i) => !!it.pips[i]);
          });
          target.pipLabels = pips;
        }
      }
      if (target.reset !== rs || (rs && (target.resetHour !== rh || target.resetDay !== rd))) { target.lastReset = Date.now(); target.resetUtcHour = null; target.userReset = true; }
      target.reset = rs; target.resetHour = rh; target.resetDay = rd;
      target.items.push(...bulk);
      save(); closeModal(); render();
      toast(bulk.length ? `added ${bulk.length} entr${bulk.length === 1 ? 'y' : 'ies'} ✨` : (isNew ? 'category created 🌸' : 'saved'));
    };
    if (!isNew) {
      const cats = menu.cats, idx = () => cats.indexOf(c);
      const move = d => { const i = idx(), j = i + d; if (j < 0 || j >= cats.length) return; cats.splice(i, 1); cats.splice(j, 0, c); U.orderCustom.cats[menu.id] = true; save(); render(); };
      m.querySelector('[data-m=left]').onclick = () => move(-1);
      m.querySelector('[data-m=right]').onclick = () => move(1);
      m.querySelector('[data-m=uncheck]').onclick = () => askConfirm('Untick everything?', `All ticks in <b>${esc(c.name)}</b> will be cleared (entries stay).`, 'untick all', () => { c.items.forEach(it => setAll(c, it, false)); save(); render(); toast('fresh start ☀️'); });
      const hide = m.querySelector('[data-m=hide]');
      if (hide) hide.onclick = () => askConfirm('Hide category?', `<b>${esc(c.name)}</b> will be hidden for you. Your ticks are kept — bring it back anytime from 🧺.`, 'hide it', () => { persist(); U.hidden.cats[c.id] = 1; rebuild(); save(); render(); });
      const del = m.querySelector('[data-m=del]');
      if (del) del.onclick = () => askConfirm('Delete category?', `<b>${esc(c.name)}</b> and its ${c.items.length} entries will be gone for good.`, 'delete it', () => { menu.cats = cats.filter(x => x !== c); save(); render(); toast('category deleted'); });
    }
  });
}

function openMenuModal(menu) {
  const isNew = !menu, official = menu && menu.official;
  let icon = menu ? menu.icon : '⭐', color = menu ? (menu.color || 0) : state.menus.length % MENU_COLORS.length;
  openModal(`<h3>${isNew ? '🗂 New menu' : '⚙ Edit “' + esc(menu.name) + '” menu'}</h3>
    <div class="field"><label>Menu name</label><input id="mName" value="${esc(menu ? menu.name : '')}" placeholder="e.g. Pets, Outfits, Goals…"></div>
    <div class="field"><label>Icon</label>${emojiPicker(icon)}</div>
    <div class="field"><label>Colour</label><div class="emoji-row">${MENU_COLORS.map((c, i) => `<button type="button" class="${i === color ? 'on' : ''}" data-color="${i}" style="background:${c[0]}" aria-label="Colour ${i + 1}"></button>`).join('')}</div></div>
    ${isNew ? '' : `<div class="m-sec"><div class="row">
      <button class="btn" data-m="left">◀ move left</button><button class="btn" data-m="right">move right ▶</button>
      ${official ? '<button class="btn" data-m="hide">🙈 hide menu</button>' : '<button class="btn danger" data-m="del">🗑 delete menu</button>'}</div></div>`}
    <div class="m-actions"><button class="btn ghost" data-m="x">cancel</button><button class="btn primary" data-m="ok">${isNew ? 'create' : 'save'}</button></div>`, m => {
    wireEmoji(m, e => { icon = e; });
    m.querySelectorAll('[data-color]').forEach(b => { b.onclick = () => { m.querySelectorAll('[data-color]').forEach(x => x.classList.remove('on')); b.classList.add('on'); color = +b.dataset.color; }; });
    m.querySelector('[data-m=x]').onclick = closeModal;
    m.querySelector('[data-m=ok]').onclick = () => {
      const name = m.querySelector('#mName').value.trim(); if (!name) return;
      if (isNew) { const nm = customMenu({ name, icon, color, cats: [{ name: 'General', icon: '⭐' }] }); state.menus.push(nm); U.ui.menu = nm.id; }
      else { menu.name = name; menu.icon = icon; menu.color = color; }
      save(); closeModal(); render();
    };
    if (!isNew) {
      const move = d => { const i = state.menus.indexOf(menu), j = i + d; if (j < 0 || j >= state.menus.length) return; state.menus.splice(i, 1); state.menus.splice(j, 0, menu); U.orderCustom.menus = true; save(); render(); };
      m.querySelector('[data-m=left]').onclick = () => move(-1);
      m.querySelector('[data-m=right]').onclick = () => move(1);
      const hide = m.querySelector('[data-m=hide]');
      if (hide) hide.onclick = () => askConfirm('Hide menu?', `<b>${esc(menu.name)}</b> will be hidden for you. Ticks are kept — bring it back from 🧺.`, 'hide it', () => { persist(); U.hidden.menus[menu.id] = 1; U.ui.menu = null; rebuild(); save(); render(); });
      const del = m.querySelector('[data-m=del]');
      if (del) del.onclick = () => askConfirm('Delete menu?', `<b>${esc(menu.name)}</b> and everything in it will be removed.`, 'delete it', () => { state.menus = state.menus.filter(x => x !== menu); U.ui.menu = null; save(); render(); });
    }
  });
}

/* ---------- backup / restore ---------- */
function backupPayload() { persist(); return JSON.stringify({ kind: 'satele-logbook', game: GAME, savedAt: new Date().toISOString(), data: U }); }
function applyBackup(text) {
  let obj; try { obj = JSON.parse(text); } catch (e) { return "hmm, that doesn't look like a backup 🥲"; }
  if (obj && obj.kind === 'satele-logbook') {
    if (obj.game && obj.game !== GAME) return `that backup is for ${obj.game}, not ${GAME} 🙃`;
    const known = U.known; U = normalizeUser(obj.data); if (!U.known.length) U.known = known;
    rebuild(); checkResets(); save(); render(); return null;
  }
  if (obj && Array.isArray(obj.menus)) { const n = importLegacy(obj); save(); render(); toast(`imported ${n} entries from your old logbook 🌈`); return null; }
  return "hmm, that doesn't look like a backup 🥲";
}
// Old single-page Loftia Logbook backups: match by category + entry name.
function importLegacy(old) {
  const norm = s => String(s || '').trim().toLowerCase();
  let n = 0;
  old.menus.forEach(om => (om.cats || []).forEach(oc => {
    let target = null;
    for (const m of state.menus) { const c = m.cats.find(x => norm(x.name) === norm(oc.name)); if (c && (!target || norm(m.name) === norm(om.name))) target = c; }
    (oc.items || []).forEach(oi => {
      const parts = (oi.parts || []).filter(p => p.on).map(p => partKey(p.label));
      const touched = oi.done || oi.pinned || oi.fav || parts.length || (oi.pips || []).some(Boolean);
      const it = target && target.items.find(x => norm(x.name) === norm(oi.name));
      if (it) {
        if (oi.done && !it.parts.length && !target.pipLabels.length) it.done = true;
        if (oi.pinned) it.pinned = true;
        if (oi.fav) it.fav = true;
        it.parts.forEach(p => { if (parts.includes(partKey(p.label))) p.on = true; });
        if (target.pipLabels.length && oi.pips) it.pips = target.pipLabels.map((_, i) => !!oi.pips[i] || !!oi.done);
        if (it.parts.length && oi.done && !parts.length) it.parts.forEach(p => { p.on = true; });
        if (touched) n++;
      } else if (target) {
        target.items.push(customItem({ name: oi.name, note: oi.note, after: oi.after, parts: oi.parts, pips: oi.pips, done: oi.done, pinned: oi.pinned, fav: oi.fav })); n++;
      }
    });
  }));
  return n;
}
function openBackupModal() {
  const hiddenCount = Object.keys(U.hidden.items).length + Object.keys(U.hidden.cats).length + Object.keys(U.hidden.menus).length;
  openModal(`<h3>🧺 Backup, restore &amp; settings</h3>
    <p class="hint" style="margin:-6px 0 12px">Your progress is saved only in this browser. Download a backup to keep it safe or move it to another device.</p>
    <div class="row"><button class="btn primary" data-m="dl">⬇ download backup</button><button class="btn" data-m="copy">📋 copy backup</button></div>
    <div class="m-sec field"><label>Restore</label>
      <div class="row"><label class="btn" style="cursor:pointer">📂 choose a backup file<input type="file" id="bFile" accept=".json,application/json" class="sr-only"></label></div>
      <textarea id="bIn" placeholder="…or paste a backup here (old Loftia Logbook backups work too!)" style="margin-top:8px"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" data-m="load">⤴ restore pasted backup</button></div></div>
    <div class="m-sec row">
      ${hiddenCount ? `<button class="btn" data-m="unhide">👀 show ${hiddenCount} hidden thing${hiddenCount === 1 ? '' : 's'}</button>` : ''}
      <button class="btn danger" data-m="reset">reset all my progress</button>
    </div>
    <div class="m-actions"><button class="btn ghost" data-m="x">close</button></div>`, m => {
    m.querySelector('[data-m=x]').onclick = closeModal;
    m.querySelector('[data-m=dl]').onclick = () => {
      const blob = new Blob([backupPayload()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `${GAME}-logbook-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('backup downloaded 💾');
    };
    m.querySelector('[data-m=copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(backupPayload()); toast('copied! 📋'); }
      catch (e) { const ta = m.querySelector('#bIn'); ta.value = backupPayload(); ta.focus(); ta.select(); toast('selected — press Ctrl/Cmd + C'); }
    };
    m.querySelector('#bFile').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 5e6) { toast('that file is too big to be a backup 🤔'); return; }
      f.text().then(t => { const err = applyBackup(t); if (err) toast(err); else { closeModal(); toast('restored 🌈'); } });
    };
    m.querySelector('[data-m=load]').onclick = () => { const err = applyBackup(m.querySelector('#bIn').value); if (err) toast(err); else { closeModal(); toast('restored 🌈'); } };
    const un = m.querySelector('[data-m=unhide]');
    if (un) un.onclick = () => { persist(); U.hidden = freshUser().hidden; rebuild(); save(); closeModal(); render(); toast('everything is back 👀'); };
    m.querySelector('[data-m=reset]').onclick = () => askConfirm('Reset everything?', 'All your ticks, pins, notes and your own entries will be cleared. (Tip: download a backup first!)', 'reset', () => {
      const known = U.known; U = freshUser(); U.known = known; U.dataVersion = DATA.version; rebuild(); checkResets(); save(); render(); toast('fresh logbook 📒');
    });
  });
}

/* ---------- cute bits ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }
function burst(x, y, n) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const bits = ['✨', '💖', '⭐', '🌸', '💫', '🍊'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span'); s.className = 'confetti'; s.textContent = bits[i % bits.length];
    const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * (n > 10 ? 160 : 50);
    s.style.left = x + 'px'; s.style.top = y + 'px';
    s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', (Math.sin(a) * d - 20) + 'px'); s.style.setProperty('--r', (Math.random() * 240 - 120) + 'deg');
    document.body.appendChild(s); setTimeout(() => s.remove(), 950);
  }
}

/* ---------- boot ---------- */
function showWarn(html) { $('#warn').innerHTML = `<div class="warn-bar">${html}</div>`; }
async function boot() {
  if (!storageOK) showWarn('⚠️ Your browser is blocking storage (private window?) — ticks won\'t be kept after you close this tab. Use 🧺 to download a backup.');
  try {
    const r = await fetch(`/data/${encodeURIComponent(GAME)}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    DATA = await r.json();
  } catch (e) {
    $('#catView').innerHTML = `<div class="empty"><div class="big">🌧️</div>Couldn't load the ${esc(GAME)} lists. Check your connection and refresh.</div>`;
    $('#bubble').textContent = 'uh oh, the clouds got in the way ☁️';
    return;
  }
  refreshBins();
  indexData();
  applyMoves();
  if (DATA.name) { $('#gameTitle').textContent = `${DATA.name} Logbook`; }

  // what's new since last visit?
  const allIds = Object.keys(IDX.items);
  if (U.known.length) { const k = new Set(U.known); allIds.forEach(id => { if (!k.has(id)) NEW.add(id); }); }
  const updated = U.dataVersion && U.dataVersion !== DATA.version;
  U.known = allIds; U.dataVersion = DATA.version;

  rebuild(); checkResets(); syncAutoPins(); save();
  render(); renderDataInfo();
  if (SHOW_NEW_BADGES && NEW.size) setTimeout(() => toast(`✨ ${NEW.size} new entr${NEW.size === 1 ? 'y' : 'ies'} added since your last visit!`), 500);
  else if (updated) setTimeout(() => toast('📦 lists updated — your progress is safe!'), 500);

  // other tabs of this site
  window.addEventListener('storage', e => {
    if (e.key !== KEY || !e.newValue) return;
    try { U = normalizeUser(JSON.parse(e.newValue)); rebuild(); render(); } catch (err) { /* ignore */ }
  });
  // dailies + countdown
  setInterval(() => {
    if (checkResets()) { save(); refreshBins(); indexData(); rebuild(); syncAutoPins(); save(); render(); toast('🔁 new day — fresh dailies & bin requests!'); return; }
    const c = !isSpecial() && curCat(), p = document.querySelector('.reset-pill');
    if (c && c.reset && p) p.textContent = '🔁 resets in ' + fmtLeft(nextBoundary(c, Date.now()) - Date.now());
  }, 60000);
}
boot();
})();