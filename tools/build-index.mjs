// Baut den Bild-Index für die kostenlose Erkennung:
//  1. alle Karten von pokemontcg.io holen
//  2. jedes Kartenbild mit einem kleinen Bild-KI-Modell in einen Vektor („Fingerabdruck“) umwandeln
//  3. Vektoren als int8 speichern (index/emb.bin) + Kartenliste (index/cards.json)
//  4. Modell-Dateien nach models/ kopieren, damit die App sie selbst ausliefert
//  5. Test mit künstlich „verschlechterten“ Fotos → index/validation.json
//
// Läuft in GitHub Actions (braucht Internet). Lokal: `node tools/build-index.mjs`.
// Bereits eingebettete Karten werden wiederverwendet, neue Karten kommen dazu.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env, pipeline, RawImage } from '@huggingface/transformers';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'index');
const MODELS_OUT = path.join(ROOT, 'models');
const CACHE = path.join(ROOT, '.model-cache');
const API = 'https://api.pokemontcg.io/v2/cards';
const API_KEY = process.env.POKEMONTCG_API_KEY || '';
const LIMIT = Number(process.env.CARD_LIMIT || 0); // zum Testen: nur N Karten

const MODEL_CANDIDATES = [
  { id: 'onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX', dtype: 'q8' },
  { id: 'Xenova/dinov2-small', dtype: 'q8' },
  { id: 'Xenova/clip-vit-base-patch32', dtype: 'q8' },
];

env.cacheDir = CACHE;
env.allowLocalModels = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchRetry(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return res;
    } catch (err) {
      if (err.fatal || i >= tries - 1) throw err;
      await sleep(2000 * 2 ** i);
    }
  }
}

// ---------- 1. Karten ----------

async function fetchAllCards() {
  const cards = [];
  const headers = API_KEY ? { 'X-Api-Key': API_KEY } : {};
  for (let page = 1; ; page++) {
    const url = `${API}?page=${page}&pageSize=250&orderBy=set.releaseDate,number&select=id,name,number,rarity,set,images`;
    const d = await (await fetchRetry(url, { headers })).json();
    for (const c of d.data) {
      if (!c.images?.small) continue;
      cards.push({
        id: c.id,
        name: c.name,
        number: c.number,
        set: c.set?.name || '',
        setId: c.set?.id || '',
        total: c.set?.printedTotal ?? '',
        code: c.set?.ptcgoCode || '',
        date: c.set?.releaseDate || '',
        rarity: c.rarity || '',
        img: c.images.small,
      });
    }
    log(`Seite ${page}: ${cards.length} / ${d.totalCount}`);
    if (page * 250 >= d.totalCount || !d.data.length) break;
    if (LIMIT && cards.length >= LIMIT) break;
  }
  return LIMIT ? cards.slice(0, LIMIT) : cards;
}

// ---------- 2. Modell ----------

async function loadModel() {
  for (const cand of MODEL_CANDIDATES) {
    try {
      log('Lade Modell', cand.id, cand.dtype);
      const extractor = await pipeline('image-feature-extraction', cand.id, { dtype: cand.dtype, device: 'cpu' });
      return { ...cand, extractor };
    } catch (err) {
      log('  → nicht verfügbar:', err.message.slice(0, 200));
    }
  }
  throw new Error('Kein Modell ladbar');
}

/** Tensor → normierte Vektoren (CLS-Token bei Transformern). Muss exakt zu src/match.js passen. */
function toVectors(t) {
  const [n] = t.dims;
  const dim = t.dims.length === 3 ? t.dims[2] : t.dims[1];
  const stride = t.dims.length === 3 ? t.dims[1] * dim : dim;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(t.data.buffer, t.data.byteOffset + i * stride * 4, dim).slice();
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) v[j] /= norm;
    out.push(v);
  }
  return out;
}

async function embedBuffers(model, buffers) {
  const imgs = await Promise.all(buffers.map((b) => RawImage.fromBlob(new Blob([b]))));
  const t = await model.extractor(imgs);
  return toVectors(t);
}

// ---------- 3. Index ----------

