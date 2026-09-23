import Anthropic from '@anthropic-ai/sdk';
import { settings } from './store.js';

let client = null;
let clientKey = '';

function getClient() {
  if (!settings.apiKey) throw new Error('Kein Claude API-Key – bitte in den Einstellungen eintragen.');
  if (!client || clientKey !== settings.apiKey) {
    // Persönliche App: der Key liegt nur im localStorage dieses Geräts.
    client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    clientKey = settings.apiKey;
  }
  return client;
}

// Modell-spezifische Parameter: Haiku 4.5 kennt kein `effort`, Opus 5 bekommt serverseitige Refusal-Fallbacks.
function modelParams(model, { effort, thinking }) {
  if (model.startsWith('claude-haiku')) return {};
  const p = {
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
  };
  if (thinking) p.thinking = thinking;
  return p;
}

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'found', 'name_en', 'printed_name', 'number', 'set_total', 'set_code', 'set_name',
    'language', 'variant', 'graded', 'grading_company', 'grade', 'asking_price', 'asking_currency', 'confidence',
  ],
  properties: {
    found: { type: 'boolean', description: 'true, wenn eine Pokémon-Sammelkarte klar genug erkennbar ist' },
    name_en: { type: 'string', description: 'Englischer Kartenname, wie er auf der englischen Karte stünde (z. B. "Charizard ex", "Pikachu V")' },
    printed_name: { type: 'string', description: 'Name wie auf der Karte gedruckt (Originalsprache)' },
    number: { type: 'string', description: 'Sammlernummer vor dem Schrägstrich, z. B. "4", "TG05", "SWSH050", "" wenn unlesbar' },
    set_total: { type: 'string', description: 'Zahl nach dem Schrägstrich, z. B. "102", "" wenn keine' },
    set_code: { type: 'string', description: 'Set-Kürzel unten links, z. B. "SVI", "PAL", "OBF", "" wenn nicht lesbar' },
    set_name: { type: 'string', description: 'Beste Vermutung des englischen Set-Namens, z. B. "Base Set", "Obsidian Flames"' },
    language: { type: 'string', enum: ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'zh', 'other'] },
    variant: { type: 'string', enum: ['normal', 'holo', 'reverse_holo', 'first_edition', 'shadowless', 'promo', 'unknown'] },
    graded: { type: 'boolean', description: 'Karte steckt in einem Grading-Slab' },
    grading_company: { type: 'string', description: 'PSA, BGS, CGC, … oder ""' },
    grade: { type: 'string', description: 'Note auf dem Slab, z. B. "10", "9", oder ""' },
    asking_price: { type: 'number', description: 'Preis auf Sticker/Hülle/Schild, 0 wenn keiner sichtbar' },
    asking_currency: { type: 'string', description: 'z. B. "EUR", "" wenn kein Preis' },
    confidence: { type: 'number', description: '0 bis 1' },
  },
};

const SCAN_PROMPT = `Du identifizierst Pokémon-Sammelkarten auf Handyfotos (Flohmarkt, Binder, Hüllen, Toploader, Slabs, schräge Winkel, Spiegelungen).
Lies Name, Sammlernummer (unten links/rechts, z. B. "4/102"), Set-Kürzel und Variante. Ist die Karte nicht englisch, gib zusätzlich den englischen Namen an (z. B. Glurak → Charizard).
Wenn auf der Hülle/einem Sticker/Schild ein Preis steht, gib ihn als asking_price zurück.
Wenn keine Karte klar erkennbar ist, setze found=false und fülle die restlichen Felder leer. Rate keine Nummern, die du nicht lesen kannst.`;

/** Erkennt eine Karte auf einem JPEG (base64 ohne Prefix). */
export async function recognizeCard(base64, signal) {
  const model = settings.scanModel;
  const res = await getClient().beta.messages.create(
    {
      model,
      max_tokens: 1024,
      ...modelParams(model, { effort: 'low', thinking: { type: 'disabled' } }),
      output_config: {
        ...(model.startsWith('claude-haiku') ? {} : { effort: 'low' }),
        format: { type: 'json_schema', schema: CARD_SCHEMA },
      },
      system: SCAN_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: 'Welche Karte ist das?' },
        ],
      }],
    },
    { signal },
  );
  if (res.stop_reason === 'refusal') throw new Error('Anfrage wurde abgelehnt.');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Leere Antwort von Claude.');
  return JSON.parse(text);
}

/** Gradete Preise (PSA 7–10) per Websuche, mit Quellen-Links. */
export async function searchGradedPrices(card, signal) {
  const model = 'claude-opus-5';
  const label = `${card.name} ${card.number}${card.setTotal ? '/' + card.setTotal : ''} – ${card.setName}${card.variantLabel ? ' (' + card.variantLabel + ')' : ''}`;
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }];
  const messages = [{
    role: 'user',
    content: `Pokémon-Karte: ${label}.
Finde aktuelle Verkaufspreise (bevorzugt abgeschlossene Verkäufe der letzten ~3 Monate, z. B. PriceCharting, eBay sold, 130point, Cardmarket) für PSA 7, PSA 8, PSA 9 und PSA 10 genau dieser Karte/Version.
Antworte am Ende ausschließlich mit einem JSON-Codeblock:
\`\`\`json
{"grades":[{"grade":"PSA 10","price":123.45,"currency":"USD","source_url":"https://…","basis":"z. B. Ø 5 Verkäufe"}],"note":"kurzer Hinweis"}
\`\`\`
Lass Noten weg, für die du keine belastbare Quelle findest. Jede Zahl braucht eine source_url.`,
  }];

  const sources = new Map();
  let res;
  // pause_turn: Server-Tool-Schleife hat pausiert → Antwort anhängen und fortsetzen.
  for (let i = 0; i < 3; i++) {
    res = await getClient().beta.messages.create(
      {
        model,
        max_tokens: 8000,
        ...modelParams(model, { effort: 'low' }),
        tools,
        messages,
      },
      { signal },
    );
    for (const block of res.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  if (res.stop_reason === 'refusal') throw new Error('Anfrage wurde abgelehnt.');

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  let parsed = { grades: [], note: '' };
  const raw = blocks.length ? blocks[blocks.length - 1][1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { parsed = JSON.parse(raw); } catch { /* ohne JSON: nur Quellen anzeigen */ }
  return { grades: parsed.grades || [], note: parsed.note || '', sources: [...sources].map(([url, title]) => ({ url, title })) };
}
