/**
 * Övnings-bibliotek + hjälpfunktioner (drills/, aktiva.txt, kommandotolkning,
 * grupp-behörighet, aktiv/inaktiv-styrning). Inga externa beroenden -> testbart.
 * Titlar hämtas från första raden i beskrivning.txt (snygga å/ä/ö) med
 * mappnamnet som fallback.
 */
const fs = require("fs");
const path = require("path");

const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

function asciiFold(s) {
  return String(s).toLowerCase().replace(/[åä]/g, "a").replace(/ö/g, "o").replace(/é/g, "e");
}
function prettyTitle(folderName) {
  return folderName.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}
function cleanTitle(line) {
  return String(line).replace(/^[^\p{L}0-9]+/u, "").replace(/\s*\(.*\)\s*$/, "").trim();
}
function rootOf(baseDir) { return baseDir || path.join(__dirname, ".."); }

function readDescription(dir) {
  try {
    const files = fs.readdirSync(dir);
    const df = files.find((f) => f.toLowerCase() === "beskrivning.txt") || files.find((f) => path.extname(f).toLowerCase() === ".txt");
    if (df) return fs.readFileSync(path.join(dir, df), "utf8").trim();
  } catch (_) {}
  return "";
}
function titleFrom(description, name) {
  const first = (description || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  const t = cleanTitle(first);
  return t || prettyTitle(name);
}

function readActiveSet(root) {
  const f = path.join(root, "aktiva.txt");
  const set = new Set();
  if (fs.existsSync(f)) {
    fs.readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")).forEach((n) => set.add(n.toLowerCase()));
  }
  return set;
}
function listDrillDirs(root) {
  const drillsDir = path.join(root, "drills");
  if (!fs.existsSync(drillsDir)) return [];
  return fs.readdirSync(drillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name);
}

/** Aktiva övningar (för postning), i aktiva.txt-ordning. */
function loadActiveDrills(baseDir) {
  const root = rootOf(baseDir);
  const drillsDir = path.join(root, "drills");
  const activeFile = path.join(root, "aktiva.txt");
  if (!fs.existsSync(drillsDir)) return [];
  const allDirs = listDrillDirs(root);
  let activeNames;
  if (fs.existsSync(activeFile)) {
    const listed = fs.readFileSync(activeFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    activeNames = listed.map((n) => allDirs.find((d) => d.toLowerCase() === n.toLowerCase())).filter(Boolean);
  } else {
    activeNames = allDirs.slice().sort();
  }
  return activeNames.map((name) => {
    const dir = path.join(drillsDir, name);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { return null; } // mapp borttagen under körning
    const img = files.find((f) => IMG_EXT.includes(path.extname(f).toLowerCase()));
    const description = readDescription(dir) || "(ingen beskrivning ännu)";
    return { name, title: titleFrom(description, name), description, imagePath: img ? path.join(dir, img) : null };
  }).filter(Boolean);
}

/** ALLA övningar i biblioteket med status (för /lista och /aktivera). */
function listAllDrills(baseDir) {
  const root = rootOf(baseDir);
  const active = readActiveSet(root);
  const drillsDir = path.join(root, "drills");
  return listDrillDirs(root).sort().map((name) => ({
    name,
    title: titleFrom(readDescription(path.join(drillsDir, name)), name),
    active: active.has(name.toLowerCase()),
  }));
}

function resolveDrill(root, query) {
  const all = listAllDrills(root);
  const q = asciiFold(query);
  return all.find((d) => asciiFold(d.name) === q || asciiFold(d.title) === q)
      || all.find((d) => asciiFold(d.name).includes(q) || asciiFold(d.title).includes(q)) || null;
}

/** Slår PÅ/AV en övning genom att redigera aktiva.txt. */
function setDrillActive(baseDir, query, makeActive) {
  const root = rootOf(baseDir);
  const drill = resolveDrill(root, query);
  if (!drill) {
    const names = listAllDrills(root).map((d) => d.name).join(", ");
    return { ok: false, message: `Hittade ingen övning som matchar "${query}". Finns: ${names || "(inga)"}` };
  }
  const activeFile = path.join(root, "aktiva.txt");
  let lines = fs.existsSync(activeFile) ? fs.readFileSync(activeFile, "utf8").split(/\r?\n/) : [];
  const target = drill.name.toLowerCase();
  const isActiveLine = (l) => { const t = l.trim(); return t && !t.startsWith("#") && t.toLowerCase() === target; };
  const has = lines.some(isActiveLine);
  if (makeActive) {
    if (has) return { ok: true, changed: false, name: drill.name, title: drill.title, message: `${drill.title} är redan aktiv ✅` };
    const ci = lines.findIndex((l) => l.trim().startsWith("#") && l.trim().replace(/^#\s*/, "").toLowerCase() === target);
    if (ci >= 0) lines[ci] = drill.name; else lines.push(drill.name);
  } else {
    if (!has) return { ok: true, changed: false, name: drill.name, title: drill.title, message: `${drill.title} är redan inaktiv ⬜` };
    lines = lines.filter((l) => !isActiveLine(l));
  }
  fs.writeFileSync(activeFile, lines.join("\n").replace(/\n+$/, "") + "\n", "utf8");
  return { ok: true, changed: true, name: drill.name, title: drill.title, message: `${drill.title} är nu ${makeActive ? "AKTIV ✅" : "inaktiv ⬜"}` };
}

/** Kommandotolkning: {name (foldad), arg (rå, trimmad)} eller null. */
function parseCmd(text) {
  const t = String(text).trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1);
  const sp = body.search(/\s/);
  if (sp === -1) return { name: asciiFold(body), arg: "" };
  return { name: asciiFold(body.slice(0, sp)), arg: body.slice(sp + 1).trim() };
}

function normName(s) { return asciiFold(s).replace(/\s+/g, " ").trim(); }

function isAllowed(jid, subject, config) {
  const jids = [config.allowedGroup, ...(config.allowedGroups || [])].filter(Boolean);
  const names = [config.allowedGroupName, ...(config.allowedGroupNames || [])].filter(Boolean).map(normName);
  if (jids.length === 0 && names.length === 0) return true;
  if (jids.includes(jid)) return true;
  if (names.length && typeof subject === "string" && subject && String(jid).endsWith("@g.us")) {
    if (names.includes(normName(subject))) return true;
  }
  return false;
}

module.exports = { asciiFold, prettyTitle, cleanTitle, loadActiveDrills, listAllDrills, setDrillActive, resolveDrill, IMG_EXT, parseCmd, normName, isAllowed };
