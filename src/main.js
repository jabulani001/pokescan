import { settings, saveSettings, cart } from './store.js';
import { Camera } from './camera.js';
import { Sheet } from './sheet.js';
import { recognizeCard, searchGradedPrices } from './claude.js';
import { recognizeFree, loadOcr } from './ocr.js';
import {
  findCards, parseQuery, rawPrices, priceChartingGrades, evidenceLinks, refreshFx, usdToEur, fmt,
} from './prices.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseMoney = (s) => { const n = parseFloat(String(s).replace(/[^\d,.-]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const moneyInput = (v) => (v == null ? '' : v.toFixed(2).replace('.', ','));

const VARIANT_LABEL = {
  holo: 'Holo', reverse_holo: 'Reverse Holo', first_edition: '1. Edition', shadowless: 'Shadowless', promo: 'Promo',
};
const GRADES = ['PSA 7', 'PSA 8', 'PSA 9', 'PSA 9.5', 'PSA 10'];

// ---------- Toast & Status ----------

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function status(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `pill ${kind}`;
  $('frame').className = kind === 'busy' ? 'busy' : kind === 'ok' ? 'ok' : '';
}

// ---------- Kamera & Scan-Schleife ----------

const camera = new Camera($('video'), $('frame'), $('work-canvas'));
const sheet = new Sheet($('sheet'), $('sheet-handle'), $('sheet-body'), {
  onClose: () => {
    $('add-bar').hidden = true;
    current?.abort.abort();
    current = null;
    status(settings.autoScan ? 'Karte in den Rahmen halten' : 'Auslöser tippen zum Scannen');
  },
});

let inFlight = false;
let prevPrint = null;
let stableSince = 0;
let lastSentPrint = null;
let lastSentAt = 0;
let scanAbort = null;

const STABLE_DIFF = 6;      // max. Bildänderung zwischen zwei Frames, um als „ruhig“ zu gelten
const STABLE_MS = 350;      // so lange ruhig halten → Scan
const NEW_SCENE_DIFF = 14;  // so stark muss sich das Bild seit dem letzten Scan geändert haben
const MIN_GAP_MS = 1200;

function scanLoop() {
  if (settings.autoScan && sheet.state === 'closed' && !inFlight && document.visibilityState === 'visible'
      && $('cart-view').hidden && $('settings-view').hidden) {
    const print = camera.fingerprint();
    if (print) {
      const now = performance.now();
      const moving = Camera.diff(print, prevPrint) > STABLE_DIFF;
      prevPrint = print;
      if (moving) stableSince = now;
      const isNewScene = Camera.diff(print, lastSentPrint) > NEW_SCENE_DIFF;
      const gap = settings.engine === 'free' ? 700 : MIN_GAP_MS;
      if (!moving && now - stableSince > STABLE_MS && isNewScene && print.contrast > 18 && now - lastSentAt > gap) {
        scan(print, true);
      }
    }
  }
  setTimeout(scanLoop, 120);
}

async function scan(print = camera.fingerprint(), auto = false) {
  if (inFlight) return;
  const free = settings.engine === 'free';
  if (!free && !settings.apiKey) { openSettings(); toast('Bitte API-Key eintragen oder „Kostenlos“ wählen'); return; }
  inFlight = true;
  lastSentPrint = print;
  lastSentAt = performance.now();
  status(free ? 'Lese Karte…' : 'Erkenne Karte…', 'busy');
  const myAbort = scanAbort = new AbortController();
  try {
    const t0 = performance.now();
    const result = free ? await recognizeFree(camera) : await recognizeCard(camera.capture(), myAbort.signal);
    if (myAbort.signal.aborted) return;
    // Auto-Scan im Gratis-Modus: nur mit gelesener Nummer, sonst weiter versuchen
    const ok = result.found && result.confidence >= 0.35 && !(free && auto && result.ocrOnlyName);
    if (!ok) {
      if (free) lastSentPrint = null;
      status(free ? 'Nummer nicht lesbar – Karte genau in den Rahmen, ruhig halten' : 'Keine Karte erkannt – näher ran oder Auslöser tippen');
      return;
    }
    if (settings.vibrate) navigator.vibrate?.([30, 40, 30]);
    status(`✓ ${result.printed_name || result.name_en} ${result.number}${result.set_total ? '/' + result.set_total : ''}`, 'ok');
    console.info(`Erkennung in ${Math.round(performance.now() - t0)} ms`, result);
    await showResult(result);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    status(err.status === 401 ? 'API-Key ungültig' : `Fehler: ${err.message}`, 'err');
  } finally {
    if (scanAbort === myAbort) inFlight = false;
  }
}

