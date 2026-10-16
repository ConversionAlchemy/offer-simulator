"use strict";

/* ---------- settings ---------- */

const STORE_KEY = "ca-offer-sim-v4";
const MAX_OFFERS = 8;
// Split-test colours: the control in blue, every variant a shade of pink (dark and light alternate so neighbouring lines stay apart).
const CONTROL = "#1a5cff";
const COLORS = [CONTROL, "#ff00d9", "#9c0086", "#ff70e6", "#d4009a", "#5f0052", "#ff3db5", "#e09bd6", "#b3006b"];

const STORE_FIELDS = [
  { k: "fee", label: "Payment fees", suffix: "%" },
  { k: "refund", label: "Refund rate", suffix: "%" },
  { k: "shipFirst", label: "Fulfilment per order", money: true },
  { k: "currency", label: "Currency symbol", text: true }
];

/* ---------- state ---------- */

let uid = Date.now() % 100000;
const newId = p => p + (uid++).toString(36);

function blankState() {
  return {
    version: 4, palette: 2, example: false, axis: "cvr",
    store: { spend: 0, cvr: 0, cpc: 0, fee: 2.9, refund: 0, shipFirst: 0, currency: "$" },
    offers: []
  };
}

function exampleState() {
  const s = blankState();
  s.example = true;
  s.store = { spend: 30000, cvr: 3, cpc: 0.6, fee: 2.9, refund: 3, shipFirst: 5.8, currency: "$" };
  const base = { price: 34.99, unit: 4.2, ship: 4.99 };
  const mk = (id, name, color, preset, v, conv, reorder) => ({ id, name, color, conv, reorder, reorders: 1, spec: { preset, v: Object.assign({}, base, v) } });
  s.offers = [
    mk("o0", "Current offer", COLORS[0], "price", {}, 0, 20),
    mk("o1", "20% off", COLORS[1], "pct", { pct: 20 }, 18, 20),
    mk("o2", "Buy 2, get 1 free", COLORS[2], "bxgy", { buy: 2, get: 1, ship: 0 }, -15, 10),
    mk("o3", "Price $39.99", COLORS[3], "price", { price: 39.99 }, -6, 20),
    mk("o4", "Subscribe and save 15%", COLORS[4], "sub", { pct: 15, share: 40, churn: 25, subShip: 0, other: 20 }, 4, 0)
  ];
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.offers)) {
        const st = Object.assign(blankState(), p);
        // older saves used a rainbow; recolour them as control and variants
        if (p.palette !== 2) { st.offers.forEach((o, i) => { o.color = COLORS[i === 0 ? 0 : 1 + ((i - 1) % (COLORS.length - 1))]; }); st.palette = 2; }
        return st;
      }
    }
  } catch {}
  return exampleState();
}
let state = load();
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }

/* ---------- maths: ad costs stay fixed, so this is pure break-even analysis ---------- */

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = x => Math.round(n(x) * 100) / 100;
const netOf = (pays, st = state.store) => n(pays) * (1 - Math.min(100, n(st.refund)) / 100);

// What one order leaves after refunds, payment fees and every cost to fulfil it, before ads.
function leavesOf(pays, cost, st = state.store) {
  const net = netOf(pays, st);
  return net - n(cost) - net * n(st.fee) / 100;
}
// What a new customer is worth over 90 days: the first order plus any reorders.
function calc(o) {
  const leaves = leavesOf(o.pays, o.cost);
  const rLeaves = o.repeatLeaves === undefined || o.repeatLeaves === null ? leaves : o.repeatLeaves;
  const rPays = o.repeatPays === undefined || o.repeatPays === null ? n(o.pays) : o.repeatPays;
  const repeats = n(o.reorder) / 100 * Math.max(0, n(o.reorders));
  // value: what a new customer leaves over 90 days; extra: the part that comes from reorders
  return { leaves, value: leaves + repeats * rLeaves, extra: repeats * rLeaves, revenue: netOf(o.pays) + repeats * netOf(rPays) };
}
const visitors = () => (n(state.store.cpc) > 0 ? n(state.store.spend) / n(state.store.cpc) : 0);
const expectedCvr = o => n(state.store.cvr) * (1 + n(o.conv) / 100);
// Contribution profit a month, after ads, at a given conversion rate (in %).
const profitAt = (v, cvr) => visitors() * cvr / 100 * v - n(state.store.spend);
// The conversion rate an offer needs just to cover its ad cost.
const breakEvenCvr = v => (v > 0 && n(state.store.cpc) > 0 ? n(state.store.cpc) / v * 100 : NaN);
// The ROAS your ad platform has to report (first-order revenue over ad spend) for this offer to break even.
// Break-even ROAS is judged on the first order, as the training teaches: reorders don't pay back ad spend on the day.
const breakEvenRoas = o => { const v = calc(o).leaves; return v > 0 ? n(o.pays) / v : NaN; };
// Where the offer stops losing money once 90-day reorders are counted (the ring on the chart).
const breakEvenRoas90 = o => { const v = calc(o).value; return v > 0 ? n(o.pays) / v : NaN; };
const roasAt = (o, cvr) => (n(state.store.cpc) > 0 ? cvr / 100 * n(o.pays) / n(state.store.cpc) : NaN);
const expectedRoas = o => roasAt(o, expectedCvr(o));
// How far conversion can fall from what you expect before the offer loses money.
const safetyOf = o => { const be = breakEvenCvr(calc(o).value), c = expectedCvr(o); return Number.isFinite(be) && c > 0 ? 1 - be / c : NaN; };

/* ---------- offer types: each one works out what the customer pays and what it costs you ---------- */

// Every type starts from the item's price and cost and the shipping charged.
function order(st, v, lines, opt = {}) {
  let units = 0, items = 0, cogs = 0;
  lines.forEach(l => { const q = Math.max(0, n(l.qty)); units += q; items += q * n(l.price); cogs += q * n(l.cost); });
  const paid = Math.max(0, items * (1 - n(opt.pct) / 100) - n(opt.off));
  // fulfilment per order, plus whatever each extra item adds for offers that ship more than one
  const fulfil = units ? n(st.shipFirst) + n(v.extraShip) * (units - 1) : 0;
  return { pays: paid + n(v.ship), cost: cogs + fulfil + n(opt.extra), items: paid };
}
const item = (v, qty = 1, price) => ({ qty, price: price === undefined ? v.price : price, cost: v.unit });
const one = (st, v, opt) => order(st, v, [item(v)], opt);

const F = {
  money: (k, label, def) => ({ k, label, type: "money", def: typeof def === "function" ? def : () => def }),
  pct: (k, label, def) => ({ k, label, type: "pct", def: () => def }),
  int: (k, label, def) => ({ k, label, type: "int", def: () => def })
};
// asked only on offers that put more than one item in the box
const EXTRA_SHIP = F.money("extraShip", "Fulfilment per extra item", 0);
const BASE = [F.money("price", "Price per item", 0), F.money("unit", "Your cost per item", 0), F.money("ship", "Shipping charged", 0)];
const nn = x => Math.max(0, Math.round(x) - 0.01);

// Subscription fields, shared by every subscription template, in your training's terms.
const SUB = {
  pct: F.pct("pct", "Subscriber discount", 15),
  share: F.pct("share", "Take rate: buyers who pick the subscription", 40),
  churn: F.pct("churn", "Churn: subscribers who cancel each month", 25),
  gift: F.money("gift", "Welcome gift cost to you", 3),
  subShip: F.money("subShip", "Shipping charged to subscribers", 0)
};
const clampPct = x => Math.min(1, Math.max(0, n(x) / 100));
// A cohort of new customers at a subscription buy box, followed for 90 days (3 months).
// Some pick a subscription plan and renew until they cancel; the rest buy once and some reorder, like the control's customers.
function subscription(st, v, o) {
  const s = clampPct(v.share), keep = 1 - clampPct(v.churn);
  const segs = [];
  o.plans.forEach(p => {
    if (!(p.w > 0) || !(s > 0)) return;
    const first = order(st, Object.assign({}, v, { ship: v.subShip }), [item(v, p.qty)], { pct: p.pct, extra: n(o.gift) });
    const renew = order(st, Object.assign({}, v, { ship: v.subShip }), [item(v, p.qty)], { pct: p.pct });
    const probs = [];
    for (let m = p.every; m < 3; m += p.every) probs.push(Math.pow(keep, m));
    segs.push({ w: s * p.w, first, renew, probs });
  });
  if (s < 1) {
    const otp = order(st, v, [item(v, o.otpQty || 1)]);
    segs.push({ w: 1 - s, first: otp, renew: otp, probs: [clampPct(v.other === undefined ? 10 : v.other)] });
  }
  let pays = 0, cost = 0, total = 0, leaves = 0, rpays = 0, returning = 0;
  segs.forEach(g => {
    pays += g.w * g.first.pays;
    cost += g.w * g.first.cost;
    const r = g.probs.reduce((a, b) => a + b, 0);
    total += g.w * r;
    leaves += g.w * r * leavesOf(g.renew.pays, g.renew.cost, st);
    rpays += g.w * r * g.renew.pays;
    returning += g.w * (g.probs[0] || 0);
  });
  return { pays, cost, reorder: returning * 100, reorders: returning > 0 ? total / returning : 0,
    repeatLeaves: total > 0 ? leaves / total : 0, repeatPays: total > 0 ? rpays / total : 0 };
}