async function readOldIndex(modelId) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(OUT, 'meta.json'), 'utf8'));
    if (meta.model !== modelId) return new Map();
    const cards = JSON.parse(await fs.readFile(path.join(OUT, 'cards.json'), 'utf8'));
    const bin = await fs.readFile(path.join(OUT, 'emb.bin'));
    const q = new Int8Array(bin.buffer, bin.byteOffset, bin.length);
    const map = new Map();
    cards.forEach((c, i) => {
      const v = new Float32Array(meta.dim);
      for (let j = 0; j < meta.dim; j++) v[j] = q[i * meta.dim + j] / meta.scale;
      map.set(c[0], v);
    });
    log(`Alter Index: ${map.size} Karten wiederverwendbar`);
    return map;
  } catch {
    return new Map();
  }
}

async function download(url) {
  return Buffer.from(await (await fetchRetry(url)).arrayBuffer());
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// ---------- 5. Test mit simulierten Handyfotos ----------

async function distort(buf, rnd) {
  const r = (a, b) => a + rnd() * (b - a);
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  // Karte etwas größer/kleiner/verschoben im Rahmen, leicht gedreht, Licht, Unschärfe, Spiegelung, JPEG
  const scale = r(0.88, 1.08);
  const cw = Math.round(W * scale), ch = Math.round(H * scale);
  let img = await sharp(buf).resize(cw, ch).rotate(r(-6, 6), { background: { r: 90, g: 80, b: 70 } })
    .modulate({ brightness: r(0.7, 1.25), saturation: r(0.8, 1.2) }).blur(r(0.3, 1.4)).toBuffer();
  const m2 = await sharp(img).metadata();
  const canvas = sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 80, b: 70 } } });
  const left = Math.round((W - m2.width) / 2 + r(-0.05, 0.05) * W);
  const top = Math.round((H - m2.height) / 2 + r(-0.05, 0.05) * H);
  const cropL = Math.max(0, -left), cropT = Math.max(0, -top);
  img = await sharp(img).extract({ left: cropL, top: cropT, width: Math.min(m2.width - cropL, W - Math.max(0, left)), height: Math.min(m2.height - cropT, H - Math.max(0, top)) }).toBuffer();
  const gx = Math.round(r(0.1, 0.9) * W), gy = Math.round(r(0.1, 0.9) * H);
  const glare = Buffer.from(`<svg width="${W}" height="${H}"><defs><radialGradient id="g"><stop offset="0" stop-color="white" stop-opacity="${r(0.3, 0.7)}"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient></defs><ellipse cx="${gx}" cy="${gy}" rx="${W * r(0.15, 0.4)}" ry="${H * r(0.08, 0.2)}" fill="url(#g)"/></svg>`);
  return canvas.composite([{ input: img, left: Math.max(0, left), top: Math.max(0, top) }, { input: glare }])
    .jpeg({ quality: Math.round(r(45, 80)) }).toBuffer();
}

function search(vec, emb, dim, count, k = 5) {
  const top = [];
  for (let i = 0; i < count; i++) {
    let s = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) s += vec[j] * emb[o + j];
    if (top.length < k || s > top[top.length - 1][1]) {
      top.push([i, s]);
      top.sort((a, b) => b[1] - a[1]);
      if (top.length > k) top.pop();
    }
  }
  return top;
}

async function validate(model, cards, emb, dim, scale, sample = 200) {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const picks = Array.from({ length: Math.min(sample, cards.length) }, () => Math.floor(rnd() * cards.length));
  let top1 = 0, top5 = 0, top1Name = 0;
  const posSims = [], negSims = [];
  for (const idx of picks) {
    const c = cards[idx];
    const q = await distort(await download(c.img), rnd);
    const [v] = await embedBuffers(model, [q]);
    const res = search(v, emb, dim, cards.length).map(([i, s]) => [i, s / scale]);
    if (res[0][0] === idx) top1++;
    if (res.some(([i]) => i === idx)) top5++;
    if (cards[res[0][0]].name === c.name) top1Name++;
    posSims.push(res[0][1]);
  }
  // Negative: Zufallsbilder ohne Karte (Rauschen, Verläufe, Tischfläche)
  for (let n = 0; n < 40; n++) {
    const W = 245, H = 342;
    const noise = Buffer.alloc(W * H * 3);
    const base = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let p = 0; p < noise.length; p++) noise[p] = Math.max(0, Math.min(255, base[p % 3] + (rnd() - 0.5) * 120 * (n % 2)));
    const img = await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).blur(n % 3 + 0.5).jpeg().toBuffer();
    const [v] = await embedBuffers(model, [img]);
    negSims.push(search(v, emb, dim, cards.length, 1)[0][1] / scale);
  }
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return +s[Math.floor(p * (s.length - 1))].toFixed(3); };
  const report = {
    samples: picks.length,
    top1: +(top1 / picks.length).toFixed(3),
    top5: +(top5 / picks.length).toFixed(3),
    top1SameName: +(top1Name / picks.length).toFixed(3),
    positiveSim: { p10: q(posSims, 0.1), p50: q(posSims, 0.5), p90: q(posSims, 0.9) },
    negativeSim: { p50: q(negSims, 0.5), p90: q(negSims, 0.9), max: q(negSims, 1) },
  };
  report.suggestedThreshold = +(Math.max(report.negativeSim.max + 0.02, report.positiveSim.p10 - 0.05)).toFixed(3);
  return report;
}