// ---------- Ergebnis-Sheet ----------

let current = null; // { scan, candidates, card, abort, rawEur }

async function showResult(scanData) {
  current?.abort.abort();
  current = { scan: scanData, candidates: [], card: null, abort: new AbortController(), rawEur: null };
  const me = current;
  $('sheet-body').innerHTML = `<div class="card-head"><div style="width:96px;aspect-ratio:63/88;border-radius:6px;background:var(--panel-2)"></div>
    <div><h2>${esc(scanData.name_en || scanData.printed_name)}</h2><div class="meta">${esc(scanData.number)}${scanData.set_total ? '/' + esc(scanData.set_total) : ''} · Preise werden geladen…</div></div></div>`;
  $('add-price').value = '';
  $('add-bar').hidden = false;
  sheet.open();

  const candidates = await findCards(scanData);
  if (me !== current) return;
  me.candidates = candidates;
  if (!candidates.length) {
    $('sheet-body').insertAdjacentHTML('beforeend',
      `<p class="note">Keine Preisdaten gefunden. Versuch es mit der manuellen Suche (Lupe) oder scanne erneut.</p>
       <div class="links">${evidenceLinks({ name: scanData.name_en, number: scanData.number, setTotal: scanData.set_total, setName: scanData.set_name }).links
         .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>`);
    return;
  }
  selectCard(candidates[0]);
}

