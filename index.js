/**
 * HeadCoach — WhatsApp-bot för fotbollstränare (pojkar 2019).
 *
 * Kommandon (måste stå ENSAMMA, utom tränar-kommandon som tar ett namn):
 *   /övningar (el. /träningar) – postar dagens aktiva övningar (bild + text)
 *   /lista    – visar ALLA övningar med ✅ aktiv / ⬜ inaktiv
 *   /plan     – stationskarta: aktiva övningar utplacerade på en plan
 *   /hjälp    – kommandolista (alla kan se den)
 *   /aktivera <namn>  /avaktivera <namn>  – TRÄNAREN slår på/av en övning
 *
 * SKYDD: grupplås (config), cooldown per grupp, dubblett-spärr, tränar-kommandon
 *        bara från tränarens eget nummer (fromMe).
 *
 * Kör:  npm install  &&  npm start   (skanna QR första gången)
 */

const fs = require("fs");
const path = require("path");

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const { parseCmd, loadActiveDrills, listAllDrills, setDrillActive, isAllowed, asciiFold } = require("./lib/drills");

const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG = {
  allowedGroup: "",
  allowedGroupName: "",
  commands: ["övningar", "träningar"],
  sendDelayMs: 1500,
  cooldownSec: 60,
};
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch (e) { console.error("Kunde inte läsa config.json:", e.message); }
  return { ...DEFAULT_CONFIG };
}
const config = loadConfig();
const TRIGGER_SET = new Set(config.commands.map((c) => asciiFold(c)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// anti-spam
const recentMsgIds = new Set();
const lastPostAt = new Map();
function alreadyHandled(id) {
  if (!id) return false;
  if (recentMsgIds.has(id)) return true;
  recentMsgIds.add(id);
  if (recentMsgIds.size > 1000) recentMsgIds.delete(recentMsgIds.values().next().value); // äldsta åker ut (FIFO)
  return false;
}

// Gruppnamn-cache med TTL: lyckade svar 10 min, tomma/misslyckade 30 s —
// annars kan ett tillfälligt fel vid uppstart låsa ute gruppen till omstart.
const subjectCache = new Map(); // jid -> { subj, expiresAt }
async function groupSubject(sock, jid) {
  const hit = subjectCache.get(jid);
  if (hit && Date.now() < hit.expiresAt) return hit.subj;
  let subj = hit?.subj || "";
  try { const meta = await sock.groupMetadata(jid); subj = meta.subject || ""; } catch (_) {}
  subjectCache.set(jid, { subj, expiresAt: Date.now() + (subj ? 600_000 : 30_000) });
  return subj;
}
async function isAllowedChat(sock, jid) {
  const needName = !!(config.allowedGroupName || (config.allowedGroupNames || []).length);
  const subject = needName && String(jid).endsWith("@g.us") ? await groupSubject(sock, jid) : "";
  return isAllowed(jid, subject, config);
}
const seenGroups = new Set();
async function logGroupOnce(sock, jid) {
  if (seenGroups.has(jid)) return;
  seenGroups.add(jid);
  console.log(`👥 Grupp sedd: "${await groupSubject(sock, jid)}"  JID=${jid}`);
}

async function sendHelp(sock, jid) {
  await sock.sendMessage(jid, {
    text:
      "🤖 *HeadCoach – kommandon*\n\n" +
      "/övningar  (el. /träningar) – posta dagens aktiva övningar\n" +
      "/lista – visa alla övningar (✅ aktiv / ⬜ inaktiv)\n" +
      "/plan – stationskarta 7-manna (hel plan)\n" +
      "/plan 11 – stationskarta 11-manna (halvplan)\n" +
      "/hjälp – visa detta\n\n" +
      "*För tränaren* (från tränarens telefon):\n" +
      "/aktivera <namn> – slå PÅ en övning\n" +
      "/avaktivera <namn> – stäng AV en övning\n\n" +
      "_Skriv kommandot ensamt i meddelandet._",
  });
}

async function sendList(sock, jid) {
  const all = listAllDrills(__dirname);
  if (all.length === 0) { await sock.sendMessage(jid, { text: "Inga övningar i biblioteket ännu." }); return; }
  const nA = all.filter((d) => d.active).length;
  const lines = all.map((d) => `${d.active ? "✅" : "⬜"} ${d.title}`).join("\n");
  await sock.sendMessage(jid, {
    text: `📋 *Övningar* (${nA}/${all.length} aktiva)\n${lines}\n\n/övningar postar de aktiva (✅).`,
  });
}

async function sendPlan(sock, jid, pitch) {
  let Resvg;
  try { Resvg = require("@resvg/resvg-js").Resvg; }
  catch (e) {
    console.error("resvg saknas:", e.message);
    await sock.sendMessage(jid, { text: "Stationskartan kräver ett extra paket. Kör `npm install` i bot-mappen och starta om boten." });
    return;
  }
  const { generatePlanSvg } = require("./lib/plan");
  const active = loadActiveDrills(__dirname);
  try {
    const svg = generatePlanSvg(active, { pitch });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1080 }, font: { loadSystemFonts: true } }).render().asPng();
    const label = pitch === "half" ? "11-manna · halvplan" : "7-manna · hel plan";
    await sock.sendMessage(jid, { image: png, caption: `🗺️ Träningsplan – ${label} · ${active.length} ${active.length === 1 ? "station" : "stationer"}` });
  } catch (e) {
    console.error("Kunde inte rendera plan:", e);
    await sock.sendMessage(jid, { text: "Kunde inte skapa stationskartan just nu." });
  }
}

