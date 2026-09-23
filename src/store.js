// Alles bleibt lokal auf dem Gerät (localStorage).

const SETTINGS_KEY = 'pokescan.settings';
const LISTS_KEY = 'pokescan.lists';

const DEFAULT_SETTINGS = {
  apiKey: '',
  scanModel: 'claude-opus-5',
  aiGraded: true,
  pcToken: '',
  tcgKey: '',
  usdEur: 0.86,
  vibrate: true,
  autoScan: true,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher voll oder privat – ignorieren */
  }
}

export const settings = { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };

export function saveSettings(patch) {
  Object.assign(settings, patch);
  write(SETTINGS_KEY, settings);
}

// ---------- Listen / Warenkorb ----------

const lists = read(LISTS_KEY, null) || {
  active: 'flohmarkt',
  items: {
    flohmarkt: { name: 'Einkauf', entries: [] },
    sammlung: { name: 'Meine Sammlung', entries: [] },
  },
};

const listeners = new Set();
function commit() {
  write(LISTS_KEY, lists);
  listeners.forEach((fn) => fn());
}

export const cart = {
  onChange(fn) { listeners.add(fn); },
  all() { return Object.entries(lists.items).map(([id, l]) => ({ id, name: l.name, count: l.entries.length })); },
  activeId() { return lists.active; },
  active() { return lists.items[lists.active]; },
  setActive(id) { if (lists.items[id]) { lists.active = id; commit(); } },
  createList(name) {
    const id = 'l' + Date.now().toString(36);
    lists.items[id] = { name, entries: [] };
    lists.active = id;
    commit();
  },
  renameActive(name) { this.active().name = name; commit(); },
  deleteActive() {
    const ids = Object.keys(lists.items);
    if (ids.length <= 1) { this.active().entries = []; commit(); return; }
    delete lists.items[lists.active];
    lists.active = Object.keys(lists.items)[0];
    commit();
  },
  add(entry) {
    this.active().entries.unshift({ uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), addedAt: Date.now(), ...entry });
    commit();
  },
  update(uid, patch) {
    const e = this.active().entries.find((x) => x.uid === uid);
    if (e) { Object.assign(e, patch); commit(); }
  },
  remove(uid) {
    const l = this.active();
    l.entries = l.entries.filter((x) => x.uid !== uid);
    commit();
  },
  totals() {
    const entries = this.active().entries;
    let mine = 0, market = 0;
    for (const e of entries) {
      mine += Number(e.price) || 0;
      market += Number(e.marketRaw) || 0;
    }
    return { count: entries.length, mine, market };
  },
};
