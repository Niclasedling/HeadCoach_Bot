/**
 * Stationskarta: utzoomad plan med aktiva övningar utplacerade.
 * Två varianter:  pitch:"full" (7-manna, hel plan)  ·  pitch:"half" (11-manna, halvplan).
 * Positioner per övning (mappnamn) i LAYOUT; okända övningar auto-placeras.
 * Ren sträng-generator (inga beroenden) -> testbar. Rasteriseras i index.js.
 */
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PX0 = 160, PY0 = 175, PW = 760, PH = 585;
const CX = PX0 + PW / 2, CY = PY0 + PH / 2, BOTTOM = PY0 + PH;

// Positioner enligt Niclas skiss (mappnamn -> [x,y]).
const LAYOUT = {
  full: {
    "direkt-skott":      [CX, PY0 + 105],          // avslut vid övre målet
    "stafett-1mot1":     [PX0 + 165, PY0 + 130],   // uppe vänster
    "tvamals-sma-mal":   [PX0 + PW - 165, PY0 + 130], // uppe höger
    "passningsring":     [PX0 + PW - 150, CY],     // höger mitt
    "tvamals-stora-mal": [CX, BOTTOM - 105],        // nedre målet
  },
  half: {
    "direkt-skott":      [CX, PY0 + 120],            // övre målet
    "tvamals-sma-mal":   [PX0 + PW - 155, PY0 + 175], // uppe höger
    "tvamals-stora-mal": [PX0 + 145, CY - 10],        // vänster
    "passningsring":     [CX, BOTTOM - 115],          // nedre mitten (vid mittlinjen)
    "stafett-1mot1":     [PX0 + PW - 165, BOTTOM - 135], // nere höger
  },
};
const FALLBACK = {
  full: [[PX0 + 200, PY0 + 120], [PX0 + 560, PY0 + 120], [PX0 + 200, CY], [PX0 + 560, CY], [PX0 + 200, BOTTOM - 120], [PX0 + 560, BOTTOM - 120], [CX, CY]],
  half: [[PX0 + 200, PY0 + 150], [PX0 + 560, PY0 + 150], [PX0 + 200, PY0 + 350], [PX0 + 560, PY0 + 350], [PX0 + 380, BOTTOM - 130], [CX, PY0 + 250]],
};

function pitchMarkings(pitch) {
  let f = `<rect x="${PX0}" y="${PY0}" width="${PW}" height="${PH}" fill="none" stroke="#ffffff" stroke-width="4"/>`;
  // övre mål + straffområde (båda varianter)
  f += `<rect x="${CX - 95}" y="${PY0}" width="190" height="74" fill="none" stroke="#ffffff" stroke-width="3"/>`;
  f += `<rect x="${CX - 45}" y="${PY0 - 13}" width="90" height="13" fill="#ffffff" fill-opacity="0.25" stroke="#ffffff" stroke-width="3"/>`;
  if (pitch === "full") {
    f += `<line x1="${PX0}" y1="${CY}" x2="${PX0 + PW}" y2="${CY}" stroke="#ffffff" stroke-width="4"/>`;
    f += `<circle cx="${CX}" cy="${CY}" r="62" fill="none" stroke="#ffffff" stroke-width="4"/><circle cx="${CX}" cy="${CY}" r="5" fill="#ffffff"/>`;
    f += `<rect x="${CX - 95}" y="${BOTTOM - 74}" width="190" height="74" fill="none" stroke="#ffffff" stroke-width="3"/>`;
    f += `<rect x="${CX - 45}" y="${BOTTOM}" width="90" height="13" fill="#ffffff" fill-opacity="0.25" stroke="#ffffff" stroke-width="3"/>`;
  } else {
    // halvplan: nedre kanten = mittlinje, halv mittcirkel som bågar uppåt
    f += `<path d="M ${CX - 62} ${BOTTOM} A 62 62 0 0 1 ${CX + 62} ${BOTTOM}" fill="none" stroke="#ffffff" stroke-width="4"/>`;
    f += `<circle cx="${CX}" cy="${BOTTOM}" r="5" fill="#ffffff"/>`;
  }
  return f;
}

function generatePlanSvg(drills, opts = {}) {
  const pitch = opts.pitch === "half" ? "half" : "full";
  const W = 1080, H = 1080;
  const n = drills.length;
  const palette = ["#1565c0", "#e53935", "#ff7a00", "#2e9b53", "#8e44ad", "#00897b", "#d81b60", "#3949ab", "#f9a825", "#5d4037"];

  // positioner
  const used = LAYOUT[pitch] || {};
  const fb = (FALLBACK[pitch] || []).slice();
  const pos = drills.map((d) => used[d.name] || fb.shift() || [CX, CY]);

  let discs = "";
  for (let i = 0; i < n; i++) {
    const [x, y] = pos[i];
    discs += `<circle cx="${x}" cy="${y}" r="30" fill="${palette[i % palette.length]}" stroke="#ffffff" stroke-width="3"/>` +
             `<text x="${x}" y="${y + 9}" text-anchor="middle" font-size="30" font-weight="700" fill="#ffffff">${i + 1}</text>`;
  }

  const perCol = Math.ceil(n / 2) || 1;
  const colX = [70, 560], startY = 832, rowH = 50;
  let legend = "";
  for (let i = 0; i < n; i++) {
    const c = i < perCol ? 0 : 1, r = i < perCol ? i : i - perCol;
    const x = colX[c], y = startY + r * rowH;
    let t = drills[i].title || drills[i].name || "?";
    if (t.length > 28) t = t.slice(0, 27) + "…";
    legend += `<circle cx="${x + 16}" cy="${y - 8}" r="15" fill="${palette[i % palette.length]}" stroke="#ffffff" stroke-width="2"/>` +
              `<text x="${x + 16}" y="${y - 1}" text-anchor="middle" font-size="18" font-weight="700" fill="#ffffff">${i + 1}</text>` +
              `<text x="${x + 42}" y="${y}" font-size="24" fill="#ffffff">${escapeXml(t)}</text>`;
  }
  if (n === 0) legend = `<text x="540" y="860" text-anchor="middle" font-size="26" fill="#ffffff">Inga aktiva övningar — slå på med /aktivera</text>`;

  const sub = pitch === "half"
    ? `11-manna · halvplan · ${n} ${n === 1 ? "station" : "stationer"}`
    : `7-manna · hel plan · ${n} ${n === 1 ? "station" : "stationer"}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#1f7a34"/>
  <g fill="#1c7030"><rect x="0" y="150" width="180" height="${H - 150}"/><rect x="360" y="150" width="180" height="${H - 150}"/><rect x="720" y="150" width="180" height="${H - 150}"/></g>
  <rect x="0" y="0" width="${W}" height="150" fill="#14532d"/>
  <text x="540" y="76" text-anchor="middle" font-size="52" font-weight="700" fill="#ffffff">TRÄNINGSPLAN</text>
  <text x="540" y="120" text-anchor="middle" font-size="27" fill="#d8f3dc">${sub}</text>
  ${pitchMarkings(pitch)}
  <rect x="0" y="788" width="${W}" height="${H - 788}" fill="#14532d"/>
  ${discs}
  ${legend}
</svg>`;
}

module.exports = { generatePlanSvg };