async function sendActiveDrills(sock, jid) {
  const drills = loadActiveDrills(__dirname);
  if (drills.length === 0) {
    await sock.sendMessage(jid, { text: "Inga aktiva övningar just nu. 🤔 Slå på med /aktivera <namn>." });
    return;
  }
  await sock.sendMessage(jid, { text: `📋 *Dagens övningar* (${drills.length} st)` });
  for (const d of drills) {
    await sleep(config.sendDelayMs);
    try {
      if (d.imagePath) await sock.sendMessage(jid, { image: { url: d.imagePath }, caption: d.description });
      else await sock.sendMessage(jid, { text: `*${d.title}*\n\n${d.description}\n\n_(ingen bild i mappen ännu)_` });
    } catch (e) { console.error(`Kunde inte skicka "${d.name}":`, e.message); }
  }
}

/** Plockar fram innehållet ur wrappers — t.ex. grupper med försvinnande meddelanden. */
function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 3 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
    if (!inner) break;
    m = inner;
  }
  return m || message;
}

async function handleMessage(sock, m) {
  if (!m.message) return;
  if (alreadyHandled(m.key && m.key.id)) return;
  const jid = m.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;
  const fromMe = !!(m.key && m.key.fromMe);

  const msg = unwrapMessage(m.message);
  const text = (msg.conversation || msg.extendedTextMessage?.text || "").trim();
  if (!text) return;
  if (jid.endsWith("@g.us")) await logGroupOnce(sock, jid);

  const cmd = parseCmd(text);
  if (!cmd) return;
  if (!(await isAllowedChat(sock, jid))) { console.log(`⛔ /${cmd.name} ignorerat — fel chatt (JID=${jid})`); return; }

  // Tränar-kommandon (kräver namn-arg + tränarens eget nummer)
  if (cmd.name === "aktivera" || cmd.name === "avaktivera") {
    if (!fromMe) { console.log(`⛔ /${cmd.name} ignorerat — endast tränaren`); return; }
    if (!cmd.arg) { await sock.sendMessage(jid, { text: `Skriv övningens namn, t.ex.  /${cmd.name} passningsring` }); return; }
    const res = setDrillActive(__dirname, cmd.arg, cmd.name === "aktivera");
    await sock.sendMessage(jid, { text: (res.ok ? "✅ " : "⚠️ ") + res.message });
    return;
  }

  // Stationskarta — kan ta variant: /plan (7-manna), /plan 11 (11-manna/halvplan)
  if (cmd.name === "plan" || cmd.name === "plan7" || cmd.name === "plan11" || cmd.name === "oversikt" || cmd.name === "karta") {
    const half = cmd.name === "plan11" || /(^|\s)(11|halv)/.test(asciiFold(cmd.arg || ""));
    return sendPlan(sock, jid, half ? "half" : "full");
  }
  // Resten måste stå ensamt
  if (cmd.arg) return;
  if (cmd.name === "hjalp" || cmd.name === "help" || cmd.name === "kommandon") return sendHelp(sock, jid);
  if (cmd.name === "lista") return sendList(sock, jid);

  if (TRIGGER_SET.has(cmd.name)) {
    const now = Date.now();
    const cooldownMs = (config.cooldownSec || 0) * 1000;
    if (cooldownMs > 0 && now - (lastPostAt.get(jid) || 0) < cooldownMs) {
      console.log(`⏳ /${cmd.name} ignorerat — cooldown (${config.cooldownSec}s)`);
      return;
    }
    lastPostAt.set(jid, now);
    console.log(`▶ /${cmd.name} — postar aktiva övningar i ${jid}`);
    return sendActiveDrills(sock, jid);
  }
}