const TYPES = [
  { g: "Price", k: "price", label: "Price only", fields: [],
    name: v => "Price " + money(v.price), build: (st, v) => one(st, v) },
  { g: "Price", k: "urgency", label: "Same deal, with urgency or scarcity", fields: [],
    name: () => "Countdown offer", build: (st, v) => one(st, v) },
  { g: "Discounts", k: "pct", label: "% off", fields: [F.pct("pct", "Discount", 20)],
    name: v => n(v.pct) + "% off", build: (st, v) => one(st, v, { pct: v.pct }) },
  { g: "Discounts", k: "off", label: "Money off", fields: [F.money("off", "Amount off", 10)],
    name: v => money(v.off) + " off", build: (st, v) => one(st, v, { off: v.off }) },
  { g: "Quantity and bundles", k: "bxgy", label: "Buy X, get Y free", fields: [F.int("buy", "Buy", 2), F.int("get", "Get free", 1), EXTRA_SHIP],
    name: v => "Buy " + n(v.buy) + ", get " + n(v.get) + " free", build: (st, v) => order(st, v, [item(v, v.buy), item(v, v.get, 0)]) },
  { g: "Quantity and bundles", k: "bxgyp", label: "Buy X, get Y at % off", fields: [F.int("buy", "Buy", 1), F.int("get", "Get", 1), F.pct("pct", "Off those", 50), EXTRA_SHIP],
    name: v => "Buy " + n(v.buy) + ", get " + n(v.get) + " " + n(v.pct) + "% off",
    build: (st, v) => order(st, v, [item(v, v.buy), item(v, v.get, n(v.price) * (1 - n(v.pct) / 100))]) },
  { g: "Quantity and bundles", k: "tier", label: "Multi-pack, or buy more save more", fields: [F.int("qty", "Quantity", 3), F.pct("pct", "Discount", 20), EXTRA_SHIP],
    name: v => n(v.qty) + "-pack, " + n(v.pct) + "% off", build: (st, v) => order(st, v, [item(v, v.qty)], { pct: v.pct }) },
  { g: "Quantity and bundles", k: "bundle", label: "Bundle with other products",
    fields: [F.money("p2", "Second item price", 29.99), F.money("c2", "Second item cost", 4.5), F.money("p3", "Third item price", 0), F.money("c3", "Third item cost", 0), F.pct("pct", "Discount", 15), EXTRA_SHIP],
    name: v => "Bundle, " + n(v.pct) + "% off", build: (st, v) => order(st, v, [item(v),
      { qty: n(v.p2) || n(v.c2) ? 1 : 0, price: v.p2, cost: v.c2 }, { qty: n(v.p3) || n(v.c3) ? 1 : 0, price: v.p3, cost: v.c3 }], { pct: v.pct }) },
  { g: "Extras", k: "gift", label: "Free gift or sample", fields: [F.money("gift", "Gift cost to you", 1.3), EXTRA_SHIP],
    name: () => "Free gift", build: (st, v) => order(st, v, [item(v), { qty: 1, price: 0, cost: v.gift }]) },
  { g: "Extras", k: "freeship", label: "Free shipping", fields: [],
    name: () => "Free shipping", build: (st, v) => order(st, Object.assign({}, v, { ship: 0 }), [item(v)]) },
  { g: "Extras", k: "bonus", label: "Free bonus, guide, course or service", fields: [F.money("extra", "Cost to you per order", 0)],
    name: () => "Free bonus", build: (st, v) => one(st, v, { extra: v.extra }) },
  { g: "Upsells", k: "bump", label: "Upsell, order bump or post-purchase",
    fields: [F.money("addPrice", "Add-on price", 24.99), F.money("addCost", "Add-on cost", 1.3), F.pct("take", "Customers who add it", 20), EXTRA_SHIP],
    name: () => "Upsell", build: (st, v) => {
      const b = one(st, v);
      const t = n(v.take) / 100;
      return { pays: b.pays + t * n(v.addPrice), cost: b.cost + t * (n(v.addCost) + n(v.extraShip)) };
    } },
  { g: "Subscriptions", k: "sub", sub: true, labels: { ship: "Shipping charged to one-time buyers" }, label: "Subscribe and save", fields: [SUB.pct, SUB.share, SUB.churn, SUB.subShip],
    name: v => "Subscribe and save " + n(v.pct) + "%", build: (st, v) => subscription(st, v, { plans: [{ w: 1, qty: 1, every: 1, pct: v.pct }] }) },
  { g: "Subscriptions", k: "subgift", sub: true, labels: { ship: "Shipping charged to one-time buyers" }, label: "Subscribe with welcome gifts", fields: [SUB.pct, SUB.share, SUB.churn, SUB.gift, SUB.subShip],
    name: v => "Subscribe " + n(v.pct) + "% + welcome gifts", build: (st, v) => subscription(st, v, { plans: [{ w: 1, qty: 1, every: 1, pct: v.pct }], gift: v.gift }) },
  { g: "Subscriptions", k: "subsupply", sub: true, labels: { ship: "Shipping charged to one-time buyers" }, label: "Multi-month supply subscription",
    fields: [F.int("months", "Months of supply per delivery", 3), SUB.pct, SUB.share, SUB.churn, SUB.gift, SUB.subShip, EXTRA_SHIP],
    note: "Each delivery lasts several months, so its first renewal lands after the 90 days this tool counts. It's judged on the first delivery alone, which undersells it next to monthly plans.",
    name: v => n(v.months) + "-month supply subscription",
    build: (st, v) => { const m = Math.max(1, Math.round(n(v.months))); return subscription(st, v, { plans: [{ w: 1, qty: m, every: m, pct: v.pct }], gift: v.gift, otpQty: m }); } },
  { g: "Subscriptions", k: "subtier", sub: true, labels: { ship: "Shipping charged to one-time buyers", pct: "1-month plan discount" }, label: "Tiered subscription: 1-month or 3-month plan",
    fields: [SUB.pct, F.pct("pct3", "3-month plan discount", 25), F.pct("big", "Subscribers who pick the 3-month plan", 40), SUB.share, SUB.churn, SUB.gift, SUB.subShip, EXTRA_SHIP],
    note: "The 3-month plan's first renewal lands after 90 days, so only its first delivery counts here.",
    name: () => "Subscription, 1 or 3 months",
    build: (st, v) => { const b = clampPct(v.big); return subscription(st, v, { plans: [{ w: 1 - b, qty: 1, every: 1, pct: v.pct }, { w: b, qty: 3, every: 3, pct: v.pct3 }], gift: v.gift }); } },
  { g: "Subscriptions", k: "subonly", sub: true, labels: { ship: "Shipping charged to one-time buyers" }, label: "Subscription only, no one-time option", fields: [SUB.pct, SUB.churn, SUB.gift, SUB.subShip],
    note: "Rarely works on cold traffic: with no one-time price beside it, the subscription has no anchor to show its saving. Only try it once your subscription take rate already beats one-time, and you're happy with churn.",
    name: () => "Subscription only",
    build: (st, v) => subscription(st, Object.assign({}, v, { share: 100 }), { plans: [{ w: 1, qty: 1, every: 1, pct: v.pct }], gift: v.gift }) },
  { g: "Risk and payments", k: "guarantee", label: "Guarantee or free returns", fields: [F.pct("more", "Extra refunds you expect", 3)],
    name: () => "Money-back guarantee", build: (st, v) => { const b = one(st, v); return { pays: b.pays, cost: b.cost + b.pays * n(v.more) / 100 }; } },
  { g: "Risk and payments", k: "bnpl", label: "Pay later or split pay", fields: [F.pct("fee", "Provider fee", 6)],
    name: () => "Pay later", build: (st, v) => { const b = one(st, v); return { pays: b.pays, cost: b.cost + b.pays * n(v.fee) / 100 }; } },
  { g: "Risk and payments", k: "reward", label: "Cashback, credit, points or donation", fields: [F.pct("value", "Value given back", 10), F.pct("used", "Share actually used", 60)],
    name: v => n(v.value) + "% back", build: (st, v) => { const b = one(st, v); return { pays: b.pays, cost: b.cost + b.items * n(v.value) / 100 * n(v.used) / 100 }; } },
];
TYPES.unshift({ g: "", k: "custom", label: "None, I'll enter the numbers", fields: [], name: () => "New offer", build: () => null });
const TYPE = Object.fromEntries(TYPES.map(t => [t.k, t]));

function applySpec(o) {
  if (!o.spec || !TYPE[o.spec.preset] || o.spec.preset === "custom") return;
  // older saves described subscriptions by who stays; the training speaks of churn
  if (o.spec.v.keep !== undefined && o.spec.v.churn === undefined) o.spec.v.churn = 100 - n(o.spec.v.keep);
  TYPE[o.spec.preset].fields.forEach(f => { if (o.spec.v[f.k] === undefined) o.spec.v[f.k] = f.def(o.spec.v); });
  const r = TYPE[o.spec.preset].build(state.store, o.spec.v);
  if (!r) return;
  o.pays = round2(r.pays);
  o.cost = round2(r.cost);
  if (r.reorder !== undefined) Object.assign(o, { reorder: round2(r.reorder), reorders: round2(r.reorders), repeatLeaves: r.repeatLeaves, repeatPays: r.repeatPays });
  else { o.repeatLeaves = null; o.repeatPays = null; }
}
// New offers start from the current offer's item price, cost and shipping.
function baseItem() {
  const b = state.offers[0];
  // "other": how often one-time buyers reorder, taken from the control; subscription templates use it for their one-time side
  const other = b ? n(b.reorder) : 0;
  if (b && b.spec && b.spec.preset !== "custom") return { price: n(b.spec.v.price), unit: n(b.spec.v.unit), ship: n(b.spec.v.ship), other };
  return { price: b ? n(b.pays) : 0, unit: b ? n(b.cost) : 0, ship: 0, other };
}

/* ---------- formatting ---------- */