// ---------- Main ----------

async function main() {
  const cards = await fetchAllCards();
  log(`${cards.length} Karten`);
  const model = await loadModel();
  const old = await readOldIndex(model.id);

  const vectors = new Array(cards.length);
  const todo = [];
  cards.forEach((c, i) => { if (old.has(c.id)) vectors[i] = old.get(c.id); else todo.push(i); });
  log(`${todo.length} neue Karten einbetten`);

  const BATCH = 16;
  let done = 0, failed = 0;
  const t0 = Date.now();
  for (let b = 0; b < todo.length; b += BATCH * 8) {
    const chunk = todo.slice(b, b + BATCH * 8);
    const bufs = new Array(chunk.length);
    await pool(chunk, 16, async (idx, k) => {
      try { bufs[k] = await download(cards[idx].img); } catch { bufs[k] = null; }
    });
    for (let s = 0; s < chunk.length; s += BATCH) {
      const ids = [], bb = [];
      for (let k = s; k < Math.min(s + BATCH, chunk.length); k++) if (bufs[k]) { ids.push(chunk[k]); bb.push(bufs[k]); } else failed++;
      if (!bb.length) continue;
      const vs = await embedBuffers(model, bb);
      ids.forEach((idx, k) => { vectors[idx] = vs[k]; });
      done += bb.length;
    }
    const rate = done / ((Date.now() - t0) / 1000);
    log(`eingebettet ${done}/${todo.length} (${rate.toFixed(1)}/s, Fehler ${failed})`);
  }

  // Karten ohne Bild/Vektor rauswerfen
  const keep = cards.map((c, i) => i).filter((i) => vectors[i]);
  const dim = vectors[keep[0]].length;
  let maxAbs = 0;
  for (const i of keep) for (const x of vectors[i]) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = Math.floor(127 / maxAbs);
  const emb = new Int8Array(keep.length * dim);
  keep.forEach((i, r) => { for (let j = 0; j < dim; j++) emb[r * dim + j] = Math.round(vectors[i][j] * scale); });
  const kept = keep.map((i) => cards[i]);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'emb.bin'), Buffer.from(emb.buffer));
  // Kompakt: [id, name, number, set, total, code, date, rarity, img]
  await fs.writeFile(path.join(OUT, 'cards.json'),
    JSON.stringify(kept.map((c) => [c.id, c.name, c.number, c.set, c.total, c.code, c.date, c.rarity, c.img])));

  // Modell-Dateien für die App kopieren
  const src = path.join(CACHE, model.id);
  const dst = path.join(MODELS_OUT, model.id);
  await fs.rm(MODELS_OUT, { recursive: true, force: true });
  await fs.mkdir(dst, { recursive: true });
  await fs.cp(src, dst, { recursive: true });
  const files = [];
  for await (const f of await fs.opendir(dst, { recursive: true })) if (f.isFile()) files.push(path.relative(dst, path.join(f.parentPath ?? f.path, f.name)));
  log('Modell-Dateien:', files.join(', '));

  log('Validierung…');
  const validation = await validate(model, kept, emb, dim, scale);
  log('Validierung:', JSON.stringify(validation));

  await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify({
    model: model.id, dtype: model.dtype, dim, scale, count: kept.length,
    built: new Date().toISOString(), threshold: validation.suggestedThreshold, validation,
  }, null, 2));
  log('Fertig.');
}

main().catch((err) => { console.error(err); process.exit(1); });