function selectCard(card) {
  const me = current;
  me.card = card;
  const scanData = me.scan;
  const variant = scanData.variant;
  const raws = rawPrices(card, variant);
  me.rawEur = raws[0]?.eur ?? null;
  const ev = evidenceLinks(card);
  const asking = scanData.asking_price > 0 ? scanData.asking_price : null;
  const myGrade = scanData.graded && scanData.grade ? `${(scanData.grading_company || 'PSA').toUpperCase()} ${scanData.grade}` : null;

  const tags = [
    card.rarity && `<span class="tag">${esc(card.rarity)}</span>`,
    VARIANT_LABEL[variant] && `<span class="tag hi">${VARIANT_LABEL[variant]}</span>`,
    scanData.language && scanData.language !== 'en' && `<span class="tag">Sprache: ${esc(scanData.language.toUpperCase())}</span>`,
    myGrade && `<span class="tag good">Slab: ${esc(myGrade)}</span>`,
  ].filter(Boolean).join('');

  let askingHtml = '';
  if (asking) {
    const diff = me.rawEur ? asking - me.rawEur : null;
    const verdict = diff == null ? '' : diff <= 0
      ? `<span class="tag good">${fmt(-diff)} unter Markt</span>`
      : `<span class="tag bad">${fmt(diff)} über Markt</span>`;
    askingHtml = `<div class="asking"><span>Preis am Stand: <b>${fmt(asking)}</b> ${verdict}</span>
      <button class="btn" id="use-asking">Übernehmen</button></div>`;
  }

  const rawRows = raws.length
    ? raws.map((r, i) => `<div class="price-row raw">
        <span class="grade">${i === 0 ? 'RAW' : ''}</span>
        <span class="src">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label)} ↗</a>` : esc(r.label)}<br>${esc(r.detail)}${r.updatedAt ? ` · Stand ${esc(r.updatedAt)}` : ''}</span>
        <span class="val">${fmt(r.eur)}</span></div>`).join('')
    : `<div class="price-row raw"><span class="grade">RAW</span><span class="src">Kein Marktpreis in der Datenbank</span><span class="val">–</span></div>`;

  const gradeRows = GRADES.map((g) => `<div class="price-row${myGrade === g ? ' mine' : ''}" data-grade="${g}">
      <span class="grade">${g}</span>
      <span class="src"><a href="${esc(ev.ebayGrade(g))}" target="_blank" rel="noopener">eBay verkauft ↗</a></span>
      <span class="val"><span class="loading">${settings.pcToken || settings.aiGraded ? 'lädt…' : '–'}</span></span></div>`).join('');

  const alts = me.candidates.length > 1 ? `<h4 class="section">Andere Version?</h4><div class="alts">${me.candidates.slice(0, 12).map((c, i) =>
    `<button data-alt="${i}" class="${c.id === card.id ? 'active' : ''}"><img src="${esc(c.image)}" loading="lazy" alt="">
      ${esc(c.setName)}<br>${esc(c.number)}/${esc(c.setTotal)}</button>`).join('')}</div>` : '';

  $('sheet-body').innerHTML = `
    <div class="card-head">
      <img src="${esc(card.image)}" alt="${esc(card.name)}">
      <div>
        <h2>${esc(card.name)}</h2>
        <div class="meta">${esc(card.setName)} · ${esc(card.number)}/${esc(card.setTotal)}${card.releaseDate ? ' · ' + esc(card.releaseDate.slice(0, 4)) : ''}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>
    ${askingHtml}
    <div class="prices">${rawRows}${gradeRows}</div>
    <div id="graded-note" class="note"></div>
    <h4 class="section">Beweise &amp; Quellen</h4>
    <div class="links">${ev.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>
    <ul id="ai-sources" class="ai-sources"></ul>
    ${alts}
    <p class="note">Erkannt: ${esc(scanData.printed_name)} ${esc(scanData.number)}${scanData.set_total ? '/' + esc(scanData.set_total) : ''} ${esc(scanData.set_code)} · Sicherheit ${Math.round((scanData.confidence || 0) * 100)} %</p>`;

  $('add-price').value = moneyInput(me.rawEur);
  $('use-asking')?.addEventListener('click', () => { $('add-price').value = moneyInput(asking); $('add-price').focus(); });
  $('sheet-body').querySelectorAll('[data-alt]').forEach((b) =>
    b.addEventListener('click', () => { current.abort.abort(); current.abort = new AbortController(); selectCard(me.candidates[+b.dataset.alt]); }));

  loadGraded(card, me);
}

function setGrade(grade, eur, srcHtml, sub = '') {
  const row = $('sheet-body').querySelector(`[data-grade="${grade}"]`);
  if (!row) return;
  row.querySelector('.val').innerHTML = `${fmt(eur)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  if (srcHtml) row.querySelector('.src').innerHTML = srcHtml;
}

function finishGraded(me) {
  if (me !== current) return;
  $('sheet-body').querySelectorAll('.price-row .loading').forEach((el) => { el.textContent = '–'; });
}

async function loadGraded(card, me) {
  const ev = evidenceLinks(card);
  const ebay = (g) => `<a href="${esc(ev.ebayGrade(g))}" target="_blank" rel="noopener">eBay verkauft ↗</a>`;
  let got = false;

  if (settings.pcToken) {
    try {
      const pc = await priceChartingGrades(card);
      if (me !== current || me.card !== card) return;
      for (const g of pc.grades) {
        setGrade(g.grade, g.eur, `<a href="${esc(pc.url)}" target="_blank" rel="noopener">PriceCharting ↗</a> · ${ebay(g.grade)}`, `$${g.usd.toFixed(2)}`);
      }
      $('graded-note').textContent = `PriceCharting: ${pc.product}`;
      got = pc.grades.length > 0;
    } catch (err) {
      console.warn('PriceCharting', err);
    }
  }

  if (!got && settings.aiGraded && settings.apiKey) {
    $('graded-note').textContent = 'Suche PSA-Verkaufspreise im Web…';
    try {
      const res = await searchGradedPrices({ ...card, variantLabel: VARIANT_LABEL[me.scan.variant] }, me.abort.signal);
      if (me !== current || me.card !== card) return;
      for (const g of res.grades) {
        const grade = String(g.grade).toUpperCase().replace(/^PSA\s*/, 'PSA ');
        const cur = String(g.currency || 'USD').toUpperCase();
        const eur = cur === 'EUR' ? g.price : cur === 'USD' ? usdToEur(g.price) : null;
        if (eur == null) continue;
        let host = '';
        try { host = new URL(g.source_url).hostname.replace(/^www\./, ''); } catch { /* ungültige URL */ }
        const src = host ? `<a href="${esc(g.source_url)}" target="_blank" rel="noopener">${esc(host)} ↗</a> · ${ebay(grade)}` : ebay(grade);
        setGrade(grade, eur, src, [cur !== 'EUR' && `${g.price} ${cur}`, g.basis].filter(Boolean).join(' · '));
      }
      $('graded-note').textContent = res.note ? `KI-Recherche: ${res.note}` : 'KI-Recherche aus Web-Quellen – Links prüfen.';
      $('ai-sources').innerHTML = res.sources.slice(0, 8)
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('');
    } catch (err) {
      if (err.name !== 'AbortError' && me === current) $('graded-note').textContent = `PSA-Suche fehlgeschlagen: ${err.message}`;
    }
  }
  finishGraded(me);
}

// ---------- In den Korb ----------

$('btn-add').addEventListener('click', () => {
  if (!current?.card && !current?.scan) return;
  const price = parseMoney($('add-price').value);
  if (price == null) { toast('Bitte einen Preis eingeben'); $('add-price').focus(); return; }
  const c = current.card;
  const s = current.scan;
  cart.add({
    name: c?.name || s.name_en,
    set: c ? `${c.setName} · ${c.number}/${c.setTotal}` : `${s.number}/${s.set_total}`,
    variant: VARIANT_LABEL[s.variant] || '',
    image: c?.image || '',
    price,
    marketRaw: current.rawEur,
    cardId: c?.id || '',
  });
  if (settings.vibrate) navigator.vibrate?.(20);
  toast(`In „${cart.active().name}“ gelegt: ${fmt(price)}`);
  sheet.close();
});
$('add-price').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-add').click(); });

// ---------- Warenkorb-Ansicht ----------

function renderCartBadge() {
  const t = cart.totals();
  $('cart-badge').hidden = t.count === 0;
  $('cart-badge').textContent = t.count;
  $('cart-total').hidden = t.count === 0;
  $('cart-total').textContent = `${cart.active().name}: ${fmt(t.mine)}`;
}

function renderCart() {
  const sel = $('list-select');
  sel.innerHTML = cart.all().map((l) => `<option value="${l.id}" ${l.id === cart.activeId() ? 'selected' : ''}>${esc(l.name)} (${l.count})</option>`).join('')
    + '<option value="__new">+ Neue Liste…</option>';
  const t = cart.totals();
  const delta = t.market - t.mine;
  $('cart-summary').innerHTML = `
    <div class="big"><div class="lbl">Summe (deine Preise) · ${t.count} Karten</div><div class="num">${fmt(t.mine)}</div></div>
    <div><div class="lbl">Marktwert RAW</div><div class="num">${fmt(t.market)}</div></div>
    <div><div class="lbl">${delta >= 0 ? 'Ersparnis' : 'Aufpreis'} ggü. Markt</div><div class="num" style="color:${delta >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmt(Math.abs(delta))}</div></div>`;
  const entries = cart.active().entries;
  $('cart-items').innerHTML = entries.length ? entries.map((e) => `
    <li data-uid="${e.uid}">
      ${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : '<span></span>'}
      <div><div class="t">${esc(e.name)}</div><div class="s">${esc(e.set)}${e.variant ? ' · ' + esc(e.variant) : ''}</div>
        <div class="s">Markt: ${fmt(e.marketRaw)}</div></div>
      <div class="r"><input value="${moneyInput(Number(e.price))}" inputmode="decimal" data-price aria-label="Preis"> €
        <div><button class="del" data-del>Entfernen</button></div></div>
    </li>`).join('') : '<li class="empty" style="display:block">Noch leer. Scanne eine Karte und tippe auf „In den Korb“.</li>';
}

$('cart-items').addEventListener('change', (e) => {
  const li = e.target.closest('li[data-uid]');
  if (li && e.target.matches('[data-price]')) {
    const v = parseMoney(e.target.value);
    if (v != null) cart.update(li.dataset.uid, { price: v });
  }
});
$('cart-items').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-uid]');
  if (li && e.target.matches('[data-del]')) cart.remove(li.dataset.uid);
});
$('list-select').addEventListener('change', (e) => {
  if (e.target.value === '__new') {
    const name = prompt('Name der neuen Liste (z. B. „Flohmarkt 12.10.“)');
    if (name) cart.createList(name.trim()); else renderCart();
  } else cart.setActive(e.target.value);
});
$('btn-list-menu').addEventListener('click', async () => {
  const choice = prompt('1 = Umbenennen\n2 = Als CSV teilen/kopieren\n3 = Liste leeren/löschen');
  if (choice === '1') {
    const n = prompt('Neuer Name', cart.active().name);
    if (n) cart.renameActive(n.trim());
  } else if (choice === '2') {
    const rows = [['Name', 'Set', 'Variante', 'Dein Preis EUR', 'Markt RAW EUR'],
      ...cart.active().entries.map((e) => [e.name, e.set, e.variant, e.price, e.marketRaw ?? ''])];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    try {
      if (navigator.share) await navigator.share({ title: cart.active().name, text: csv });
      else { await navigator.clipboard.writeText(csv); toast('CSV kopiert'); }
    } catch { /* abgebrochen */ }
  } else if (choice === '3') {
    if (confirm(`„${cart.active().name}“ wirklich löschen?`)) cart.deleteActive();
  }
});