// Återanslutning med guard (aldrig två sockets samtidigt) och exponentiell
// backoff 3s → 60s. Utan catch här dör processen på nätfel mitt i en reconnect.
let activeSock = null;
let reconnectTimer = null;
let reconnectDelayMs = 3000;
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`   Nytt försök om ${Math.round(reconnectDelayMs / 1000)}s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((e) => { console.error("Återanslutning misslyckades:", e.message); scheduleReconnect(); });
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_info"));
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
    console.log("Baileys WA-version:", version.join("."));
  } catch (_) {
    console.log("Kunde inte hämta senaste WA-version (offline?) — använder inbyggd.");
  }
  const sock = makeWASocket({
    ...(version ? { version } : {}), auth: state, logger: pino({ level: "silent" }),
    markOnlineOnConnect: false, browser: ["HeadCoach", "Chrome", "1.0.0"],
  });
  activeSock = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { console.log("\nSkanna QR-koden med WhatsApp → Länkade enheter:\n"); qrcode.generate(qr, { small: true }); }
    if (connection === "open") {
      reconnectDelayMs = 3000; // nollställ backoff
      const active = loadActiveDrills(__dirname).map((d) => d.title);
      console.log("✅ Ansluten.");
      console.log(`   Aktiva övningar (${active.length}): ${active.join(", ") || "inga"}`);
      const locks = [config.allowedGroup, ...(config.allowedGroups || []), config.allowedGroupName, ...(config.allowedGroupNames || [])].filter(Boolean);
      console.log(`   Svarar bara i: ${locks.join(", ") || "(överallt — testläge)"}  ·  cooldown ${config.cooldownSec}s`);
      console.log("   Kommandon: /övningar /träningar /lista /plan /hjälp /aktivera /avaktivera");
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`Anslutning stängd (kod ${code}). ${loggedOut ? "Utloggad." : "Återansluter…"}`);
      if (loggedOut) console.log("Radera mappen auth_info/ och starta om för att länka på nytt.");
      else scheduleReconnect();
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) { try { await handleMessage(sock, m); } catch (e) { console.error("Fel i handleMessage:", e); } }
  });
}

if (require.main === module) {
  process.on("SIGINT", () => {
    console.log("\nStänger av HeadCoach…");
    try { activeSock?.end(); } catch (_) {}
    process.exit(0);
  });
  start().catch((e) => { console.error("Fatalt fel vid start:", e); scheduleReconnect(); });
}
module.exports = { start };