const cur = () => state.store.currency || "$";
function money(v, dp = 2) {
  if (!Number.isFinite(Number(v))) return "–";
  v = Number(v);
  const t = cur() + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return v < 0 ? "-" + t : t;
}
function compact(v) {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  let t;
  if (a >= 1e6) t = (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "m";
  else if (a >= 1e3) t = (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  else t = Math.round(a).toString();
  return (v < 0 ? "-" : "") + cur() + t;
}
const lineColour = c => "color-mix(in srgb, " + c + " 80%, #000)";
const signed = (x, fmt) => (x > 0 ? "+" : x < 0 ? "−" : "") + fmt(Math.abs(x));

/* ---------- DOM helpers ---------- */

const $ = s => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
let toastTimer;
function notify(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function numInput(value, attrs = {}) {
  const i = el("input");
  i.type = "number";
  i.step = "any";
  i.inputMode = "decimal";
  i.value = value === "" || value === undefined || value === null ? "" : value;
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  return i;
}
function fillRange(r) {
  const min = n(r.min), max = n(r.max), v = n(r.value);
  r.style.setProperty("--fill", (max > min ? Math.min(100, Math.max(0, (v - min) / (max - min) * 100)) : 0) + "%");
}

/* ---------- store variables ---------- */

const LEVERS = [
  { k: "spend", range: "#spendRange", num: "#spendNum", min: 1000, max: () => Math.max(200000, n(state.store.spend) * 2), step: 500, dp: 0 },
  { k: "cvr", range: "#cvrRange", num: "#cvrNum", min: 0.2, max: () => Math.max(8, n(state.store.cvr)), step: 0.05, dp: 2 },
  { k: "cpc", range: "#cpcRange", num: "#cpcNum", min: 0.05, max: () => Math.max(5, n(state.store.cpc)), step: 0.01, dp: 2 }
];
const fmtLever = (L, v) => (L.dp ? n(v).toFixed(L.dp) : String(Math.round(n(v))));
function syncLevers() {
  LEVERS.forEach(L => {
    const r = $(L.range), x = $(L.num), v = n(state.store[L.k]);
    r.min = L.min; r.max = L.max(); r.step = L.step; r.value = v;
    fillRange(r);
    if (document.activeElement !== x) x.value = fmtLever(L, v);
  });
  document.querySelectorAll(".unit.cur").forEach(u => { u.textContent = cur(); });
}
LEVERS.forEach(L => {
  $(L.range).addEventListener("input", e => {
    state.store[L.k] = n(e.target.value);
    $(L.num).value = fmtLever(L, state.store[L.k]);
    fillRange(e.target);
    save(); refresh();
  });
  $(L.num).addEventListener("input", e => {
    state.store[L.k] = Math.max(0, n(e.target.value));
    const r = $(L.range);
    r.max = L.max();
    r.value = state.store[L.k];
    fillRange(r);
    save(); refresh();
  });
});

function renderStoreFields() {
  const grid = $("#storeFields");
  grid.replaceChildren();
  STORE_FIELDS.forEach(f => {
    const lab = el("label", "field");
    lab.append(el("span", "", f.label + (f.money ? " (" + cur() + ")" : f.suffix ? " (" + f.suffix + ")" : "")));
    let inp;
    if (f.check) {
      lab.classList.add("check-field");
      inp = el("input", "show");
      inp.type = "checkbox";
      inp.checked = !!state.store[f.k];
      inp.id = "store-" + f.k;
      inp.title = "Leave this off unless your own data shows customers really do reorder";
      inp.addEventListener("change", () => { state.store[f.k] = inp.checked; save(); renderTable(); });
      lab.append(inp);
      grid.append(lab);
      return;
    }
    if (f.text) { inp = el("input"); inp.type = "text"; inp.maxLength = 3; inp.value = state.store[f.k] || "$"; }
    else inp = numInput(state.store[f.k], { min: "0" });
    inp.id = "store-" + f.k;
    inp.addEventListener("input", () => {
      state.store[f.k] = f.text ? (inp.value || "$") : n(inp.value);
      state.offers.forEach(applySpec);
      save();
      syncLevers();
      renderTable();
    });
    lab.append(inp);
    grid.append(lab);
  });
}

/* ---------- offer details ---------- */

// Read left to right: how hard the offer is (break-even ROAS), what you expect, how much room that leaves, then what it earns.
const COLS = [
  ["Test", "c-test", "The control is the offer you run today. Variants are the offers you're testing against it."],
  ["Offer", "c-name", ""],
  ["Customer pays", "", "What the customer pays for one order, shipping included."],
  ["Your cost", "", "Products, gifts, packing and shipping for one order. Payment fees and refunds are added for you."],
  ["Reorder %", "", "Share of customers who order again within 90 days."],
  ["Conversion rate", "c-conv", "The conversion rate you expect with this offer. The first offer sets the base; the others show their change from it."],
  ["Break-even ROAS", "", "The ROAS your ad platform has to report for the first order to cover its ad cost. Subscription and repeat offers can run below it and still make money once reorders come in."],
  ["Expected ROAS", "", "The ROAS your ad platform should report with this offer. Type one in and the conversion rate follows."],
  ["Margin of safety", "", "How far conversion can fall from what you expect before this offer starts losing money."],
  ["Contribution profit", "", "What the offer leaves a month after ads, at today's ad spend and the conversion rate you expect, counting reorders within 90 days."],
  ["From reorders", "", "How much of that contribution profit comes from reorders within 90 days, rather than the first order."],
  ["Contribution margin", "", "Contribution profit as a share of revenue."],
  ["Leaves per order", "", "What one order leaves after every cost, before ads."],
  ["To tie", "", "How many more orders this offer needs to make the same money as your current offer."],
  ["", "c-x", ""]
];
const BIN = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

function renderTable() {
  const t = $("#offerTable");
  t.replaceChildren(el("thead"), el("tbody"));
  const hr = el("tr");
  COLS.forEach(([h, cls, tip]) => { const th = el("th", cls, h); if (tip) th.title = tip; hr.append(th); });
  t.tHead.append(hr);
  state.offers.forEach((o, i) => t.tBodies[0].append(offerRow(o, i)));
  const add = el("tr", "add-row");
  const td = el("td");
  td.colSpan = COLS.length;
  const b = el("button", "", "+ Add Offer Variant");
  b.type = "button";
  b.id = "addOffer";
  b.disabled = state.offers.length >= MAX_OFFERS;
  b.addEventListener("click", () => openOffer(null));
  td.append(b);
  add.append(td);
  t.tBodies[0].append(add);
  refresh();
}

function offerRow(o, i) {
  const tr = el("tr", i === 0 ? "is-control" : "is-variant");
  const test = el("td", "c-test");
  const pick = el("select", i === 0 ? "test-pick control" : "test-pick variant");
  pick.setAttribute("aria-label", "Control or variant");
  [["control", "Control"], ["variant", "Variant"]].forEach(([v, t]) => { const op = el("option", "", t); op.value = v; pick.append(op); });
  pick.value = i === 0 ? "control" : "variant";
  pick.disabled = i === 0;
  if (i === 0) pick.title = "To change the control, set another offer to Control";
  pick.addEventListener("change", () => { if (pick.value === "control") makeControl(o); });
  test.append(pick);
  tr.append(test);
  const name = el("td", "c-name");
  const nc = el("div", "name-cell");
  const col = el("input", "colour");
  col.type = "color";
  col.value = o.color;
  col.setAttribute("aria-label", "Colour for " + o.name);
  col.addEventListener("input", () => { o.color = col.value; save(); drawChart(); });
  const nb = el("button", "name-btn", o.name || "Offer");
  nb.type = "button";
  nb.title = "Change this offer";
  nb.addEventListener("click", () => openOffer(o));
  const show = el("input", "show");
  show.type = "checkbox";
  show.checked = !o.dim;
  show.title = "Show on the chart";
  show.setAttribute("aria-label", "Show " + (o.name || "offer") + " on the chart");
  show.addEventListener("change", () => { o.dim = !show.checked; tr.classList.toggle("dimmed", !!o.dim); save(); drawChart(); });
  tr.classList.toggle("dimmed", !!o.dim);
  nc.append(show, col, nb);
  name.append(nc);
  tr.append(name);

  const edit = (k, value, label, step, onInput) => {
    const td = el("td", "edit");
    const inp = numInput(value, { min: "0", id: k + "-" + o.id, "aria-label": label, step });
    inp.addEventListener("input", () => { onInput(n(inp.value)); save(); refresh(); });
    td.append(inp);
    return td;
  };
  const custom = () => { o.spec = { preset: "custom", v: {} }; o.repeatLeaves = null; o.repeatPays = null; };
  tr.append(edit("pays", n(o.pays).toFixed(2), "Customer pays", "any", v => { o.pays = v; custom(); }));
  tr.append(edit("cost", n(o.cost).toFixed(2), "Your cost", "any", v => { o.cost = v; custom(); }));
  tr.append(edit("reorder", n(o.reorder), "Reorder rate, percent", "1", v => { o.reorder = Math.min(100, v); }));

  const conv = el("td", "c-conv");
  const cc = el("div", "conv-cell");
  if (i === 0) {
    const s = el("span", "conv-now");
    s.id = "conv-" + o.id;
    cc.append(el("span", "conv-spacer"), s, el("small", "muted", "store"));
    s.title = "The control converts at your store's conversion rate. Change it in Store Variables.";
    conv.append(cc);
    tr.append(conv);
  } else {
  const r = el("input");
  r.type = "range";
  r.id = "convr-" + o.id;
  r.setAttribute("aria-label", "Conversion rate for " + o.name);
  const num = numInput("", { id: "conv-" + o.id, "aria-label": "Conversion rate for " + o.name + ", percent", step: "0.05", min: "0" });
  const rel = el("small");
  rel.id = "rel-" + o.id;
  r.addEventListener("input", () => { setConversion(o, i, r.value, "range"); save(); refresh(); });
  num.addEventListener("input", () => { setConversion(o, i, num.value, "rate"); save(); refresh(); });
  const val = el("span", "conv-val");
  val.append(num, el("span", "pct-sign", "%"));
  cc.append(r, val, rel);
  conv.append(cc);
  tr.append(conv);
  }

  ["roas"].forEach(k => { const td = el("td"); td.id = k + "-" + o.id; tr.append(td); });
  // a variant's expected ROAS can be typed in: it sets the conversion rate behind it
  if (i === 0) { const td = el("td"); td.id = "expfix-" + o.id; tr.append(td); }
  else {
  const exp = el("td", "edit");
  const expIn = numInput("", { id: "expin-" + o.id, "aria-label": "Expected ROAS for " + o.name, step: "0.01", min: "0" });
  expIn.addEventListener("input", () => {
    const cpc = n(state.store.cpc), pays = n(o.pays);
    if (cpc > 0 && pays > 0 && n(expIn.value) > 0) { setConversion(o, i, n(expIn.value) * cpc / pays * 100, "rate"); save(); refresh(); }
  });
  exp.append(expIn);
  tr.append(exp);
  }
  ["safety", "cp", "reo", "cm", "leaves", "tie"].forEach(k => { const td = el("td"); td.id = k + "-" + o.id; tr.append(td); });

  const x = el("td", "c-x");
  if (i > 0) {
    const b = el("button", "bin");
    b.innerHTML = BIN;
    b.title = "Remove this offer";
    b.type = "button";
    b.setAttribute("aria-label", "Remove " + o.name);
    b.addEventListener("click", () => removeOffer(o, tr, b));
    x.append(b);
  }
  tr.append(x);
  return tr;
}

// Binning an offer: a little puff of smoke, the row fades and folds away, then the table redraws.
function puffAt(x, y) {
  const p = el("div", "puff");
  p.style.left = x + "px";
  p.style.top = y + "px";
  for (let k = 0; k < 9; k++) {
    const d = el("i");
    const a = k / 9 * Math.PI * 2 + Math.random() * 0.5;
    const dist = 22 + Math.random() * 16;
    d.style.setProperty("--dx", Math.cos(a) * dist + "px");
    d.style.setProperty("--dy", Math.sin(a) * dist + "px");
    d.style.animationDelay = Math.random() * 60 + "ms";
    p.append(d);
  }
  document.body.append(p);
  setTimeout(() => p.remove(), 700);
}
function removeOffer(o, tr, btn) {
  if (tr.classList.contains("puffing")) return;
  const done = () => { state.offers = state.offers.filter(x => x !== o); save(); renderTable(); };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { done(); return; }
  const r = btn.getBoundingClientRect();
  puffAt(r.left + r.width / 2 + scrollX, r.top + r.height / 2 + scrollY);
  tr.classList.add("puffing");
  setTimeout(() => { tr.classList.add("collapsing"); setTimeout(done, 210); }, 260);
}

// Making a variant the control: it moves to the top and takes the store's conversion rate,
// and every other offer keeps the conversion rate it had, now measured against the new control.
function makeControl(o) {
  const i = state.offers.indexOf(o);
  if (i <= 0) return;
  const abs = new Map(state.offers.map(x => [x, expectedCvr(x)]));
  const old = state.offers[0];
  [o.color, old.color] = [old.color, o.color];
  state.offers.splice(i, 1);
  state.offers.unshift(o);
  state.store.cvr = round2(abs.get(o));
  const base = n(state.store.cvr);
  state.offers.forEach((x, k) => { x.conv = k === 0 || base <= 0 ? 0 : (abs.get(x) / base - 1) * 100; });
  save();
  syncLevers();
  renderTable();
  notify((o.name || "That offer") + " is now the control.");
}

// The first offer's conversion rate is the store's base rate; every other offer is a change from it.
function setConversion(o, i, value, from) {
  const base = n(state.store.cvr);
  if (i === 0) {
    state.store.cvr = Math.max(0, from === "range" ? n(value) : n(value));
    return;
  }
  if (from === "range") { o.conv = n(value); return; }
  if (base > 0) o.conv = Math.max(-90, (n(value) / base - 1) * 100);
}

function refresh() {
  if (!state.offers.length) { drawChart(); return; }
  const base = state.offers[0];
  const c0 = calc(base);
  const cp0 = profitAt(c0.value, expectedCvr(base));
  const live = visitors() > 0 && n(state.store.cvr) > 0;
  state.offers.forEach((o, i) => {
    const c = calc(o);
    const cvr = expectedCvr(o);
    const set = (k, fn) => { const td = document.getElementById(k + "-" + o.id); if (td) { td.replaceChildren(); fn(td); } };
    const num = document.getElementById("conv-" + o.id);
    if (num && i === 0) num.textContent = cvr.toFixed(2) + "%";
    else if (num && document.activeElement !== num) num.value = cvr.toFixed(2);
    const range = document.getElementById("convr-" + o.id);
    if (range) {
      if (i === 0) { range.min = 0.2; range.max = Math.max(8, Math.ceil(cvr * 2)); range.step = 0.05; range.value = cvr; }
      else { range.min = -50; range.max = Math.max(100, Math.ceil(n(o.conv))); range.step = 1; range.value = n(o.conv); }
      fillRange(range);
    }
    const expFix = document.getElementById("expfix-" + o.id);
    if (expFix) { const r = expectedRoas(o); expFix.textContent = Number.isFinite(r) ? r.toFixed(2) : "\u2013"; }
    const expIn = document.getElementById("expin-" + o.id);
    if (expIn) {
      const r = expectedRoas(o), be = breakEvenRoas90(o);
      if (document.activeElement !== expIn) expIn.value = Number.isFinite(r) ? r.toFixed(2) : "";
      expIn.classList.toggle("down", Number.isFinite(r) && Number.isFinite(be) && r < be);
    }
    if (i > 0) {
      const rel = document.getElementById("rel-" + o.id);
      if (rel) {
        const ch = Math.round(n(o.conv));
        rel.textContent = ch === 0 ? "0%" : signed(ch, x => x + "%");
        rel.className = ch > 0 ? "up" : ch < 0 ? "down" : "muted";
      }
    }
    set("leaves", td => td.append(money(c.leaves)));
    set("cp", td => {
      if (!live) { td.append("–"); return; }
      const cp = profitAt(c.value, cvr);
      td.append(el("span", cp < 0 ? "down" : cp > 0 ? "up" : "", money(cp, 0)));
      if (i > 0 && Math.abs(cp - cp0) >= 1) td.append(el("small", cp > cp0 ? "up" : "down", signed(cp - cp0, x => compact(x))));
    });
    set("reo", td => {
      if (!live) { td.append("\u2013"); return; }
      const r = visitors() * cvr / 100 * c.extra;
      td.append(r > 0.5 ? el("span", "up", money(r, 0)) : el("span", "muted", "\u2013"));
    });
    set("cm", td => {
      if (!live) { td.append("–"); return; }
      const rev = visitors() * cvr / 100 * c.revenue;
      const m = rev > 0 ? profitAt(c.value, cvr) / rev : NaN;
      td.append(el("span", m < 0 ? "down" : "", Number.isFinite(m) ? (m * 100).toFixed(1) + "%" : "–"));
    });
    set("roas", td => {
      const r = breakEvenRoas(o);
      td.append(Number.isFinite(r) ? r.toFixed(2) : el("span", "down", "Never"));
    });
    set("safety", td => {
      if (!live) { td.append("\u2013"); return; }
      const m = safetyOf(o);
      if (!Number.isFinite(m)) { td.append(el("span", "down", "None")); return; }
      const s = el("span", m < 0 ? "down" : m >= 0.2 ? "up" : "", Math.round(m * 100) + "%");
      s.title = m < 0 ? "Already losing money at the conversion rate you expect, even counting reorders" : "Conversion can fall " + Math.round(m * 100) + "% before this offer loses money, counting reorders";
      td.append(s);
    });
    set("tie", td => {
      if (i === 0) { td.append(el("span", "muted", "–")); return; }
      if (c.value <= 0) { td.append(el("span", "down", "Loses money")); return; }
      const need = c0.value > 0 ? c0.value / c.value - 1 : NaN;
      if (!Number.isFinite(need)) { td.append("–"); return; }
      const p = Math.round(need * 100);
      const s = el("span", need <= 0.1 ? "up" : need > 0.3 ? "down" : "", p === 0 ? "0%" : signed(p, x => x + "%"));
      s.title = need > 0 ? "Needs " + p + "% more orders to tie" : "Still ties with " + -p + "% fewer orders";
      td.append(s);
    });
  });
  drawChart();
}

function nextColour() {
  const used = new Set(state.offers.map(o => o.color));
  return COLORS.slice(1).find(c => !used.has(c)) || COLORS[1 + (state.offers.length % (COLORS.length - 1))];
}

/* ---------- the offer window: name, type and a few details, with the code updating live ---------- */

const dlg = $("#offerDialog");
const B = { offer: null, type: "pct", v: {}, touched: new Set(), nameTouched: false, custom: null, reorder: 0, reorders: 1 };

function typeOptions(placeholder) {
  const frag = document.createDocumentFragment();
  if (placeholder) { const p = el("option", "", placeholder); p.value = ""; p.selected = true; p.hidden = true; frag.append(p); }
  let group = null, og = null;
  TYPES.forEach(t => {
    const op = el("option", "", t.label);
    op.value = t.k;
    if (!t.g) { frag.append(op); return; }
    if (t.g !== group) { group = t.g; og = el("optgroup"); og.label = group; frag.append(og); }
    og.append(op);
  });
  return frag;
}
function buildTypeSelect() { $("#bType").replaceChildren(typeOptions()); }

function openOffer(offer, type) {
  B.offer = offer;
  B.touched = new Set();
  B.custom = null;
  $("#bError").hidden = true;
  const base = state.offers[0];
  if (offer) {
    B.type = offer.spec && TYPE[offer.spec.preset] ? offer.spec.preset : "custom";
    B.v = offer.spec ? Object.assign({}, offer.spec.v) : {};
    Object.keys(B.v).forEach(k => B.touched.add(k));
    if (B.type === "custom") B.custom = { pays: offer.pays, cost: offer.cost };
    B.reorder = n(offer.reorder);
    B.reorders = n(offer.reorders) || 1;
    B.nameTouched = true;
    $("#bName").value = offer.name;
  } else {
    B.type = type && TYPE[type] ? type : "custom";
    B.v = baseItem();
    if (B.type === "custom") B.custom = { pays: base ? n(base.pays) : 0, cost: base ? n(base.cost) : 0 };
    ["price", "unit", "ship"].forEach(k => B.touched.add(k));
    B.reorder = base ? n(base.reorder) : 0;
    B.reorders = base ? n(base.reorders) || 1 : 1;
    B.nameTouched = false;
  }
  $("#bType").value = B.type;
  $("#bSave").textContent = offer ? "Save" : "Add Variant";
  $("#bDelete").hidden = !offer || offer === state.offers[0];
  renderOfferFields();
  dlg.showModal();
  document.body.classList.add("dialog-open");
  $("#bName").focus();
  $("#bName").select();
}

function renderOfferFields() {
  const t = TYPE[B.type];
  const box = $("#bFields");
  box.replaceChildren();
  const fields = B.type === "custom" ? [] : BASE.concat(t.fields);
  fields.forEach(f => { if (!B.touched.has(f.k) || B.v[f.k] === undefined) B.v[f.k] = f.def(B.v); });
  const add = (f, value, onChange) => {
    const lab = el("label", "field");
    lab.append(el("span", "", f.label + (f.type === "money" ? " (" + cur() + ")" : f.type === "pct" ? " (%)" : "")));
    const inp = numInput(round2(value), { min: "0", step: f.type === "int" ? "1" : "any" });
    inp.id = "f-" + f.k;
    inp.addEventListener("input", () => onChange(n(inp.value)));
    lab.append(inp);
    box.append(lab);
  };
  fields.forEach(f => {
    if (B.type === "freeship" && f.k === "ship") return;
    if (t.labels && t.labels[f.k]) f = Object.assign({}, f, { label: t.labels[f.k] });
    add(f, B.v[f.k], val => { B.v[f.k] = val; B.touched.add(f.k); writeCode(); });
  });
  if (B.type === "custom") {
    const c = B.custom || { pays: 0, cost: 0 };
    add({ k: "cpays", label: "Customer pays", type: "money" }, c.pays, v => { B.custom = Object.assign({}, B.custom || c, { pays: v }); writeCode(); });
    add({ k: "ccost", label: "Your cost", type: "money" }, c.cost, v => { B.custom = Object.assign({}, B.custom || c, { cost: v }); writeCode(); });
  }
  if (TYPE[B.type].note) box.append(el("p", "field-note wide", TYPE[B.type].note));
  if (!TYPE[B.type].sub) {
    add({ k: "reorder", label: "Customers who reorder in 90 days", type: "pct" }, B.reorder, v => { B.reorder = Math.min(100, v); writeCode(); });
    add({ k: "reorders", label: "Reorders each", type: "int" }, B.reorders, v => { B.reorders = v; writeCode(); });
  }
  writeCode();
}

function result() {
  if (B.type === "custom") {
    const c = B.custom || { pays: 0, cost: 0 };
    return { pays: n(c.pays), cost: n(c.cost), reorder: B.reorder, reorders: B.reorders, repeatLeaves: null, repeatPays: null };
  }
  return Object.assign({ reorder: B.reorder, reorders: B.reorders, repeatLeaves: null, repeatPays: null }, TYPE[B.type].build(state.store, B.v));
}

function writeCode() {
  if (!B.nameTouched) $("#bName").value = TYPE[B.type].name(B.v);
  const r = result();
  $("#bCode").value = JSON.stringify({
    name: $("#bName").value,
    customerPays: round2(r.pays),
    yourCost: round2(r.cost),
    reorderPercent: round2(r.reorder),
    reordersEach: round2(r.reorders)
  }, null, 2);
  $("#bError").hidden = true;
}

$("#bType").addEventListener("change", () => {
  const prev = result();
  const keep = { price: B.v.price, unit: B.v.unit, ship: B.v.ship, other: B.v.other };
  B.type = $("#bType").value;
  B.v = Object.assign({}, keep);
  B.touched = new Set(["price", "unit", "ship"]);
  if (B.type === "custom") B.custom = { pays: round2(prev.pays), cost: round2(prev.cost) };
  renderOfferFields();
});
$("#bName").addEventListener("input", () => { B.nameTouched = true; writeCode(); });

// Pasting or typing code, for example an AI's reply, turns the offer into a custom one.
$("#bCode").addEventListener("input", () => {
  const raw = $("#bCode").value;
  const d = readJson(raw);
  if (!d || (d.customerPays === undefined && d.yourCost === undefined)) {
    $("#bError").textContent = "Couldn't read that yet. It needs customerPays and yourCost.";
    $("#bError").hidden = !raw.trim();
    return;
  }
  B.type = "custom";
  $("#bType").value = "custom";
  B.custom = { pays: num(d.customerPays), cost: num(d.yourCost) };
  if (d.reorderPercent !== undefined) B.reorder = Math.min(100, num(d.reorderPercent));
  if (d.reordersEach !== undefined) B.reorders = num(d.reordersEach);
  if (d.name) { $("#bName").value = String(d.name).slice(0, 60); B.nameTouched = true; }
  renderOfferFields();
  $("#bCode").value = raw;
});

$("#bSave").addEventListener("click", () => {
  const r = result();
  const name = $("#bName").value.trim() || TYPE[B.type].name(B.v) || "Offer";
  const fields = {
    name, spec: { preset: B.type, v: Object.assign({}, B.v, B.type === "freeship" ? { ship: 0 } : {}) },
    pays: round2(r.pays), cost: round2(r.cost), reorder: round2(r.reorder), reorders: n(r.reorders),
    repeatLeaves: r.repeatLeaves, repeatPays: r.repeatPays
  };
  if (B.offer) Object.assign(B.offer, fields);
  else state.offers.push(Object.assign({ id: newId("o"), color: nextColour(), conv: 0 }, fields));
  state.example = false;
  save();
  dlg.close();
  renderTable();
});
$("#bCancel").addEventListener("click", () => dlg.close());
$("#bDelete").addEventListener("click", () => {
  if (!B.offer) return;
  state.offers = state.offers.filter(o => o !== B.offer);
  save();
  dlg.close();
  renderTable();
});
dlg.addEventListener("close", () => document.body.classList.remove("dialog-open"));

function offerPrompt() {
  const st = state.store;
  const b = baseItem();
  const data = {
    currency: cur(), currentPricePerItem: b.price, currentCostPerItem: b.unit, currentShippingCharged: b.ship,
    fulfilmentPerOrder: st.shipFirst
  };
  return `I'm modelling an offer for my Shopify store in the Offer Simulator. Here are my current numbers:

${JSON.stringify(data, null, 2)}

I'll describe the offer below. Work out the numbers for one typical order under this offer and reply with JSON only: no explanation, no code fences, no extra keys.

{ "name": "", "customerPays": 0, "yourCost": 0, "reorderPercent": 0, "reordersEach": 1 }

"customerPays" is what the customer pays for one order, shipping included, after every discount. "yourCost" is everything it costs me to fulfil that order: products (including any free items), packing and shipping (including anything extra it costs to ship more than one item), plus the cost of any extras such as gifts, bonuses, cashback or a service. Leave out payment fees and refunds, because the simulator adds those. If only some customers take part (an order bump, say), average it across all orders. "reorderPercent" is the share of customers who order again within 90 days, and "reordersEach" is how many times they do; use 0 and 1 unless the offer is built for repeat orders, such as a subscription. Every figure is a plain number with no symbol. If the offer includes a product I haven't given you the price or cost of, ask me for it rather than guessing.

My offer:`;
}
$("#bCopy").addEventListener("click", () => copyText(offerPrompt(), "AI instructions copied. Describe your offer at the end, then paste the reply into the code box."));

/* ---------- the break-even chart: contribution profit at every conversion rate ---------- */

function niceStep(range, count) {
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

// Along the bottom: conversion rate, or the ROAS your ad platform reports. Same lines, a different ruler.
const AXES = {
  cvr: { title: "Conversion rate", fmt: x => (Math.round(x * 100) / 100) + "%", long: x => x.toFixed(2) + "%",
    toCvr: (o, x) => x, of: (o, cvr) => cvr, be: s => s.be, today: () => n(state.store.cvr) },
  roas: { title: "ROAS", fmt: x => (Math.round(x * 10) / 10).toFixed(1), long: x => x.toFixed(2) + " ROAS",
    toCvr: (o, x) => (n(o.pays) > 0 ? x * n(state.store.cpc) / n(o.pays) * 100 : 0), of: (o, cvr) => roasAt(o, cvr),
    be: s => breakEvenRoas90(s.o), today: () => (state.offers[0] ? expectedRoas(state.offers[0]) : NaN) }
};
const axis = () => AXES[state.axis] || AXES.cvr;
function syncAxisToggle() {
  document.querySelectorAll(".axis-toggle button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.axis === (AXES[state.axis] ? state.axis : "cvr"))));
}
document.querySelectorAll(".axis-toggle button").forEach(b => b.addEventListener("click", () => {
  state.axis = b.dataset.axis;
  save();
  syncAxisToggle();
  drawChart();
}));

let chartGeom = null;
function drawChart() {
  const svg = $("#chart");
  const W = $("#chartBox").clientWidth || 900;
  const H = svg.clientHeight || 460;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.replaceChildren();
  $("#chartTip").hidden = true;
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, text, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    parent.append(e);
    return e;
  };
  const A = axis();
  const C0 = n(state.store.cvr);
  const today = A.today();
  if (!visitors() || !C0 || !state.offers.length || !Number.isFinite(today) || today <= 0) {
    mk("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": 15, fill: "#000" }, "Set your ad spend, conversion rate and cost per click in Store Variables to see the chart.");
    chartGeom = null;
    return;
  }
  const series = state.offers.map(o => {
    const v = calc(o).value, cvr = expectedCvr(o);
    const s = { o, v, cvr, cp: profitAt(v, cvr), be: breakEvenCvr(v) };
    s.x = A.of(o, cvr);
    s.bx = A.be(s);
    s.at = x => profitAt(v, A.toCvr(o, x));
    s.els = [];
    return s;
  });
  const xMax = Math.max(today * 2, ...series.map(s => (Number.isFinite(s.x) ? s.x * 1.25 : 0)));
  const ys = series.flatMap(s => [s.at(0), s.at(xMax)]);
  let yMax = Math.max(1, ...ys);
  let yMin = Math.min(0, ...ys);
  const yStep = niceStep(yMax - yMin, 6);
  yMax = Math.ceil(yMax / yStep) * yStep;
  yMin = Math.floor(yMin / yStep) * yStep;
  const L = 84, R = 18, T = 30, Bm = 46;
  const X = v => L + (v / xMax) * (W - L - R);
  const Y = v => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - Bm);

  const defs = mk("defs", {});
  const clip = mk("clipPath", { id: "plotClip" }, undefined, defs);
  mk("rect", { x: L, y: T, width: W - L - R, height: H - T - Bm }, undefined, clip);
  if (yMin < 0) {
    mk("rect", { x: L, y: Y(0), width: W - L - R, height: Y(yMin) - Y(0), fill: "rgba(198, 40, 40, 0.06)" });
    mk("text", { x: W - R - 10, y: Y(yMin) - 10, "text-anchor": "end", "font-size": 12, "font-weight": 700, fill: "#c62828" }, "Losing money");
  }
  for (let v = yMin; v <= yMax + 1e-6; v += yStep) {
    const zero = Math.abs(v) < 1e-6;
    mk("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: zero ? "#000" : "#e8e8e8", "stroke-width": zero ? 1.5 : 1 });
    mk("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end", "font-size": 12, fill: "#000" }, compact(v));
  }
  const xStep = niceStep(xMax, 8);
  for (let v = 0; v <= xMax + 1e-6; v += xStep) {
    mk("line", { x1: X(v), x2: X(v), y1: H - Bm, y2: H - Bm + 5, stroke: "#000" });
    mk("text", { x: X(v), y: H - Bm + 19, "text-anchor": "middle", "font-size": 12, fill: "#000" }, A.fmt(v));
  }
  mk("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#000" }, A.title);
  mk("text", { x: 16, y: (T + H - Bm) / 2, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#000", transform: "rotate(-90 16 " + (T + H - Bm) / 2 + ")" }, "Contribution profit /mo (after ads)");
  mk("line", { x1: L, x2: L, y1: T, y2: H - Bm, stroke: "#000" });
  mk("line", { x1: X(today), x2: X(today), y1: T, y2: H - Bm, stroke: "#000", "stroke-dasharray": "4 4" });
  mk("text", { x: X(today) + 6, y: T - 10, "font-size": 12, "font-weight": 700, fill: "#000" }, (state.offers[0] ? state.offers[0].name || "Current offer" : "Today") + " " + A.long(today));

  // offers left unticked in the table stay on the chart, faded, and drop out of the hover
  const vis = series.filter(s => !s.o.dim);
  const tag = (s, e) => { e.classList.add("s-el"); if (s.o.dim) e.classList.add("is-dim"); s.els.push(e); return e; };
  // the control is drawn last, so no variant can ever cover it
  const order = series.slice(1).concat(series.slice(0, 1));
  // a line lying exactly under a later one is drawn wider, so it shows as an outline around it
  const same = (a, b) => Math.abs(Y(a.at(0)) - Y(b.at(0))) < 1.5 && Math.abs(Y(a.at(xMax)) - Y(b.at(xMax))) < 1.5;
  order.forEach((s, k) => {
    const covered = order.slice(k + 1).some(t => same(s, t));
    const line = tag(s, mk("line", { x1: X(0), y1: Y(s.at(0)), x2: X(xMax), y2: Y(s.at(xMax)), "stroke-width": covered ? 8 : s === series[0] ? 3 : 3, "clip-path": "url(#plotClip)" }));
    line.classList.add("s-line");
    if (covered) line.classList.add("is-under");
    line.style.stroke = lineColour(s.o.color);
  });
  const points = [];
  // a ring where each line crosses zero: its break-even point
  order.forEach(s => {
    if (!Number.isFinite(s.bx) || s.bx > xMax) return;
    const p = { kind: "be", s, x: X(s.bx), y: Y(0) };
    const c = tag(s, mk("circle", { cx: p.x, cy: p.y, r: 4.5, fill: "#fff", "stroke-width": 2 }));
    c.style.stroke = lineColour(s.o.color);
    if (!s.o.dim) points.push(p);
  });
  // a dot where each offer is expected to land
  const best = vis.length ? vis.reduce((a, b) => (b.cp > a.cp ? b : a), vis[0]) : null;
  order.forEach(s => {
    if (!Number.isFinite(s.x)) return;
    const p = { kind: "dot", s, x: X(s.x), y: Y(s.cp) };
    const c = tag(s, mk("circle", { cx: p.x, cy: p.y, r: s === best ? 7 : 5.5, stroke: "#000", "stroke-width": s === best ? 2 : 1, "clip-path": "url(#plotClip)" }));
    c.style.fill = lineColour(s.o.color);
    if (!s.o.dim) points.push(p);
  });
  // a gold crown over the most profitable offer
  if (best && vis.length > 1 && best.cp > 0 && Number.isFinite(best.x)) {
    mk("path", { d: "M-10 5 L-10 -5 L-5 0 L0 -8 L5 0 L10 -5 L10 5 Z", transform: "translate(" + X(best.x) + " " + (Y(best.cp) - 19) + ")", fill: "#f2b600", stroke: "#000", "stroke-width": 1.2, "stroke-linejoin": "round" });
  }
  // crosshair: follows the mouse, with a readout on each axis
  const hover = mk("g", { visibility: "hidden", "pointer-events": "none" });
  const hv = mk("line", { y1: T, y2: H - Bm, stroke: "#000", "stroke-width": 1 }, undefined, hover);
  const hh = mk("line", { x1: L, x2: W - R, stroke: "#000", "stroke-width": 1 }, undefined, hover);
  const xr = mk("rect", { height: 20, y: H - Bm + 4, fill: "#000" }, undefined, hover);
  const xt = mk("text", { y: H - Bm + 18, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#fff" }, "", hover);
  const yr = mk("rect", { height: 20, fill: "#000" }, undefined, hover);
  const yt = mk("text", { x: L - 8, "text-anchor": "end", "font-size": 12, "font-weight": 700, fill: "#fff" }, "", hover);
  hover.parts = { hv, hh, xr, xt, yr, yt };
  const overlay = mk("rect", { x: L, y: T - 10, width: W - L - R, height: H - T - Bm + 20, fill: "transparent" });
  overlay.addEventListener("pointermove", e => showChartTip(e));
  overlay.addEventListener("pointerleave", () => { $("#chartTip").hidden = true; hover.setAttribute("visibility", "hidden"); overlay.style.cursor = ""; focusSeries(null); });
  chartGeom = { X, Y, xMax, yMin, yMax, L, R, T, Bm, W, H, series, vis, points, best, overlay, A, svg, hover };
}

function tipRow(tip, label, value, colour) {
  const d = el("div");
  const left = el("span");
  if (colour) { d.style.setProperty("--line", colour); left.append(el("i")); }
  left.append(document.createTextNode(label));
  d.append(left, el("strong", "", value));
  tip.append(d);
  return d;
}

// Bring one offer forward: its line thickens with a soft shadow, the others fade back.
function focusSeries(se) {
  const g = chartGeom;
  const list = !se ? [] : Array.isArray(se) ? se : [se];
  const key = list.map(s => s.o.id).join("|");
  if (!g || g.focusKey === key) return;
  g.focusKey = key;
  g.series.forEach(s => s.els.forEach(e => {
    e.classList.toggle("is-focus", list.includes(s));
    e.classList.toggle("is-faded", list.length > 0 && !list.includes(s));
  }));
  // bring them forward, keeping the control on top if it's one of them
  list.slice().sort((a, b) => (a === g.series[0]) - (b === g.series[0])).forEach(s => s.els.forEach(e => g.svg.insertBefore(e, g.hover)));
}

// Several offers under the mouse at once: list them all, side by side.
function groupTable(tip, list, cvrOf, fmtRoas, withProfit) {
  const t = el("div", "tip-table" + (withProfit ? "" : " three"));
  ["Offer", "Conversion", "ROAS"].concat(withProfit ? ["Profit /mo"] : []).forEach(h => t.append(el("span", "tip-head", h)));
  list.forEach(se => {
    const cvr = cvrOf(se);
    const name = el("span", "tip-name");
    name.style.setProperty("--line", lineColour(se.o.color));
    name.append(el("i"), document.createTextNode(se.o.name || "Offer"));
    t.append(name, el("span", "tip-num", cvr.toFixed(2) + "%"), el("span", "tip-num", fmtRoas(roasAt(se.o, cvr))));
    if (withProfit) { const p = profitAt(se.v, cvr); t.append(el("strong", "tip-num" + (p < 0 ? " tip-loss" : p > 0 ? " tip-gain" : ""), money(p, 0))); }
  });
  tip.append(t);
}

function moveCrosshair(g, px, py, c) {
  const p = g.hover.parts;
  const x = g.X(c);
  const y = Math.max(g.T, Math.min(g.H - g.Bm, py));
  const yv = g.yMin + (1 - (y - g.T) / (g.H - g.T - g.Bm)) * (g.yMax - g.yMin);
  p.hv.setAttribute("x1", x); p.hv.setAttribute("x2", x);
  p.hh.setAttribute("y1", y); p.hh.setAttribute("y2", y);
  p.xt.textContent = g.A === AXES.roas ? c.toFixed(2) : c.toFixed(2) + "%";
  p.xt.setAttribute("x", x);
  const xw = p.xt.getComputedTextLength() + 14;
  p.xr.setAttribute("width", xw); p.xr.setAttribute("x", x - xw / 2);
  p.yt.textContent = compact(yv);
  p.yt.setAttribute("y", y + 4);
  const yw = p.yt.getComputedTextLength() + 12;
  p.yr.setAttribute("width", yw); p.yr.setAttribute("x", g.L - 2 - yw); p.yr.setAttribute("y", y - 10);
  g.hover.setAttribute("visibility", "visible");
}

function showChartTip(e) {
  const g = chartGeom;
  if (!g) return;
  const r = $("#chart").getBoundingClientRect();
  const px = (e.clientX - r.left) * (g.W / r.width);
  const py = (e.clientY - r.top) * (g.H / r.height);
  const c = Math.max(0, Math.min(g.xMax, (px - g.L) / (g.W - g.L - g.R) * g.xMax));
  const fmtRoas = v => (Number.isFinite(v) ? v.toFixed(2) : "–");
  const tip = $("#chartTip");
  tip.replaceChildren();
  moveCrosshair(g, px, py, c);
  const title = se => { const b = el("b"); b.style.setProperty("--line", lineColour(se.o.color)); b.append(el("i"), document.createTextNode(se.o.name || "Offer")); tip.append(b); };

  // 1. close to a dot or a ring: explain that one point
  let near = null, dist = 14;
  g.points.forEach(p => { const d = Math.hypot(p.x - px, p.y - py); if (d < dist) { dist = d; near = p; } });
  // 2. otherwise close to a line: that offer where the crosshair crosses it
  let line = null;
  if (!near) {
    let best = 12;
    g.vis.forEach(se => { const d = Math.abs(g.Y(se.at(c)) - py); if (d < best) { best = d; line = se; } });
  }
  g.overlay.style.cursor = near || line ? "pointer" : "crosshair";
  // everything sitting on the same spot as the nearest mark, control first
  const ctrlFirst = (a, b) => (b === g.series[0]) - (a === g.series[0]);
  const nearGroup = near ? g.points.filter(p => p.kind === near.kind && Math.hypot(p.x - near.x, p.y - near.y) < 4).map(p => p.s).sort(ctrlFirst) : [];
  const lineGroup = line ? g.vis.filter(se => Math.abs(g.Y(se.at(c)) - g.Y(line.at(c))) < 2).sort(ctrlFirst) : [];

  if (near && nearGroup.length > 1) {
    focusSeries(nearGroup);
    tip.append(el("b", "", near.kind === "be" ? "Break even" : "These offers overlap"));
    groupTable(tip, nearGroup, se => (near.kind === "be" ? se.be : se.cvr), fmtRoas, near.kind !== "be");
  } else if (!near && line && lineGroup.length > 1) {
    focusSeries(lineGroup);
    tip.append(el("b", "", "These offers overlap"));
    groupTable(tip, lineGroup, se => g.A.toCvr(se.o, c), fmtRoas, true);
  } else if (near) {
    const s = near.s, o = s.o;
    focusSeries(s);
    title(s);
    if (near.kind === "be") {
      tip.append(el("p", "tip-tag", "Break even"));
      tipRow(tip, "Conversion rate", s.be.toFixed(2) + "%");
      tipRow(tip, "ROAS", fmtRoas(breakEvenRoas90(o)));
      if (calc(o).extra > 0) tip.append(el("p", "tip-tag", "Counting 90-day reorders. On the first order alone it needs " + fmtRoas(breakEvenRoas(o)) + " ROAS"));
    } else {
      tipRow(tip, "Conversion rate", s.cvr.toFixed(2) + "%");
      tipRow(tip, "ROAS", fmtRoas(expectedRoas(o)));
      tipRow(tip, "Contribution profit", money(s.cp, 0));
      const m = safetyOf(o);
      if (Number.isFinite(m)) tipRow(tip, "Margin of safety", Math.round(m * 100) + "%");
      if (calc(o).extra > 0) tipRow(tip, "From reorders", money(visitors() * s.cvr / 100 * calc(o).extra, 0));
      tipRow(tip, "Break-even ROAS, first order", Number.isFinite(breakEvenRoas(o)) ? fmtRoas(breakEvenRoas(o)) : "Never");
    }
  } else if (line) {
    focusSeries(line);
    title(line);
    const cvr = g.A.toCvr(line.o, c);
    tipRow(tip, "Conversion rate", cvr.toFixed(2) + "%");
    tipRow(tip, "ROAS", fmtRoas(roasAt(line.o, cvr)));
    tipRow(tip, "Contribution profit", money(line.at(c), 0));
    tipRow(tip, "Break-even ROAS, first order", Number.isFinite(breakEvenRoas(line.o)) ? fmtRoas(breakEvenRoas(line.o)) : "Never");
  } else {
    // 3. anywhere else: the ticked offers where the crosshair sits, best first, as a small table
    focusSeries(null);
    if (!g.vis.length) { tip.append(el("p", "tip-tag", "Tick offers in the table to compare them")); }
    else {
      const t = el("div", "tip-table");
      ["Offer", "Conversion", "ROAS", "Profit /mo"].forEach(h => t.append(el("span", "tip-head", h)));
      g.vis.slice().sort((a, b) => b.at(c) - a.at(c)).forEach(se => {
        const cvr = g.A.toCvr(se.o, c);
        const name = el("span", "tip-name");
        name.style.setProperty("--line", lineColour(se.o.color));
        name.append(el("i"), document.createTextNode(se.o.name || "Offer"));
        const p = se.at(c);
        t.append(name, el("span", "tip-num", cvr.toFixed(2) + "%"), el("span", "tip-num", fmtRoas(roasAt(se.o, cvr))), el("strong", "tip-num" + (p < 0 ? " tip-loss" : p > 0 ? " tip-gain" : ""), money(p, 0)));
      });
      tip.append(t);
    }
  }
  tip.hidden = false;
  const box = $("#chartBox").getBoundingClientRect();
  const x = e.clientX - box.left;
  const flip = x + 16 + tip.offsetWidth > box.width - 8;
  tip.style.left = Math.max(8, flip ? x - 16 - tip.offsetWidth : x + 16) + "px";
  tip.style.top = Math.max(8, e.clientY - box.top - tip.offsetHeight - 14) + "px";
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 120); });

/* ---------- paste from AI: the whole simulation in one go ---------- */

const pasteDialog = $("#pasteDialog");
const pasteInput = $("#pasteInput");
const pasteError = $("#pasteError");

// The offer types, written out for an AI so it can pick the closest one for each idea.
function typesForAi() {
  return TYPES.filter(t => t.k !== "custom").map(t => {
    const keys = t.fields.map(f => '"' + f.k + '" (' + f.label.toLowerCase() + (f.type === "pct" ? ", %" : f.type === "int" ? ", a whole number" : "") + ")");
    return '- "' + t.k + '": ' + t.label + (keys.length ? ". Keys: " + keys.join(", ") : ". No extra keys");
  }).join("\n") + '\n- "custom": anything that fits none of these, or combines several. Keys: "customerPays" (what the customer pays for one order, shipping included, after every discount) and "yourCost" (everything it costs me to fulfil that order, leaving out payment fees and refunds).';
}

function simPrompt() {
  return `I'm setting up the Offer Simulator for my Shopify store. Using my Shopify and ad platform data, and the offer ideas I list at the end, reply with JSON only: no explanation, no code fences, no extra keys.

{
  "currency": "$",
  "monthlyAdSpend": 0,
  "conversionRatePercent": 0,
  "costPerClick": 0,
  "paymentFeePercent": 0,
  "refundRatePercent": 0,
  "fulfilmentPerOrder": 0,
  "control": { "name": "", "pricePerItem": 0, "costPerItem": 0, "shippingCharged": 0, "reorderRatePercent": 0 },
  "variants": [ { "name": "", "type": "", ...keys for that type, "reorderPercent": 0, "reordersEach": 1, "conversionChangePercent": 0 } ]
}

My store. "monthlyAdSpend" is average monthly ad spend across every platform over the last 90 days. "conversionRatePercent" is orders divided by sessions over the same period, like 2.4. "costPerClick" is ad spend divided by link clicks over the same period. "paymentFeePercent" is the payment processing rate, like 2.9. "refundRatePercent" is refunds as a percentage of revenue, like 3. "fulfilmentPerOrder" is what it costs me to pick, pack and ship one order.

The control is my best-selling product as I sell it today: a short name for it, its normal price, what one unit costs me (including any per-item packaging or pick fee), what the customer pays for shipping (0 if free), and the share of new customers who order again within 90 days.

The variants are the offer ideas I list at the end, up to ${MAX_OFFERS - 1}. If I list none, return an empty list. Pick the closest type for each one and fill in its keys:

${typesForAi()}

If a variant uses a different product or price from the control, add "pricePerItem", "costPerItem" and "shippingCharged" to it. "reorderPercent" is the share of customers who order again within 90 days, and "reordersEach" is how many times; leave these out for the subscription types. Set "conversionChangePercent" only when I say how much an offer should lift or lower conversion, otherwise use 0.

Every figure is a plain number with no symbol, commas or spaces. Use 0 for anything you genuinely cannot find, never estimate or invent a store figure, and if a variant needs a number I haven't given you, ask me rather than guessing.

My offer ideas:`;
}

function simAsCode() {
  const st = state.store;
  const b = baseItem();
  const c = state.offers[0];
  return JSON.stringify({
    currency: st.currency, monthlyAdSpend: st.spend, conversionRatePercent: st.cvr, costPerClick: st.cpc, paymentFeePercent: st.fee,
    refundRatePercent: st.refund, fulfilmentPerOrder: st.shipFirst,
    control: { name: c ? c.name : "Current offer", pricePerItem: b.price, costPerItem: b.unit, shippingCharged: b.ship, reorderRatePercent: c ? n(c.reorder) : 0 },
    variants: state.offers.slice(1).map(offerAsJson)
  }, null, 2);
}
function readJson(raw) {
  const text = String(raw || "").trim().replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const num = v => { const x = Number(String(v === undefined || v === null ? "" : v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(x) ? x : 0; };

function copyText(text, done) {
  const fallback = () => {
    const tmp = el("textarea");
    tmp.value = text;
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    (document.querySelector("dialog[open]") || document.body).append(tmp);
    tmp.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    tmp.remove();
    notify(ok ? done : "Your browser blocked copying. Try again in Chrome or Safari.");
  };
  try { navigator.clipboard.writeText(text).then(() => notify(done), fallback); } catch { fallback(); }
}

$("#openPaste").addEventListener("click", () => {
  pasteError.hidden = true;
  pasteInput.value = simAsCode();
  pasteDialog.showModal();
  document.body.classList.add("dialog-open");
  pasteInput.focus();
  pasteInput.setSelectionRange(0, 0);
  pasteInput.scrollTop = 0;
});
pasteDialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
$("#closePaste").addEventListener("click", () => pasteDialog.close());
$("#copyPrompt").addEventListener("click", () => copyText(simPrompt(), "AI instructions copied. Add your offer ideas at the end, then paste the reply here."));
[pasteDialog, dlg].forEach(d => d.addEventListener("click", e => {
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
}));

$("#applyPaste").addEventListener("click", () => {
  const d = readJson(pasteInput.value);
  if (!d || typeof d !== "object" || d.monthlyAdSpend === undefined) {
    pasteError.textContent = "Couldn't read that. Paste the JSON your AI returned.";
    pasteError.hidden = false;
    return;
  }
  const co = d.control || d.currentOffer || {};
  const fresh = blankState();
  fresh.axis = state.axis;
  fresh.store = {
    currency: typeof d.currency === "string" && d.currency ? d.currency.slice(0, 3) : "$",
    spend: num(d.monthlyAdSpend), cvr: num(d.conversionRatePercent), cpc: num(d.costPerClick), fee: num(d.paymentFeePercent),
    refund: num(d.refundRatePercent), shipFirst: num(d.fulfilmentPerOrder !== undefined ? d.fulfilmentPerOrder : d.fulfilmentFirstItem)
  };
  const base = { price: num(co.pricePerItem), unit: num(co.costPerItem), ship: num(co.shippingCharged) };
  const ro = Math.min(100, num(co.reorderRatePercent));
  const keep = state.example ? [] : state.offers.slice(1);
  fresh.offers = [{ id: newId("o"), name: String(co.name || "Current offer").slice(0, 60), color: COLORS[0], conv: 0, reorder: ro, reorders: 1, spec: { preset: "price", v: base } }];
  state = fresh;
  const list = Array.isArray(d.variants) ? d.variants : Array.isArray(d.offers) ? d.offers : null;
  if (list && list.length) {
    // the variants they asked the AI about
    list.slice(0, MAX_OFFERS - 1).forEach(item => {
      if (!item || typeof item !== "object") return;
      const o = offerFromJson(item, COLORS[1 + ((state.offers.length - 1) % (COLORS.length - 1))]);
      if (o) state.offers.push(o);
    });
  } else if (keep.length) {
    state.offers = state.offers.concat(keep);
  } else {
    // nothing to test yet: start them off with two common variants
    state.offers.push({ id: newId("o"), name: "20% off", color: COLORS[1], conv: 0, reorder: ro, reorders: 1, spec: { preset: "pct", v: Object.assign({ pct: 20 }, base) } });
    state.offers.push({ id: newId("o"), name: "Buy 2, get 1 free", color: COLORS[2], conv: 0, reorder: ro, reorders: 1, spec: { preset: "bxgy", v: Object.assign({ buy: 2, get: 1 }, base) } });
  }
  pasteDialog.close();
  renderAll();
  notify("Simulation filled in.");
});

$("#loadExample").addEventListener("click", () => {
  state = exampleState();
  renderAll();
  pasteInput.value = simAsCode();
  notify("Example data loaded.");
});

let resetArmed = false, resetTimer;
$("#resetAll").addEventListener("click", e => {
  const b = e.currentTarget;
  if (!resetArmed) {
    resetArmed = true;
    b.textContent = "Click Again To Erase Everything";
    b.classList.add("danger");
    resetTimer = setTimeout(() => { resetArmed = false; b.textContent = "Clear All Data"; b.classList.remove("danger"); }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetArmed = false;
  b.textContent = "Clear All Data";
  b.classList.remove("danger");
  state = blankState();
  state.offers = [{ id: newId("o"), name: "Current offer", color: COLORS[0], conv: 0, reorder: 0, reorders: 1, spec: { preset: "price", v: { price: 0, unit: 0, ship: 0 } } }];
  renderAll();
  pasteInput.value = simAsCode();
  notify("Everything erased.");
});

/* ---------- paste from AI: many offers at once ---------- */

const offersDialog = $("#offersDialog");
const offersInput = $("#offersInput");
const offersError = $("#offersError");
const ITEM_KEYS = { price: "pricePerItem", unit: "costPerItem", ship: "shippingCharged" };

// One offer as plain JSON. Preset offers keep their type, so they stay editable afterwards.
function offerAsJson(o) {
  const out = { name: o.name };
  const t = o.spec && TYPE[o.spec.preset] ? o.spec.preset : "custom";
  out.type = t;
  if (t === "custom") {
    out.customerPays = n(o.pays);
    out.yourCost = n(o.cost);
  } else {
    const v = o.spec.v, b = baseItem();
    TYPE[t].fields.forEach(f => { out[f.k] = n(v[f.k]); });
    Object.entries(ITEM_KEYS).forEach(([k, key]) => { if (n(v[k]) !== b[k]) out[key] = n(v[k]); });
  }
  if (!TYPE[t].sub) { out.reorderPercent = n(o.reorder); out.reordersEach = n(o.reorders) || 1; }
  out.conversionChangePercent = Math.round(n(o.conv));
  return out;
}
const offersAsCode = () => JSON.stringify({ offers: state.offers.slice(1).map(offerAsJson) }, null, 2);

function offersPrompt() {
  const b = baseItem();
  return `I'm comparing offers for my Shopify store in the Offer Simulator. My control sells one item at ${money(b.price)}, it costs me ${money(b.unit)} a unit, and the customer pays ${money(b.ship)} shipping.

I'll list the variants I want to test below. Reply with JSON only: no explanation, no code fences.

{ "offers": [ { "name": "", "type": "", ...keys for that type, "reorderPercent": 0, "reordersEach": 1, "conversionChangePercent": 0 } ] }

Pick the closest type for each one and fill in its keys with plain numbers:

${typesForAi()}

If a variant uses a different product or price from my control, add "pricePerItem", "costPerItem" and "shippingCharged" to it. "reorderPercent" is the share of customers who order again within 90 days, and "reordersEach" is how many times; leave these out for the subscription types. Set "conversionChangePercent" only when I say how much an offer should lift or lower conversion, otherwise use 0. If you need a number I haven't given you, ask me rather than guessing. Up to ${MAX_OFFERS - 1} variants.

My variants:`;
}

$("#openOffersPaste").addEventListener("click", () => {
  offersError.hidden = true;
  offersInput.value = offersAsCode();
  offersDialog.showModal();
  document.body.classList.add("dialog-open");
  offersInput.focus();
  offersInput.setSelectionRange(0, 0);
  offersInput.scrollTop = 0;
});
offersDialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
offersDialog.addEventListener("click", e => {
  const r = offersDialog.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) offersDialog.close();
});
$("#closeOffers").addEventListener("click", () => offersDialog.close());
$("#copyOffersPrompt").addEventListener("click", () => copyText(offersPrompt(), "AI instructions copied. List your offers at the end, then paste the reply here."));

function offerFromJson(d, color) {
  const base = state.offers[0];
  const t = TYPE[d.type] ? d.type : d.customerPays !== undefined ? "custom" : null;
  if (!t) return null;
  const o = { id: newId("o"), name: String(d.name || TYPE[t].label).slice(0, 60), color, conv: Math.max(-90, num(d.conversionChangePercent)),
    reorder: d.reorderPercent !== undefined ? Math.min(100, num(d.reorderPercent)) : base ? n(base.reorder) : 0,
    reorders: d.reordersEach !== undefined ? num(d.reordersEach) : 1, repeatLeaves: null, repeatPays: null };
  if (t === "custom") {
    Object.assign(o, { spec: { preset: "custom", v: {} }, pays: round2(num(d.customerPays)), cost: round2(num(d.yourCost)) });
  } else {
    const v = baseItem();
    Object.entries(ITEM_KEYS).forEach(([k, key]) => { if (d[key] !== undefined) v[k] = num(d[key]); });
    TYPE[t].fields.forEach(f => { v[f.k] = d[f.k] !== undefined ? num(d[f.k]) : f.def(v); });
    if (t === "freeship") v.ship = 0;
    o.spec = { preset: t, v };
    applySpec(o);
  }
  return o;
}

$("#applyOffers").addEventListener("click", () => {
  const d = readJson(offersInput.value);
  const list = d && Array.isArray(d.offers) ? d.offers : null;
  if (!list) {
    offersError.textContent = "Couldn't read that. Paste the JSON your AI returned.";
    offersError.hidden = false;
    return;
  }
  const old = state.offers.slice(1);
  const made = [];
  list.slice(0, MAX_OFFERS - 1).forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    // offers keep their colour when they come back in the same place
    const color = old[i] ? old[i].color : COLORS[1 + (made.length % (COLORS.length - 1))];
    const o = offerFromJson(item, color);
    if (o) made.push(o);
  });
  if (list.length && !made.length) {
    offersError.textContent = "None of those offers had a type this tool knows. Check the type of each one.";
    offersError.hidden = false;
    return;
  }
  state.offers = state.offers.slice(0, 1).concat(made);
  state.example = false;
  save();
  offersDialog.close();
  renderTable();
  notify(made.length === 1 ? "1 offer filled in." : made.length + " offers filled in.");
});

/* ---------- share link: the whole simulation lives in the link, nothing is stored anywhere ---------- */

const b64url = bytes => { let t = ""; bytes.forEach(x => { t += String.fromCharCode(x); }); return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64url = str => { const t = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(t, ch => ch.charCodeAt(0)); };
async function squeeze(bytes, how) {
  const stream = new Blob([bytes]).stream().pipeThrough(how === "in" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function linkState() {
  return { v: 1, axis: state.axis, store: state.store,
    offers: state.offers.map(o => ({ id: o.id, name: o.name, color: o.color, conv: round2(o.conv), reorder: o.reorder, reorders: o.reorders, dim: o.dim || undefined, spec: o.spec, pays: o.pays, cost: o.cost })) };
}
async function makeLink() {
  const raw = new TextEncoder().encode(JSON.stringify(linkState()));
  let code;
  try { code = "z" + b64url(await squeeze(raw, "in")); } catch { code = "j" + b64url(raw); }
  return location.href.split("#")[0] + "#sim=" + code;
}
async function readLink() {
  const m = location.hash.match(/^#sim=([zj])([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const bytes = unb64url(m[2]);
  const text = new TextDecoder().decode(m[1] === "z" ? await squeeze(bytes, "out") : bytes);
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.offers) || !d.offers.length) return null;
  return Object.assign(blankState(), { store: Object.assign(blankState().store, d.store), axis: d.axis || "cvr", offers: d.offers });
}
$("#copyLink").addEventListener("click", async () => {
  try { copyText(await makeLink(), "Link copied. Anyone who opens it sees this simulation."); }
  catch { notify("Couldn't make a link in this browser."); }
});
async function openFromLink() {
  try {
    const st = await readLink();
    if (!st) return;
    state = st;
    history.replaceState(null, "", location.pathname + location.search);
    renderAll();
    notify("Simulation loaded from the link.");
  } catch { notify("That link looks broken, so your own simulation is still showing."); }
}

/* ---------- print: the browser's own Print, or Save as PDF ---------- */

// redraw the chart at the printed width, then back again
const redraw = () => { clearTimeout(resizeTimer); drawChart(); };
addEventListener("beforeprint", redraw);
addEventListener("afterprint", redraw);
try { matchMedia("print").addEventListener("change", redraw); } catch {}

/* ---------- start ---------- */

function renderAll() {
  syncAxisToggle();
  state.offers.forEach(applySpec);
  save();
  syncLevers();
  renderStoreFields();
  renderTable();
}
buildTypeSelect();
renderAll();
openFromLink();
