# PokéScan – Pokémon-Karten per Handykamera bewerten

Web-App (PWA) fürs Handy: Kamera auf eine Karte halten (auch im Binder, in Hülle oder Slab). Die Karte wird erkannt, dann fährt ein Sheet von unten hoch mit:

- **RAW-Preis** (Cardmarket-Trend in €, dazu Ø 30 Tage und „ab“-Preis, außerdem TCGplayer Market)
- **PSA 7 / 8 / 9 / 9.5 / 10**, jeweils mit Quelle
- **Beweis-Links**: Cardmarket, TCGplayer, verkaufte eBay-Angebote (raw und pro PSA-Note), PriceCharting
- **Preis am Stand**: steht ein Preis auf Hülle oder Sticker, wird er mitgelesen und mit dem Marktpreis verglichen
- **In den Korb**: Preis ist mit dem RAW-Wert vorausgefüllt und lässt sich vorher ändern (z. B. 8 € → 5 €)

Der Korb unterstützt mehrere Listen (z. B. „Einkauf“, „Meine Sammlung“). Für jede Liste siehst du die Summe deiner Preise, den Marktwert und die Ersparnis. Export als CSV über Teilen.

## Bedienung

| Geste | Wirkung |
|---|---|
| Karte ruhig in den Rahmen halten | Auto-Scan startet (Vibration + grüner Rahmen bei Treffer) |
| Großer Auslöser | Sofort scannen |
| Sheet hochwischen / Griff tippen | Vollbild |
| Sheet runterwischen | Halb → zu (Scanner läuft weiter) |
| Lupe | Manuelle Suche, z. B. `Glurak 4/102` |
| „Andere Version?“ | Falls das Set falsch erkannt wurde, andere Druckversion wählen |

## Wie es funktioniert

1. **Erkennung:** Nur der Bildausschnitt im Rahmen geht als JPEG an die Claude-API (Structured Output → Name, Nummer, Set, Variante, Slab-Note, Standpreis). Der Auto-Scan schickt erst ein Bild, wenn es ruhig ist und sich seit dem letzten Scan verändert hat. So bleibt es schnell, und es werden keine unnötigen Anfragen verschickt.
2. **RAW-Preise:** [pokemontcg.io](https://pokemontcg.io) (Cardmarket + TCGplayer), mit [TCGdex](https://tcgdex.dev) als Fallback.
3. **PSA-Preise:**
   - mit PriceCharting-API-Token (optional, kostenpflichtig) sofort und exakt;
   - sonst per Claude-Websuche im Hintergrund (~10–20 s), mit Quell-Links. RAW-Preise stehen schon vorher da.
4. **USD → EUR:** Tageskurs von frankfurter.app, sonst der Kurs aus den Einstellungen.

Alle Schlüssel und Listen liegen nur im `localStorage` deines Handys.

## Einrichten

1. Hosten über HTTPS (Kamera braucht HTTPS), z. B. mit GitHub Pages: *Settings → Pages → Deploy from branch*. Dann `https://jabulani001.github.io/pokescan/` öffnen.
2. Beim ersten Start den **Claude API-Key** eintragen (console.anthropic.com).
3. Im Browser-Menü „Zum Startbildschirm hinzufügen“ wählen. Danach startet die App im Vollbild.

Modell-Wahl in den Einstellungen: *Claude Opus 5* (Standard, genauer) oder *Claude Haiku 4.5* (am schnellsten und günstigsten). Beim Flohmarkt lohnt sich Haiku, wenn dir Tempo am wichtigsten ist.

## Entwickeln

```bash
npm install
npm run build        # bündelt src/ → app.js (wird mit eingecheckt, damit Pages ohne Build läuft)
python3 -m http.server 8080
```

Grenzen: pokemontcg.io kennt nur englische Drucke. Deutsche Karten werden über den englischen Namen und die Nummer gefunden. Für japanische Karten gibt es oft keine Preisdaten, dann helfen die eBay-/PriceCharting-Links.
