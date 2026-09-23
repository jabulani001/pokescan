// Kostenlose Erkennung: Texterkennung (Tesseract) läuft komplett auf dem Handy.
// Gelesen werden die Sammlernummer unten („4/102“) und der Name oben.

import { createWorker } from 'tesseract.js';

let workerPromise = null;

export function loadOcr(onProgress) {
  if (!workerPromise) {
    const base = new URL('vendor/tesseract/', document.baseURI).href;
    workerPromise = createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base + 'lang',
      gzip: true,
      logger: (m) => onProgress?.(m),
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: '11' }); // verstreuter Text
      return w;
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// ---------- Nummer ----------

const PROMO = /\b(SWSH|SVP|SM|XY|BW|DP|HGSS|TG|GG|RC|SV)\s?-?\s?(\d{1,3})\b/;

function fixDigits(text) {
  // Typische Verwechsler neben Ziffern: O→0, l/I/|→1, S→5, B→8
  return text
    .replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI]|[lI](?=\d)/g, '1')
    .replace(/(?<=\d)S(?=\d)/g, '5')
    .replace(/(?<=\d)B(?=\d)/g, '8');
}

export function parseNumber(raw) {
  const text = fixDigits(raw);
  const out = { number: '', set_total: '', set_code: '', language: '' };

  const lang = text.match(/\b([A-Z]{2,4})\s+(EN|DE|FR|IT|ES|PT)\b/);
  if (lang) { out.set_code = lang[1]; out.language = lang[2].toLowerCase(); }

  // „025/198“, „4/102“, „TG05/TG30“, „GG01/GG70“
  for (const m of text.matchAll(/(?<![\w/])([A-Z]{0,2}\d{1,3})\s*[/⁄]\s*([A-Z]{0,2}\d{2,3})(?![\d])/g)) {
    const num = parseInt(m[1].replace(/\D/g, ''), 10);
    const tot = parseInt(m[2].replace(/\D/g, ''), 10);
    if (tot >= 10 && tot <= 400 && num >= 1 && num <= tot + 200) {
      out.number = m[1].replace(/^0+(?=\d)/, '');
      out.set_total = m[2].replace(/^0+(?=\d)/, '');
      return out;
    }
  }
  const promo = text.match(PROMO);
  if (promo) {
    const digits = promo[2];
    out.number = ['SWSH', 'SM', 'XY', 'BW', 'DP', 'HGSS'].includes(promo[1])
      ? promo[1] + digits.padStart(promo[1] === 'SWSH' ? 3 : 2, '0')
      : promo[1] === 'TG' || promo[1] === 'GG' || promo[1] === 'RC' ? promo[1] + digits.padStart(2, '0') : digits.replace(/^0+(?=\d)/, '');
    if (promo[1] === 'SVP' || promo[1] === 'SV') out.set_code = 'SVP';
  }
  return out;
}

// ---------- Name ----------

const STOP = new Set(('basic basis stage phase stufe hp kp pv ps evolves entwickelt from aus niveau level lv trainer pokemon pokémon '
  + 'item supporter unterstützer energy energie tool ability fähigkeit illus weakness schwäche resistance resistenz retreat rückzug '
  + 'put your deine dein this the and und').split(' '));
const SUFFIX = new Set(['v', 'vmax', 'vstar', 'gx', 'ex', 'lv.x', 'break', 'prime', 'star']);

export function parseName(raw) {
  let best = '';
  for (const line of raw.split('\n')) {
    const words = line.split(/\s+/).map((w) => w.replace(/[^A-Za-zÄÖÜäöüßé'.-]/g, '')).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.length < 3 || STOP.has(w.toLowerCase()) || !/^[A-ZÄÖÜ]/.test(w) || /^[A-Z]{3,}$/.test(w) && w.length < 4) continue;
      let name = w.replace(/[.'-]+$/, '');
      const next = words[i + 1];
      if (next && SUFFIX.has(next.toLowerCase())) name += ' ' + next;
      if (name.length > best.length) best = name;
    }
  }
  return best;
}

/**
 * Liest die Karte im Rahmen. Liefert dasselbe Format wie die Claude-Erkennung.
 */
export async function recognizeFree(camera) {
  const worker = await loadOcr();
  const bottom = camera.captureRegion(-0.2, 0.74, 1.4, 0.46, 1600);
  const { data: b } = await worker.recognize(bottom);
  const num = parseNumber(b.text);
  const top = camera.captureRegion(-0.2, -0.2, 1.4, 0.42, 1600);
  const { data: t } = await worker.recognize(top);
  const name = parseName(t.text);
  console.info('OCR unten:', JSON.stringify(b.text), '→', num, '| oben:', JSON.stringify(t.text), '→', name);

  return {
    found: !!(num.number || name.length >= 4),
    name_en: name,
    printed_name: name,
    number: num.number,
    set_total: num.set_total,
    set_code: num.set_code,
    set_name: '',
    language: num.language || '',
    variant: 'unknown',
    graded: false,
    grading_company: '',
    grade: '',
    asking_price: 0,
    asking_currency: '',
    confidence: num.number ? 0.8 : 0.4,
    ocrOnlyName: !num.number,
  };
}
