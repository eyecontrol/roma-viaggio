/* Roma in Tasca — app statica, nessun server.
 * Dati: OpenStreetMap (Nominatim, Overpass), Wikipedia/Wikidata per immagini e descrizioni.
 * Le liste sono salvate nel browser (localStorage) del dispositivo.
 */
'use strict';

// SHA-256 di "roma2026". Nota: e' solo un cancello, non vera sicurezza (il codice e' pubblico).
const PASS_HASH = 'acc173a22405a1801d9220bc3ec670b6f2256026072ee6b86b2dcf02e4e77ac9';
const ROME_VIEWBOX = '12.23,42.10,12.86,41.65'; // left,top,right,bottom
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const WALK_M_PER_MIN = 75;
const SUGGESTED = ['Colosseo', 'Fontana di Trevi', 'Pantheon', 'Musei Vaticani', 'Basilica di San Pietro',
  'Galleria Borghese', 'Castel Sant\'Angelo', 'Piazza Navona', 'Fori Imperiali', 'Trastevere',
  'Piazza di Spagna', 'Terme di Caracalla', 'Bocca della Verità', 'Gianicolo'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- Storage ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('Impossibile salvare sul dispositivo'); } },
};
const lists = {
  places: store.get('roma.places', []),
  food: store.get('roma.food', []),
};
const filters = { places: 'todo', food: 'todo' };
function save(kind) { store.set(kind === 'places' ? 'roma.places' : 'roma.food', lists[kind]); }

/* ---------------- Utils ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function dist(a, b) { // metri
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km');
const walkMin = (m) => Math.max(1, Math.round((m * 1.3) / WALK_M_PER_MIN));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const gmapsDir = (it, mode = 'transit') =>
  `https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lon}&travelmode=${mode}`;
const gmapsPlace = (it) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.name + ' ' + (it.address || 'Roma'))}`;
const googleInfo = (it, extra) =>
  `https://www.google.com/search?q=${encodeURIComponent(it.name + ' Roma ' + extra)}`;

const DAYS = { Mo: 'Lun', Tu: 'Mar', We: 'Mer', Th: 'Gio', Fr: 'Ven', Sa: 'Sab', Su: 'Dom', PH: 'Festivi', SH: 'Vacanze' };
const MONTHS = { Jan: 'gen', Feb: 'feb', Mar: 'mar', Apr: 'apr', May: 'mag', Jun: 'giu', Jul: 'lug', Aug: 'ago', Sep: 'set', Oct: 'ott', Nov: 'nov', Dec: 'dic' };
function fmtHours(oh) {
  if (!oh) return '';
  if (oh.trim() === '24/7') return 'Sempre aperto';
  return oh.split(/\s*;\s*/).map((p) => p
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b/g, (d) => DAYS[d])
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (m) => MONTHS[m])
    .replace(/\boff\b|\bclosed\b/gi, 'chiuso')
    .replace(/\bopen\b/gi, 'aperto')
    .replace(/,(?=\S)/g, ', ')
  ).join('\n');
}
function fmtPrice(tags) {
  if (!tags) return '';
  if (tags.charge) return tags.charge.replace(/EUR/g, '€');
  if (tags.fee === 'no') return 'Ingresso gratuito';
  if (tags.fee === 'yes') return 'A pagamento (prezzo non indicato)';
  return '';
}
const CAT = {
  museum: 'Museo', attraction: 'Attrazione', monument: 'Monumento', church: 'Chiesa', place_of_worship: 'Luogo di culto',
  archaeological_site: 'Sito archeologico', ruins: 'Rovine', fountain: 'Fontana', square: 'Piazza', park: 'Parco',
  viewpoint: 'Belvedere', castle: 'Castello', gallery: 'Galleria', artwork: 'Opera d\'arte', palace: 'Palazzo',
  memorial: 'Memoriale', garden: 'Giardino', restaurant: 'Ristorante', cafe: 'Caffè', bar: 'Bar', pub: 'Pub',
  fast_food: 'Street food', ice_cream: 'Gelateria', pedestrian: 'Strada', neighbourhood: 'Quartiere', suburb: 'Quartiere',
  quarter: 'Rione', bakery: 'Forno', pastry: 'Pasticceria', basilica: 'Basilica', cathedral: 'Cattedrale', stadium: 'Stadio',
};
const catLabel = (t) => CAT[t] || (t ? t.replace(/_/g, ' ') : '');
const CUISINE = { pizza: 'Pizza', italian: 'Italiana', regional: 'Romana/regionale', roman: 'Romana', seafood: 'Pesce',
  japanese: 'Giapponese', chinese: 'Cinese', indian: 'Indiana', burger: 'Burger', kebab: 'Kebab', sushi: 'Sushi',
  vegetarian: 'Vegetariana', vegan: 'Vegana', ice_cream: 'Gelato', coffee_shop: 'Caffetteria', sandwich: 'Panini', pasta: 'Pasta' };