cart.onChange(() => { renderCartBadge(); if (!$('cart-view').hidden) renderCart(); });
$('btn-cart').addEventListener('click', () => { renderCart(); $('cart-view').hidden = false; });
$('cart-total').addEventListener('click', () => $('btn-cart').click());

// ---------- Einstellungen ----------

function openSettings() {
  const f = $('settings-form');
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name] ?? '';
  }
  $('settings-view').hidden = false;
}
$('btn-settings').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  const engineChanged = patch.engine !== settings.engine;
  saveSettings(patch);
  $('settings-view').hidden = true;
  if (engineChanged && settings.engine === 'free') preloadOcr().then(() => status('Karte in den Rahmen halten'));
  toast('Gespeichert');
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));

// ---------- Buttons ----------

function renderAuto() {
  $('btn-auto').classList.toggle('on', settings.autoScan);
  $('btn-auto').setAttribute('aria-pressed', settings.autoScan);
  $('btn-auto').textContent = settings.autoScan ? 'Auto-Scan an' : 'Auto-Scan aus';
}
$('btn-auto').addEventListener('click', () => {
  saveSettings({ autoScan: !settings.autoScan });
  renderAuto();
  status(settings.autoScan ? 'Karte in den Rahmen halten' : 'Auslöser tippen zum Scannen');
});
$('btn-shutter').addEventListener('click', () => {
  if (sheet.state !== 'closed') sheet.close();
  scanAbort?.abort();
  inFlight = false;
  scan();
});
let torchOn = false;
$('btn-torch').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await camera.setTorch(torchOn); } catch { toast('Licht nicht verfügbar'); }
});
$('btn-search').addEventListener('click', () => { $('search-dialog').showModal(); $('search-form').q.focus(); });
$('search-dialog').addEventListener('close', () => {
  const q = $('search-form').q.value.trim();
  if ($('search-dialog').returnValue === 'ok' && q) {
    const s = parseQuery(q);
    showResult({ ...s, found: true, printed_name: q, language: '', graded: false, grade: '', grading_company: '', asking_price: 0, asking_currency: '', confidence: 1 });
  }
  $('search-form').q.value = '';
});

// ---------- Start ----------

async function preloadOcr() {
  status('Texterkennung lädt… (nur beim 1. Mal ~7 MB)', 'busy');
  try {
    await loadOcr((m) => {
      if (m.status && m.progress != null && m.progress < 1) status(`Texterkennung lädt… ${Math.round(m.progress * 100)} %`, 'busy');
    });
  } catch (err) {
    console.error(err);
    status('Texterkennung konnte nicht laden', 'err');
  }
}

async function start() {
  renderAuto();
  renderCartBadge();
  refreshFx();
  if (settings.engine !== 'free' && !settings.apiKey) openSettings();
  try {
    await camera.start();
    $('btn-torch').hidden = !camera.torchSupported;
    if (settings.engine === 'free') await preloadOcr();
    status(settings.autoScan ? 'Karte in den Rahmen halten' : 'Auslöser tippen zum Scannen');
    scanLoop();
  } catch (err) {
    console.error(err);
    status('Kein Kamerazugriff – Lupe für manuelle Suche', 'err');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
start();
