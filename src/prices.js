import { settings, saveSettings } from './store.js';

const PTCG = 'https://api.pokemontcg.io/v2/cards';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const cache = new Map();

async function getJSON(url, opts = {}, timeoutMs = 8000) {
  const key = url;
  if (cache.has(key)) return cache.get(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache.set(key, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Wechselkurs ----------

export async function refreshFx() {
  const today = new Date().toISOString().slice(0, 10);
  if (settings.fxDate === today) return;
  try {
    const d = await getJSON('https://api.frankfurter.app/latest?from=USD&to=EUR', {}, 5000);
    if (d?.rates?.EUR) saveSettings({ usdEur: d.rates.EUR, fxDate: today });
  } catch { /* Fallback: gespeicherter Kurs */ }
}
export const usdToEur = (usd) => (usd == null ? null : usd * (Number(settings.usdEur) || 0.86));

// ---------- Karten finden ----------

const cleanNumber = (n) => String(n || '').trim().replace(/^0+(?=\d)/, '');
const esc = (s) => String(s).replace(/"/g, '\\"');

function normalizePtcg(c) {
  return {
    source: 'pokemontcg',
    id: c.id,
    name: c.name,
    number: c.number,
    setTotal: String(c.set?.printedTotal ?? ''),
    setName: c.set?.name || '',
    setCode: c.set?.ptcgoCode || '',
    series: c.set?.series || '',
    releaseDate: c.set?.releaseDate || '',
    rarity: c.rarity || '',
    image: c.images?.small,
    imageLarge: c.images?.large,
    cardmarket: c.cardmarket || null,
    tcgplayer: c.tcgplayer || null,
  };
}

async function ptcgQuery(q, pageSize = 20) {
  const headers = settings.tcgKey ? { 'X-Api-Key': settings.tcgKey } : {};
  const url = `${PTCG}?q=${encodeURIComponent(q)}&pageSize=${pageSize}&orderBy=-set.releaseDate` +
    '&select=id,name,number,rarity,set,images,cardmarket,tcgplayer';
  const d = await getJSON(url, { headers });
  return (d.data || []).map(normalizePtcg);
}

async function tcgdexSearch(name, number) {
  const qs = new URLSearchParams();
  if (name) qs.set('name', name);
  if (number) qs.set('localId', `eq:${number}`);
  const list = await getJSON(`${TCGDEX}/cards?${qs}`);
  const top = (Array.isArray(list) ? list : []).slice(0, 8);
  const full = await Promise.all(top.map((c) => getJSON(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
  return full.filter(Boolean).map((c) => {
    const cm = c.pricing?.cardmarket;
    const tp = c.pricing?.tcgplayer;
    return {
      source: 'tcgdex',
      id: c.id,
      name: c.name,
      number: c.localId,
      setTotal: String(c.set?.cardCount?.official ?? ''),
      setName: c.set?.name || '',
      setCode: '',
      series: '',
      releaseDate: '',
      rarity: c.rarity || '',
      image: c.image ? `${c.image}/low.webp` : '',
      imageLarge: c.image ? `${c.image}/high.webp` : '',
      cardmarket: cm ? {
        url: cm.idProduct ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` : null,
        updatedAt: cm.updated,
        prices: {
          trendPrice: cm.trend, avg30: cm.avg30, avg7: cm.avg7, lowPrice: cm.low, averageSellPrice: cm.avg,
          reverseHoloTrend: cm['trend-holo'], reverseHoloAvg30: cm['avg30-holo'], reverseHoloLow: cm['low-holo'],
        },
      } : null,
      tcgplayer: tp ? { url: null, updatedAt: tp.updated, prices: tcgdexTcgplayer(tp) } : null,
    };
  });
}

function tcgdexTcgplayer(tp) {
  const out = {};
  for (const [k, v] of Object.entries(tp)) {
    if (v && typeof v === 'object' && ('marketPrice' in v || 'midPrice' in v)) {
      out[k] = { market: v.marketPrice, mid: v.midPrice, low: v.lowPrice, high: v.highPrice };
    }
  }
  return out;
}

function score(card, scan) {
  let s = 0;
  const num = cleanNumber(scan.number).toLowerCase();
  if (num && cleanNumber(card.number).toLowerCase() === num) s += 5;
  if (scan.set_total && card.setTotal === cleanNumber(scan.set_total)) s += 4;
  if (scan.set_code && card.setCode && card.setCode.toLowerCase() === scan.set_code.toLowerCase()) s += 4;
  if (scan.set_name && card.setName && card.setName.toLowerCase().includes(scan.set_name.toLowerCase())) s += 2;
  if (scan.name_en) {
    const want = scan.name_en.toLowerCase();
    const have = card.name.toLowerCase();
    if (have === want) s += 3;
    else if (near(have.split(' ')[0], want.split(' ')[0])) s += 2;
  }
  return s;
}

// Ähnlich genug trotz OCR-Fehlern? (Levenshtein ≤ 2)
function near(a, b) {
  if (!a || !b || Math.abs(a.length - b.length) > 2) return false;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] <= 2;
}

/** Liefert Kandidaten, bester Treffer zuerst. */
export async function findCards(scan) {
  const name = (scan.name_en || scan.printed_name || '').trim();
  const number = cleanNumber(scan.number);
  const total = cleanNumber(scan.set_total);
  let results = [];

  try {
    const tries = [];
    if (name && number) tries.push(ptcgQuery(`name:"${esc(name)}" number:"${esc(number)}"`));
    if (number && total) tries.push(ptcgQuery(`number:"${esc(number)}" set.printedTotal:${Number(total) || 0}`));
    const lists = await Promise.allSettled(tries);
    results = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!results.length && name) results = await ptcgQuery(`name:"${esc(name)}"`, 24);
    if (!results.length && number && !total) results = await ptcgQuery(`number:"${esc(number)}"`, 24);
    if (!results.length && name.includes(' ')) results = await ptcgQuery(`name:"${esc(name.split(' ')[0])}*"`, 24);
  } catch (err) {
    console.warn('pokemontcg.io fehlgeschlagen, nutze TCGdex', err);
  }

  if (!results.length) {
    try { results = await tcgdexSearch(name, number); } catch (err) { console.warn('TCGdex fehlgeschlagen', err); }
  }

  const seen = new Set();
  return results
    .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
    .map((c) => ({ c, s: score(c, scan) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/** Treffer aus dem Bildvergleich (gleiche Reihenfolge) mit aktuellen Preisen anreichern. */
export async function cardsByIds(matches) {
  const ids = matches.map((m) => m.card.id);
  let full = [];
  try {
    full = await ptcgQuery(ids.map((id) => `id:"${esc(id)}"`).join(' OR '), ids.length);
  } catch (err) {
    console.warn('Preise nicht geladen', err);
  }
  const byId = new Map(full.map((c) => [c.id, c]));
  return matches.map(({ card: c, sim }) => ({
    ...(byId.get(c.id) || {
      source: 'index', id: c.id, name: c.name, number: c.number, setTotal: c.total, setName: c.set, setCode: c.code,
      releaseDate: c.date, rarity: c.rarity, image: c.img, imageLarge: c.img, cardmarket: null, tcgplayer: null,
    }),
    sim,
  }));
}

/** Freitextsuche („Glurak 4/102“, „Pikachu SVP 27“) → scan-ähnliches Objekt. */
export function parseQuery(q) {
  const m = q.match(/([A-Za-z]{0,6}\d+[a-z]?)\s*(?:\/\s*(\d+))?\s*$/);
  const scan = { name_en: q, printed_name: q, number: '', set_total: '', set_code: '', set_name: '', variant: 'unknown' };
  if (m) {
    scan.name_en = q.slice(0, m.index).trim();
    scan.number = m[1];
    scan.set_total = m[2] || '';
    const code = scan.name_en.match(/\s([A-Z]{2,4})$/);
    if (code) { scan.set_code = code[1]; scan.name_en = scan.name_en.slice(0, code.index).trim(); }
  }
  return scan;
}

// ---------- Preise ----------

const TCGP_ORDER = {
  first_edition: ['1stEditionHolofoil', '1stEditionNormal', '1stEdition'],
  reverse_holo: ['reverseHolofoil'],
  holo: ['holofoil', 'unlimitedHolofoil'],
  normal: ['normal', 'unlimited'],
};

function pickTcgplayer(tp, variant) {
  if (!tp?.prices) return null;
  const keys = [...(TCGP_ORDER[variant] || []), 'holofoil', 'normal', 'reverseHolofoil', ...Object.keys(tp.prices)];
  for (const k of keys) {
    const p = tp.prices[k];
    if (p && (p.market ?? p.mid) != null) return { type: k, usd: p.market ?? p.mid, low: p.low, high: p.high };
  }
  return null;
}

/** RAW-Werte in EUR, Cardmarket bevorzugt (EU-Markt). */
export function rawPrices(card, variant) {
  const rows = [];
  const cm = card.cardmarket?.prices;
  if (cm) {
    const reverse = variant === 'reverse_holo' && (cm.reverseHoloTrend || cm.reverseHoloAvg30);
    const trend = reverse ? cm.reverseHoloTrend : cm.trendPrice;
    const avg30 = reverse ? cm.reverseHoloAvg30 : cm.avg30;
    const low = reverse ? cm.reverseHoloLow : cm.lowPrice;
    const main = trend || avg30 || cm.averageSellPrice;
    if (main) {
      rows.push({
        eur: main,
        label: `Cardmarket ${reverse ? 'Reverse ' : ''}Trend`,
        detail: [avg30 && `Ø30T ${fmt(avg30)}`, low && `ab ${fmt(low)}`].filter(Boolean).join(' · '),
        url: card.cardmarket.url,
        updatedAt: card.cardmarket.updatedAt,
      });
    }
  }
  const tp = pickTcgplayer(card.tcgplayer, variant);
  if (tp) {
    rows.push({
      eur: usdToEur(tp.usd),
      label: `TCGplayer ${tp.type}`,
      detail: `$${tp.usd.toFixed(2)} Market`,
      url: card.tcgplayer.url,
      updatedAt: card.tcgplayer.updatedAt,
    });
  }
  return rows;
}

const PC_GRADES = [
  ['PSA 7', 'cib-price'],
  ['PSA 8', 'new-price'],
  ['PSA 9', 'graded-price'],
  ['PSA 9.5', 'box-only-price'],
  ['PSA 10', 'manual-only-price'],
  ['BGS 10', 'bgs-10-price'],
];

/** PriceCharting (optional, Token nötig). Preise kommen in US-Cent. */
export async function priceChartingGrades(card) {
  if (!settings.pcToken) return null;
  const q = `pokemon ${card.setName} ${card.name} ${card.number}`;
  const d = await getJSON(`https://www.pricecharting.com/api/product?t=${encodeURIComponent(settings.pcToken)}&q=${encodeURIComponent(q)}`);
  if (d.status !== 'success') throw new Error(d['error-message'] || 'PriceCharting-Fehler');
  const url = `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(`${d['product-name']} ${d['console-name']}`)}`;
  const grades = PC_GRADES
    .filter(([, key]) => d[key])
    .map(([grade, key]) => ({ grade, usd: d[key] / 100, eur: usdToEur(d[key] / 100), url }));
  return { product: `${d['product-name']} (${d['console-name']})`, url, loose: d['loose-price'] ? usdToEur(d['loose-price'] / 100) : null, grades };
}

// ---------- Beweis-Links ----------

export function evidenceLinks(card) {
  const base = `pokemon ${card.name} ${card.number}${card.setTotal ? '/' + card.setTotal : ''}`;
  const ebay = (q) => `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_sop=13`;
  const links = [];
  if (card.cardmarket?.url) links.push({ label: 'Cardmarket', url: card.cardmarket.url });
  else links.push({ label: 'Cardmarket Suche', url: `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}` });
  if (card.tcgplayer?.url) links.push({ label: 'TCGplayer', url: card.tcgplayer.url });
  links.push({ label: 'eBay verkauft (raw)', url: ebay(`${base} -psa -bgs -cgc`) });
  links.push({ label: 'PriceCharting', url: `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(`${card.name} ${card.setName} ${card.number}`)}` });
  return { links, ebayGrade: (grade) => ebay(`${base} ${grade}`) };
}

// ---------- Format ----------

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export const fmt = (v) => (v == null || Number.isNaN(v) ? '–' : eurFmt.format(v));