const fmtCuisine = (c) => (c ? c.split(/[;,]/).map((x) => CUISINE[x.trim()] || x.trim().replace(/_/g, ' ')).join(', ') : '');

/* ---------------- Login ---------------- */
async function initLogin() {
  if (store.get('roma.auth') === PASS_HASH) return showApp();
  $('#login').hidden = false;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const h = await sha256($('#pwd').value.trim());
    if (h === PASS_HASH) { store.set('roma.auth', h); showApp(); }
    else { $('#loginErr').hidden = false; $('#pwd').select(); }
  });
}
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  initApp();
}

/* ---------------- Search (Nominatim) ---------------- */
function normNominatim(r) {
  const a = r.address || {};
  const road = [a.road || a.pedestrian || a.square, a.house_number].filter(Boolean).join(' ');
  return {
    osm: r.osm_type + '/' + r.osm_id,
    name: r.name || r.display_name.split(',')[0],
    lat: +r.lat, lon: +r.lon,
    address: [road, a.suburb || a.quarter || a.neighbourhood].filter(Boolean).join(', '),
    kind: r.type, cls: r.category || r.class,
    tags: r.extratags || {},
  };
}
async function nominatim(q, limit = 8) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&namedetails=0` +
    `&accept-language=it&limit=${limit}&viewbox=${ROME_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  return (await getJSON(u)).map(normNominatim);
}
const FOOD_TYPES = /^(restaurant|cafe|fast_food|pub|bar|ice_cream|food_court|biergarten|bakery|pastry|confectionery|deli)$/;

function renderResults(box, items, kind, onPick) {
  if (!items.length) { box.innerHTML = '<div class="info">Nessun risultato. Prova con un altro nome.</div>'; return; }
  box.innerHTML = items.map((it, i) => `
    <div class="result">
      <div class="txt">
        <div class="name">${esc(it.name)}</div>
        <div class="sub">${esc([catLabel(it.kind), it.address].filter(Boolean).join(' · '))}</div>
      </div>
      <button class="btn small primary" data-i="${i}">${onPick ? 'Scegli' : '+ Aggiungi'}</button>
    </div>`).join('') + '<div class="info"><a href="#" data-clear>Chiudi risultati</a></div>';
  box.onclick = (e) => {
    if (e.target.closest('[data-clear]')) { e.preventDefault(); box.innerHTML = ''; return; }
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = items[+b.dataset.i];
    if (onPick) { onPick(it); box.innerHTML = ''; return; }
    addItem(kind, it); b.textContent = '✓ Aggiunto'; b.disabled = true;
  };
}

async function doSearch(kind, q) {
  const box = kind === 'places' ? $('#placesResults') : $('#foodResults');
  if (!q.trim()) return;
  box.innerHTML = '<div class="info"><span class="spin"></span> Cerco…</div>';
  try {
    let res = await nominatim(q, 10);
    if (kind === 'food') {
      const food = res.filter((r) => FOOD_TYPES.test(r.kind));
      res = food.length ? food : res;
    }
    renderResults(box, res, kind);
  } catch (err) {
    box.innerHTML = '<div class="info">Ricerca non riuscita. Controlla la connessione e riprova.</div>';
  }
}

