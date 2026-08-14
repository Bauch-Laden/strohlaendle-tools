/**
 * Bauch & Flamme – Bon-Display-Server
 * Läuft auf dem Raspberry Pi. Nimmt Bons von der Kasse entgegen und liefert
 * sowohl die Kassen-App als auch das Team-Display aus.
 *
 * Bewusst ohne externe Pakete (nur Node-Bordmittel) -> keine npm-Installation nötig.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const SERVER_VERSION = "1.8.0";  // bei jeder Änderung an dieser Datei erhöhen
const PORT = 3000;
const DONE_VISIBLE_MS = 400; // wie lange ein abgehakter Bon noch sichtbar bleibt
const SAFETY_CAP = 300;       // Notbremse gegen unbegrenztes Wachsen (offene Bons)
const UNDO_HISTORY = 10;      // so viele ausgegebene Bons lassen sich zurückholen
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(__dirname, "bons.json");
const BACKUP_DIR = path.join(__dirname, "backups");

// ---------- Zustand (überlebt einen Neustart) ----------
let bons = [];
let zuletztAusgegeben = []; // Archiv für die Rückgängig-Funktion (neueste zuerst)
try {
  if (fs.existsSync(STATE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (Array.isArray(parsed)) bons = parsed;
  }
} catch (e) {
  console.error("Konnte gespeicherte Bons nicht laden:", e.message);
}

// Entfernt nur abgehakte Bons, deren Anzeigezeit abgelaufen ist.
// Offene (bezahlte, aber noch nicht ausgegebene) Bons bleiben IMMER erhalten.
function purge() {
  const now = Date.now();
  const before = bons.length;
  const abgelaufen = bons.filter((b) => b.done && b.doneAt && now - b.doneAt > DONE_VISIBLE_MS);
  abgelaufen.forEach((b) => zuletztAusgegeben.unshift(b));
  if (zuletztAusgegeben.length > UNDO_HISTORY) zuletztAusgegeben = zuletztAusgegeben.slice(0, UNDO_HISTORY);
  bons = bons.filter((b) => !(b.done && b.doneAt && now - b.doneAt > DONE_VISIBLE_MS));
  if (bons.length > SAFETY_CAP) bons = bons.slice(0, SAFETY_CAP); // sollte nie greifen
  if (bons.length !== before) persist();
}

function persist() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(bons));
  } catch (e) {
    console.error("Konnte Bons nicht speichern:", e.message);
  }
}

// ---------- Hilfsfunktionen ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// Nimmt nur die erwarteten Felder an, damit nichts Unerwartetes ins Display gerät
function sanitizeBon(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter((i) => i && typeof i.name === "string" && Number.isFinite(Number(i.qty)))
    .slice(0, 30)
    .map((i) => ({ name: String(i.name).slice(0, 60), qty: Math.max(1, Math.min(99, Math.round(Number(i.qty)))) }));
  if (items.length === 0) return null;
  return {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    items: items,
    done: false,
    doneAt: null,
  };
}

// ---------- Server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // --- Bon entgegennehmen ---
  if (req.method === "POST" && url.pathname === "/api/bon") {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        const bon = sanitizeBon(JSON.parse(body));
        if (!bon) return sendJson(res, 400, { ok: false, error: "ungueltig" });
        bons.unshift(bon);
        purge();
        persist();
        console.log(new Date().toLocaleTimeString("de-DE"), "Bon empfangen:",
          bon.items.map((i) => i.qty + "x " + i.name).join(", "),
          "| offen:", bons.filter((b) => !b.done).length);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "kein gueltiges JSON" });
      }
    });
    return;
  }

  // --- Bon als ausgegeben markieren ---
  if (req.method === "POST" && url.pathname === "/api/bon/done") {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2000) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        const { id } = JSON.parse(body);
        const bon = bons.find((b) => b.id === id);
        if (!bon) return sendJson(res, 404, { ok: false, error: "unbekannt" });
        if (!bon.done) {
          bon.done = true;
          bon.doneAt = Date.now();
          persist();
          console.log(new Date().toLocaleTimeString("de-DE"), "Ausgegeben:",
            bon.items.map((i) => i.qty + "x " + i.name).join(", "));
        }
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "kein gueltiges JSON" });
      }
    });
    return;
  }

  // --- Zuletzt ausgegebenen Bon zurückholen ---
  if (req.method === "POST" && url.pathname === "/api/undo") {
    // Zuerst schauen, ob noch ein abgehakter Bon sichtbar ist (innerhalb der Anzeigezeit)
    const nochSichtbar = bons.filter((b) => b.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
    let wieder = null;
    if (nochSichtbar) {
      nochSichtbar.done = false;
      nochSichtbar.doneAt = null;
      wieder = nochSichtbar;
    } else if (zuletztAusgegeben.length > 0) {
      wieder = zuletztAusgegeben.shift();
      wieder.done = false;
      wieder.doneAt = null;
      bons.unshift(wieder);
    }
    if (!wieder) return sendJson(res, 404, { ok: false, error: "nichts zum Zurueckholen" });
    persist();
    console.log(new Date().toLocaleTimeString("de-DE"), "Zurueckgeholt:",
      wieder.items.map((i) => i.qty + "x " + i.name).join(", "));
    return sendJson(res, 200, { ok: true, bon: wieder });
  }

  // --- Alle offenen Bons auf einmal als ausgegeben markieren ---
  if (req.method === "POST" && url.pathname === "/api/done-all") {
    const jetzt = Date.now();
    let anzahl = 0;
    bons.forEach((b) => {
      if (!b.done) { b.done = true; b.doneAt = jetzt; anzahl++; }
    });
    if (anzahl > 0) {
      persist();
      console.log(new Date().toLocaleTimeString("de-DE"), "Alle abgehakt:", anzahl, "Bestellungen");
    }
    return sendJson(res, 200, { ok: true, anzahl: anzahl });
  }

  // --- Sicherungskopie der Kassendaten entgegennehmen ---
  if (req.method === "POST" && url.pathname === "/api/backup") {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5000000) { tooBig = true; req.destroy(); }   // 5 MB Grenze
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        JSON.parse(body);   // nur prüfen, ob es gültiges JSON ist
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
        const heute = new Date().toISOString().slice(0, 10);
        // Eine Datei pro Tag, wird jeweils überschrieben -> immer der neueste Stand
        fs.writeFileSync(path.join(BACKUP_DIR, "kasse-" + heute + ".json"), body);
        fs.writeFileSync(path.join(BACKUP_DIR, "kasse-aktuell.json"), body);
        console.log(new Date().toLocaleTimeString("de-DE"), "Kassen-Sicherung gespeichert (" + Math.round(body.length / 1024) + " KB)");
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "kein gueltiges JSON" });
      }
    });
    return;
  }

  // --- Letzte Kassen-Sicherung abrufen (für die Übersichtsseite) ---
  if (req.method === "GET" && url.pathname === "/api/backup") {
    try {
      const datei = path.join(BACKUP_DIR, "kasse-aktuell.json");
      if (!fs.existsSync(datei)) return sendJson(res, 404, { ok: false, error: "noch keine Sicherung vorhanden" });
      const inhalt = JSON.parse(fs.readFileSync(datei, "utf8"));
      return sendJson(res, 200, { ok: true, daten: inhalt });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: "Sicherung nicht lesbar" });
    }
  }

  // --- Bons abfragen (vom Display) ---
  if (req.method === "GET" && url.pathname === "/api/bons") {
    purge();
    return sendJson(res, 200, { bons: bons });
  }

  // --- Bons löschen (Schichtwechsel) ---
  if (req.method === "POST" && url.pathname === "/api/reset") {
    bons = [];
    zuletztAusgegeben = [];
    persist();
    return sendJson(res, 200, { ok: true });
  }

  // --- Statische Dateien ---
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("Verboten");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Nicht gefunden: " + safePath);
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Bauch & Flamme Bon-Server v" + SERVER_VERSION + " laeuft auf Port " + PORT);
  console.log("Kasse:   http://192.168.4.1:" + PORT + "/bf-bedienung-hilfe.html");
  console.log("Display: http://192.168.4.1:" + PORT + "/bon-display.html");
});
