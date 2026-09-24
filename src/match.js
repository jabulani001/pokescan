// Kostenlose Erkennung per Bildvergleich, komplett auf dem Handy:
// Kamerabild → Bild-KI-Fingerabdruck → ähnlichste Karten im Index (index/emb.bin).
// Der Index wird per GitHub Action gebaut (tools/build-index.mjs) – gleiche Verarbeitung wie hier.

import { env, AutoProcessor, AutoModel, RawImage } from '@huggingface/transformers';

const base = new URL('./', document.baseURI).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = base + 'models/';

// ONNX-Laufzeit selbst ausliefern (statt CDN). Ältere Safari ohne WebGPU brauchen die Variante ohne asyncify.
const ua = navigator.userAgent;
const safariMajor = /Version\/(\d+).*Safari/.test(ua) && !/Chrome|Android/.test(ua) ? Number(RegExp.$1) : 0;
const suffix = safariMajor && safariMajor < 26 && !navigator.gpu ? '' : '.asyncify';
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${base}vendor/ort/ort-wasm-simd-threaded${suffix}.mjs`,
  wasm: `${base}vendor/ort/ort-wasm-simd-threaded${suffix}.wasm`,
};

let loading = null;

export function loadMatcher(onProgress) {
  if (!loading) {
    loading = (async () => {
      const [meta, cards, bin] = await Promise.all([
        fetch(base + 'index/meta.json').then((r) => { if (!r.ok) throw new Error('Kartenindex fehlt noch'); return r.json(); }),
        fetch(base + 'index/cards.json').then((r) => r.json()),
        fetch(base + 'index/emb.bin').then((r) => r.arrayBuffer()),
      ]);
      const files = {};
      // Wie die Pipeline „image-feature-extraction“ (siehe tools/build-index.mjs), nur ohne deren
      // Datei-Erkennung, die bei lokal ausgelieferten Modellen den Preprocessor übersieht.
      const opts = {
        dtype: meta.dtype,
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files[p.file] = [p.loaded, p.total];
            const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
            onProgress?.(l / t);
          }
        },
      };
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(meta.model, opts),
        AutoModel.from_pretrained(meta.model, opts),
      ]);
      const extractor = async (image) => {
        const { pixel_values } = await processor(image);
        const out = await model({ pixel_values });
        return out.last_hidden_state ?? out.logits ?? out.image_embeds;
      };
      return { meta, cards, emb: new Int8Array(bin), extractor };
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/** Gleiche Logik wie toVectors() in tools/build-index.mjs. */
function toVector(t) {
  const dim = t.dims.length === 3 ? t.dims[2] : t.dims[1];
  const v = t.data.slice(0, dim);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dim; j++) v[j] /= norm;
  return v;
}

/** Liefert die k ähnlichsten Karten: [{ card, sim }] (sim = Kosinus-Ähnlichkeit 0…1). */
export async function matchCard(canvas, k = 8) {
  const { meta, cards, emb, extractor } = await loadMatcher();
  const v = toVector(await extractor(RawImage.fromCanvas(canvas)));
  const { dim, scale } = meta;
  const n = cards.length;
  const top = [];
  let min = -Infinity;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) s += v[j] * emb[o + j];
    if (top.length < k || s > min) {
      top.push([i, s]);
      top.sort((a, b) => b[1] - a[1]);
      if (top.length > k) top.pop();
      min = top[top.length - 1][1];
    }
  }
  return top.map(([i, s]) => {
    const [id, name, number, set, total, code, date, rarity, img] = cards[i];
    return { sim: s / scale, card: { id, name, number, set, total: String(total), code, date, rarity, img } };
  });
}

export async function matchThreshold() {
  const { meta } = await loadMatcher();
  return meta.threshold ?? 0.5;
}