/* ---------------- Enrichment (immagine, descrizione) ---------------- */
async function wikiSummary(lang, title) {
  const d = await getJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  return {
    image: d.originalimage?.width && d.originalimage.width <= 1600 ? d.originalimage.source
      : d.thumbnail?.source ? d.thumbnail.source.replace(/\/\d+px-/, '/800px-') : '',
    extract: d.extract,
    wiki: d.content_urls?.desktop?.page,
  };
}
const commonsUrl = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=800`;

async function enrich(it, kind) {
  const t = it.tags || {};
  const out = {};
  try {
    if (t.wikipedia) {
      const [lang, ...rest] = t.wikipedia.split(':');
      Object.assign(out, await wikiSummary(rest.length ? lang : 'it', rest.length ? rest.join(':') : lang));
    }
  } catch {}
  try {
    if (t.wikidata && (!out.image || !out.extract)) {
      const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${t.wikidata}&props=sitelinks|claims&format=json&origin=*`);
      const ent = d.entities?.[t.wikidata];
      const p18 = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!out.image && p18) out.image = commonsUrl(p18);
      const sl = ent?.sitelinks?.itwiki || ent?.sitelinks?.enwiki;
      if (sl && !out.extract) {
        const s = await wikiSummary(sl.site === 'itwiki' ? 'it' : 'en', sl.title);
        out.extract = s.extract; out.wiki = s.wiki; out.image = out.image || s.image;
      }
      const web = ent?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (web && !it.website) out.website = web;
    }
  } catch {}
  if (!out.image && t.image && /^https?:/.test(t.image)) out.image = t.image;
  if (!out.image && t.wikimedia_commons && /^File:/.test(t.wikimedia_commons)) out.image = commonsUrl(t.wikimedia_commons.slice(5));
  // Luoghi senza tag Wikipedia: cerca la voce piu' vicina con lo stesso nome
  if (kind === 'places' && !out.image) {
    try {
      const g = await getJSON(`https://it.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${it.lat}|${it.lon}&gsradius=300&gslimit=10&format=json&origin=*`);
      const words = it.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const hit = (g.query?.geosearch || []).find((p) => words.some((w) => p.title.toLowerCase().includes(w))) ;
      if (hit) {
        const s = await wikiSummary('it', hit.title);
        out.image = s.image; out.extract = out.extract || s.extract; out.wiki = out.wiki || s.wiki;
      }
    } catch {}
  }
  return out;
}

function addItem(kind, c) {
  const list = lists[kind];
  if (c.osm && list.some((x) => x.osm === c.osm)) { toast('È già nella tua lista'); return; }
  const t = c.tags || {};
  const it = {
    id: uid(), osm: c.osm || null, name: c.name, lat: c.lat ?? null, lon: c.lon ?? null,
    address: c.address || '', kind: c.kind || (kind === 'food' ? 'restaurant' : ''),
    hours: fmtHours(t.opening_hours), price: fmtPrice(t),
    website: t.website || t['contact:website'] || '', phone: t.phone || t['contact:phone'] || '',
    cuisine: fmtCuisine(t.cuisine), tags: t, notes: '', done: false, loading: true, added: Date.now(),
  };
  list.unshift(it); save(kind); renderList(kind); refreshDestSelect();
  toast('Aggiunto: ' + it.name);
  enrich(it, kind).then((extra) => {
    const cur = lists[kind].find((x) => x.id === it.id); if (!cur) return;
    Object.assign(cur, { image: extra.image || '', extract: extra.extract || '', wiki: extra.wiki || '', loading: false });
    if (extra.website && !cur.website) cur.website = extra.website;
    save(kind); renderList(kind);
  });
}

/* ---------------- Lists ---------------- */
const emoji = (kind, it) => (kind === 'food' ? (/(cafe|bar)/.test(it.kind) ? '☕' : /ice_cream/.test(it.kind) ? '🍨' : /pizza/i.test(it.cuisine) ? '🍕' : '🍝') : '🏛️');
let posNow = null; // ultima posizione nota

function renderList(kind) {
  const box = kind === 'places' ? $('#placesList') : $('#foodList');
  const f = filters[kind];
  if (f === 'map') return renderListMap(kind, box);
  const items = lists[kind].filter((x) => (f === 'done' ? x.done : !x.done));
  if (!items.length) {
    box.innerHTML = `<div class="empty">${f === 'done' ? 'Ancora niente qui.' :
      kind === 'places' ? 'Cerca un luogo qui sopra e aggiungilo alla lista.' : 'Cerca un ristorante o trova quelli vicini a te.'}</div>`;
    return;
  }
  box.innerHTML = items.map((it) => {
    const d = posNow && it.lat != null ? fmtDist(dist(posNow, it)) : '';
    const firstHours = it.hours ? it.hours.split('\n')[0] : '';
    return `
    <div class="item ${it.done ? 'done' : ''}" data-id="${it.id}">
      <div class="thumb" data-open style="${it.image ? `background-image:url('${esc(it.image)}')` : ''}">${it.image ? '' : it.loading ? '<span class="spin"></span>' : emoji(kind, it)}</div>
      <div class="body">
        <div class="title" data-open>${esc(it.name)}</div>
        <div class="meta">
          ${it.kind ? `<span>${esc(catLabel(it.kind))}</span>` : ''}
          ${it.cuisine ? `<span>🍴 ${esc(it.cuisine)}</span>` : ''}
          ${d ? `<span>📍 ${d}</span>` : ''}
        </div>
        <div class="meta">
          ${firstHours ? `<span>🕒 ${esc(firstHours)}${it.hours.includes('\n') ? '…' : ''}</span>` : ''}
          ${it.price ? `<span>💶 ${esc(it.price)}</span>` : ''}
        </div>
        <div class="acts">
          ${it.lat != null ? `<a class="btn small" href="${gmapsDir(it)}" target="_blank" rel="noopener">🧭 Indicazioni</a>
          <button class="btn small" data-bus>🚌 Che bus?</button>` : ''}
          <button class="btn small" data-open>Dettagli</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

let listMaps = {};
function renderListMap(kind, box) {
  const pts = lists[kind].filter((x) => x.lat != null);
  box.innerHTML = pts.length ? `<div class="list-map" id="lm-${kind}"></div>` : '<div class="empty">Nessun elemento con posizione da mostrare.</div>';
  if (!pts.length || !window.L) return;
  if (listMaps[kind]) listMaps[kind].remove();
  const m = L.map('lm-' + kind);
  baseTiles().addTo(m);
  const group = L.featureGroup(pts.map((it) =>
    L.marker([it.lat, it.lon], { icon: emojiIcon(it.done ? '✅' : emoji(kind, it)) })
      .bindPopup(`<b>${esc(it.name)}</b><br><a href="${gmapsDir(it)}" target="_blank" rel="noopener">Indicazioni</a>`))).addTo(m);
  if (posNow) L.marker([posNow.lat, posNow.lon], { icon: emojiIcon('🧍') }).addTo(m);
  m.fitBounds(group.getBounds().pad(0.15), { maxZoom: 16 });
  listMaps[kind] = m;
}

function onListClick(kind) {
  return (e) => {
    const card = e.target.closest('.item'); if (!card) return;
    const it = lists[kind].find((x) => x.id === card.dataset.id); if (!it) return;
    if (e.target.closest('[data-bus]')) { planTo(it); return; }
    if (e.target.closest('[data-open]')) openDetail(kind, it);
  };
}

/* ---------------- Detail ---------------- */
function openDetail(kind, it) {
  const isFood = kind === 'food';
  const body = $('#modalBody');
  body.innerHTML = `
    <div class="hero" style="${it.image ? `background-image:url('${esc(it.image)}')` : ''}">${it.image ? '' : emoji(kind, it)}</div>
    <div class="dbody">
      <div>
        <h2>${esc(it.name)}</h2>
        <div class="muted small">${esc([catLabel(it.kind), it.address].filter(Boolean).join(' · '))}</div>
      </div>
      ${it.extract ? `<div class="extract">${esc(it.extract)} ${it.wiki ? `<a href="${esc(it.wiki)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}</div>` : ''}
      <div class="facts">
        ${it.cuisine ? `<div class="fact"><span>🍴</span><span class="v">${esc(it.cuisine)}</span></div>` : ''}
        ${it.phone ? `<div class="fact"><span>📞</span><a href="tel:${esc(it.phone.replace(/\s/g, ''))}">${esc(it.phone)}</a></div>` : ''}
        ${it.website ? `<div class="fact"><span>🌐</span><a href="${esc(it.website)}" target="_blank" rel="noopener">${esc(it.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></div>` : ''}
        ${it.lat != null && posNow ? `<div class="fact"><span>📍</span><span>${fmtDist(dist(posNow, it))} da te</span></div>` : ''}
      </div>
      <div class="edit-row">
        <label>🕒 Orari di apertura</label>
        <textarea data-f="hours" placeholder="Non disponibili: aggiungili tu">${esc(it.hours)}</textarea>
      </div>
      <div class="edit-row">
        <label>💶 ${isFood ? 'Prezzo medio' : 'Prezzo biglietto'}</label>
        <input data-f="price" value="${esc(it.price)}" placeholder="Non disponibile: aggiungilo tu">
      </div>
      <div class="btns">
        <a class="btn small" href="${googleInfo(it, isFood ? 'orari menu prezzi' : 'orari biglietti prezzi')}" target="_blank" rel="noopener">🔎 Cerca orari e prezzi aggiornati</a>
        <a class="btn small" href="${gmapsPlace(it)}" target="_blank" rel="noopener">⭐ Recensioni su Maps</a>
      </div>
      <div class="edit-row">
        <label>📝 Note</label>
        <textarea data-f="notes" placeholder="Es. prenotare, chiuso il lunedì, da vedere al tramonto…">${esc(it.notes)}</textarea>
      </div>
      ${it.lat != null ? `<div class="btns">
        <a class="btn primary" href="${gmapsDir(it, 'transit')}" target="_blank" rel="noopener">🚋 Con i mezzi</a>
        <a class="btn" href="${gmapsDir(it, 'walking')}" target="_blank" rel="noopener">🚶 A piedi</a>
        <button class="btn" data-bus>🚌 Che bus prendo?</button>
      </div>` : ''}
      <div class="btns">
        <button class="btn" data-done>${it.done ? '↩️ Segna come da fare' : isFood ? '✅ Segna come provato' : '✅ Segna come visitato'}</button>
        <button class="btn danger" data-del>🗑️ Elimina</button>
      </div>
    </div>`;
  body.oninput = (e) => {
    const f = e.target.dataset.f; if (!f) return;
    it[f] = e.target.value; save(kind);
    clearTimeout(body._r); body._r = setTimeout(() => renderList(kind), 400);
  };
  body.onclick = (e) => {
    if (e.target.closest('[data-done]')) { it.done = !it.done; save(kind); renderList(kind); closeModal(); toast(it.done ? 'Fatto! ✓' : 'Rimesso in lista'); }
    else if (e.target.closest('[data-del]')) {
      if (!confirm('Eliminare "' + it.name + '"?')) return;
      lists[kind] = lists[kind].filter((x) => x.id !== it.id); save(kind); renderList(kind); refreshDestSelect(); closeModal();
    } else if (e.target.closest('[data-bus]')) { closeModal(); planTo(it); }
  };
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }

/* ---------------- Manual add / nearby food ---------------- */
function manualFood() {
  const name = prompt('Nome del ristorante:'); if (!name || !name.trim()) return;
  addItem('food', { name: name.trim(), tags: {}, kind: 'restaurant' });
}
async function nearbyFood() {
  const box = $('#foodResults');
  box.innerHTML = '<div class="info"><span class="spin"></span> Cerco la tua posizione…</div>';
  try {
    const p = await locate();
    box.innerHTML = '<div class="info"><span class="spin"></span> Cerco ristoranti vicini…</div>';
    const q = `[out:json][timeout:25];nwr(around:700,${p.lat},${p.lon})[amenity~"^(restaurant|cafe|fast_food|pub|bar|ice_cream)$"][name];out center tags 80;`;
    const d = await overpass(q);
    const items = d.elements.map((e) => ({
      osm: e.type + '/' + e.id, name: e.tags.name, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
      address: [e.tags['addr:street'], e.tags['addr:housenumber']].filter(Boolean).join(' '),
      kind: e.tags.amenity, tags: e.tags,
    })).filter((x) => x.lat != null)
      .map((x) => ({ ...x, d: dist(p, x) })).sort((a, b) => a.d - b.d).slice(0, 40)
      .map((x) => ({ ...x, address: [fmtDist(x.d), fmtCuisine(x.tags.cuisine), x.address].filter(Boolean).join(' · ') }));
    renderResults(box, items, 'food');
    // l'indirizzo mostrato contiene la distanza: ripulisci quando aggiungi
    items.forEach((x) => { x.address = [x.tags['addr:street'], x.tags['addr:housenumber']].filter(Boolean).join(' '); });
  } catch (err) {
    box.innerHTML = `<div class="info">${esc(err.message || 'Errore')}. Riprova tra poco.</div>`;
  }
}

/* ---------------- Geolocation ---------------- */
function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Geolocalizzazione non supportata'));
    navigator.geolocation.getCurrentPosition(
      (p) => { posNow = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; res(posNow); },
      (e) => rej(new Error(e.code === 1 ? 'Permesso posizione negato: attivalo nelle impostazioni del browser' : 'Posizione non disponibile')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

/* ---------------- Overpass ---------------- */
async function overpass(q) {
  let last;
  for (const ep of OVERPASS) {
    try {
      return await getJSON(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (e) { last = e; }
  }
  throw new Error('Servizio fermate non raggiungibile (' + (last?.message || '') + ')');
}
const ROUTE_RE = '^(bus|trolleybus|tram|subway|light_rail|train)$';
function stopsQuery(p, r) {
  return `[out:json][timeout:30];
(
  node(around:${r},${p.lat},${p.lon})[highway=bus_stop];
  node(around:${r},${p.lat},${p.lon})[public_transport~"^(platform|stop_position)$"];
  way(around:${r},${p.lat},${p.lon})[public_transport=platform];
  node(around:${r + 300},${p.lat},${p.lon})[railway~"^(tram_stop|station|halt|stop)$"];
)->.s;
.s out center;
(rel(bn.s)[type=route][route~"${ROUTE_RE}"];rel(bw.s)[type=route][route~"${ROUTE_RE}"];)->.r;
.r out body;`;
}
// Restituisce { stops: Map key->{name,lat,lon,d,keys:Set}, routes: Map relId->{ref,mode,to,from,name,idx:Map key->posizione} }
async function stopsAround(p, r = 400) {
  const d = await overpass(stopsQuery(p, r));
  const elems = new Map(), routes = new Map();
  for (const e of d.elements) {
    if (e.type === 'relation') {
      const idx = new Map();
      e.members.forEach((m, i) => { const k = m.type[0] + m.ref; if (!idx.has(k)) idx.set(k, i); });
      const t = e.tags || {};
      routes.set(e.id, { id: e.id, ref: t.ref || t.name || '?', mode: t.route, to: t.to || '', from: t.from || '', name: t.name || '', idx });
    } else {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null) continue;
      elems.set(e.type[0] + e.id, { key: e.type[0] + e.id, name: e.tags?.name || '', lat, lon, d: dist(p, { lat, lon }) });
    }
  }
  // linee che passano per ogni elemento
  for (const el of elems.values()) {
    el.routes = [...routes.values()].filter((rt) => rt.idx.has(el.key));
  }
  return { elems, routes };
}
function groupStops(elems) { // unisci per nome (piattaforma + stop_position della stessa fermata)
  const by = new Map();
  for (const el of elems.values()) {
    if (!el.routes.length && !el.name) continue;
    const name = el.name || 'Fermata senza nome';
    const g = by.get(name) || { name, d: Infinity, lat: el.lat, lon: el.lon, lines: new Map() };
    if (el.d < g.d) { g.d = el.d; g.lat = el.lat; g.lon = el.lon; }
    el.routes.forEach((r) => g.lines.set(r.mode + r.ref, r));
    by.set(name, g);
  }
  return [...by.values()].filter((g) => g.lines.size).sort((a, b) => a.d - b.d);
}
const MODE_IT = { bus: 'Bus', trolleybus: 'Filobus', tram: 'Tram', subway: 'Metro', light_rail: 'Treno', train: 'Treno' };
const lineBadge = (r) => `<span class="line ${esc(r.mode)}">${r.mode === 'subway' ? 'Metro ' : ''}${esc(r.ref)}</span>`;
function sortLines(a, b) {
  const order = { subway: 0, tram: 1, train: 2, light_rail: 2, trolleybus: 3, bus: 4 };
  return (order[a.mode] - order[b.mode]) || String(a.ref).localeCompare(String(b.ref), 'it', { numeric: true });
}

/* ---------------- Transit tab ---------------- */
let map, mapLayer, dest = null, nearCache = null;
const baseTiles = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const emojiIcon = (e) => L.divIcon({ html: `<div style="font-size:24px;line-height:24px">${e}</div>`, className: '', iconSize: [24, 24], iconAnchor: [12, 22] });
function ensureMap() {
  if (!window.L) return null;
  $('#map').classList.add('on');
  if (!map) { map = L.map('map', { zoomControl: true }); baseTiles().addTo(map); mapLayer = L.layerGroup().addTo(map); }
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

async function findNearby() {
  const st = $('#locStatus');
  st.innerHTML = '<span class="spin"></span> Rilevo la posizione…';
  try {
    const p = await locate();
    st.innerHTML = '<span class="spin"></span> Cerco fermate vicine…';
    nearCache = { p, data: await stopsAround(p, 400) };
    const groups = groupStops(nearCache.data.elems).slice(0, 15);
    st.textContent = `Posizione trovata (precisione ±${Math.round(p.acc)} m). ${groups.length} fermate entro 400 m.`;
    $('#stopsTitle').hidden = !groups.length;
    $('#stopsList').innerHTML = groups.length ? groups.map((g) => `
      <div class="stop">
        <div class="h"><span>${esc(g.name)}</span><span class="d">${fmtDist(g.d)} · ${walkMin(g.d)} min a piedi</span></div>
        <div class="lines">${[...g.lines.values()].sort(sortLines).map(lineBadge).join('')}</div>
      </div>`).join('') : '<div class="empty">Nessuna fermata trovata qui vicino.</div>';
    const m = ensureMap();
    if (m) {
      mapLayer.clearLayers();
      L.marker([p.lat, p.lon], { icon: emojiIcon('🧍') }).addTo(mapLayer).bindPopup('Sei qui');
      groups.forEach((g) => L.circleMarker([g.lat, g.lon], { radius: 7, color: '#a63d24', fillOpacity: .9 })
        .bindPopup(`<b>${esc(g.name)}</b><br>${[...g.lines.values()].sort(sortLines).map((r) => esc(r.ref)).join(', ')}`).addTo(mapLayer));
      if (dest) L.marker([dest.lat, dest.lon], { icon: emojiIcon('🏁') }).addTo(mapLayer);
      m.setView([p.lat, p.lon], 16);
    }
    renderList('places'); renderList('food');
    updatePlanBtn();
  } catch (err) {
    st.textContent = err.message;
  }
}

function refreshDestSelect() {
  const sel = $('#destSelect'); const cur = sel.value;
  const opt = (kind, label) => {
    const xs = lists[kind].filter((x) => x.lat != null);
    return xs.length ? `<optgroup label="${label}">${xs.map((x) => `<option value="${kind}:${x.id}">${esc(x.name)}</option>`).join('')}</optgroup>` : '';
  };
  sel.innerHTML = '<option value="">— Scegli dai tuoi luoghi e ristoranti —</option>' + opt('places', 'Luoghi') + opt('food', 'Ristoranti');
  sel.value = cur;
}
function setDest(d) {
  dest = d;
  $('#destChosen').hidden = !d;
  $('#destChosen').textContent = d ? '🏁 ' + d.name : '';
  updatePlanBtn();
}
function updatePlanBtn() { $('#planBtn').disabled = !dest; }

function planTo(it) {
  switchTab('transit');
  setDest({ name: it.name, lat: it.lat, lon: it.lon, address: it.address });
  window.scrollTo({ top: 0 });
  plan();
}

async function plan() {
  if (!dest) return;
  const out = $('#planOut');
  out.innerHTML = '<div class="plan"><span class="spin"></span> Calcolo le linee…</div>';
  try {
    if (!nearCache || !posNow) await findNearby();
    if (!nearCache) throw new Error('Serve la tua posizione');
    const p = nearCache.p;
    const direct = dist(p, dest);
    const gm = `<a class="btn primary" href="${gmapsDir(dest, 'transit')}" target="_blank" rel="noopener">🗺️ Orari e cambi su Google Maps</a>`;
    if (direct < 900) {
      out.innerHTML = `<div class="plan"><h3>🚶 Ci arrivi a piedi</h3>
        <p>${esc(dest.name)} è a ${fmtDist(direct)}: circa ${walkMin(direct)} minuti a piedi.</p>
        <div class="btns"><a class="btn primary" href="${gmapsDir(dest, 'walking')}" target="_blank" rel="noopener">🧭 Percorso a piedi</a></div></div>`;
      return;
    }
    const there = await stopsAround(dest, 450);
    const opts = [];
    for (const [rid, route] of nearCache.data.routes) {
      const r2 = there.routes.get(rid); if (!r2) continue;
      // fermata di salita (vicino a te) e di discesa (vicino alla meta) su questa linea, nella direzione giusta
      const ups = [...nearCache.data.elems.values()].filter((e) => route.idx.has(e.key));
      const downs = [...there.elems.values()].filter((e) => route.idx.has(e.key));
      let best = null;
      for (const u of ups) for (const dn of downs) {
        const iu = route.idx.get(u.key), id = route.idx.get(dn.key);
        if (iu >= id) continue;
        const ride = Math.max(3, Math.round(dist(u, dn) * 1.35 / (route.mode === 'subway' ? 550 : route.mode === 'tram' ? 250 : 220)));
        const total = walkMin(u.d) + ride + walkMin(dn.d) + 5;
        if (!best || total < best.total) best = { route, u, dn, ride, total };
      }
      if (best) opts.push(best);
    }
    // una sola opzione per numero di linea (la migliore)
    const byRef = new Map();
    opts.sort((a, b) => a.total - b.total).forEach((o) => { const k = o.route.mode + o.route.ref; if (!byRef.has(k)) byRef.set(k, o); });
    const top = [...byRef.values()].slice(0, 6);
    const nameOf = (e) => e.name || 'fermata vicina';
    out.innerHTML = `<div class="plan">
      <h3>Da te a ${esc(dest.name)} <span class="muted small">(${fmtDist(direct)} in linea d'aria)</span></h3>
      ${top.length ? top.map((o) => `
        <div class="opt">
          <div class="hd">${lineBadge(o.route)} <span>${esc(MODE_IT[o.route.mode] || '')}${o.route.to ? ' verso ' + esc(o.route.to) : ''}</span><span class="t">~${o.total} min</span></div>
          <ol>
            <li>Cammina ${fmtDist(o.u.d)} (${walkMin(o.u.d)} min) fino a <b>${esc(nameOf(o.u))}</b></li>
            <li>Prendi ${esc(MODE_IT[o.route.mode] || 'la linea').toLowerCase()} <b>${esc(o.route.ref)}</b>${o.route.to ? ' direzione ' + esc(o.route.to) : ''}, circa ${o.ride} min</li>
            <li>Scendi a <b>${esc(nameOf(o.dn))}</b> e cammina ${fmtDist(o.dn.d)} (${walkMin(o.dn.d)} min)</li>
          </ol>
        </div>`).join('') : `<p>Non ho trovato una linea diretta tra le fermate vicine a te e la meta: probabilmente serve un cambio.</p>`}
      <p class="muted small">Tempi stimati, senza attese reali. Per orari in tempo reale e percorsi con cambio usa Google Maps.</p>
      <div class="btns">${gm}</div>
    </div>`;
    const m = ensureMap();
    if (m) {
      mapLayer.clearLayers();
      const pts = [[p.lat, p.lon], [dest.lat, dest.lon]];
      L.marker([p.lat, p.lon], { icon: emojiIcon('🧍') }).addTo(mapLayer).bindPopup('Sei qui');
      L.marker([dest.lat, dest.lon], { icon: emojiIcon('🏁') }).addTo(mapLayer).bindPopup(esc(dest.name));
      if (top[0]) {
        const o = top[0];
        L.circleMarker([o.u.lat, o.u.lon], { radius: 8, color: '#2e8b57', fillOpacity: .9 }).addTo(mapLayer).bindPopup('Sali: ' + esc(nameOf(o.u)) + ' (' + esc(o.route.ref) + ')');
        L.circleMarker([o.dn.lat, o.dn.lon], { radius: 8, color: '#c0392b', fillOpacity: .9 }).addTo(mapLayer).bindPopup('Scendi: ' + esc(nameOf(o.dn)));
        pts.push([o.u.lat, o.u.lon], [o.dn.lat, o.dn.lon]);
      }
      m.fitBounds(L.latLngBounds(pts).pad(0.2));
    }
  } catch (err) {
    out.innerHTML = `<div class="plan"><p>${esc(err.message || 'Errore')}.</p>
      <div class="btns"><a class="btn primary" href="${gmapsDir(dest, 'transit')}" target="_blank" rel="noopener">🗺️ Apri su Google Maps</a></div></div>`;
  }
}

/* ---------------- Tabs, menu, export ---------------- */
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  try { sessionStorage.setItem('roma.tab', name); } catch {}
  if (name === 'transit' && map) setTimeout(() => map.invalidateSize(), 50);
}
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'roma-in-tasca', v: 1, places: lists.places, food: lists.food }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'roma-liste.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      let n = 0;
      for (const kind of ['places', 'food']) {
        for (const it of d[kind] || []) {
          if (!it || !it.name) continue;
          if (lists[kind].some((x) => x.id === it.id || (it.osm && x.osm === it.osm))) continue;
          lists[kind].push({ ...it, loading: false }); n++;
        }
        save(kind); renderList(kind);
      }
      refreshDestSelect();
      toast(`Importati ${n} elementi`);
    } catch { toast('File non valido'); }
  };
  r.readAsText(file);
}

function initApp() {
  if (initApp.done) return; initApp.done = true;
  // le ricerche non completate restano marcate in caricamento: ripulisci
  for (const k of ['places', 'food']) lists[k].forEach((x) => { if (x.loading) x.loading = false; });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('form.search[data-kind]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault(); doSearch(f.dataset.kind, f.q.value);
  }));
  $('#placeChips').innerHTML = SUGGESTED.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('#placeChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const f = $('form[data-kind="places"]'); f.q.value = b.textContent; doSearch('places', b.textContent);
  });
  $$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    filters[seg.dataset.list] = b.dataset.f; renderList(seg.dataset.list);
  }));
  $('#placesList').addEventListener('click', onListClick('places'));
  $('#foodList').addEventListener('click', onListClick('food'));
  $('#foodNear').addEventListener('click', nearbyFood);
  $('#foodManual').addEventListener('click', manualFood);
  $('#locateBtn').addEventListener('click', findNearby);
  $('#planBtn').addEventListener('click', plan);
  $('#destSelect').addEventListener('change', (e) => {
    const [kind, id] = e.target.value.split(':');
    const it = kind && lists[kind].find((x) => x.id === id);
    setDest(it ? { name: it.name, lat: it.lat, lon: it.lon } : null);
  });
  $('#destForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#destInput').value; if (!q.trim()) return;
    const box = $('#destResults');
    box.innerHTML = '<div class="info"><span class="spin"></span> Cerco…</div>';
    try {
      renderResults(box, await nominatim(q, 6), null, (it) => { $('#destSelect').value = ''; setDest(it); });
    } catch { box.innerHTML = '<div class="info">Ricerca non riuscita.</div>'; }
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const menu = $('#menu');
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => (menu.hidden = true));
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'export') exportData();
    if (act === 'import') $('#importFile').click();
    if (act === 'logout') { localStorage.removeItem('roma.auth'); location.reload(); }
  });
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

  renderList('places'); renderList('food'); refreshDestSelect();
  let tab = 'places'; try { tab = sessionStorage.getItem('roma.tab') || 'places'; } catch {}
  switchTab(tab);
}

initLogin();
