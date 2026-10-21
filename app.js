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
const APP_VERSION = 8; // tenere allineato con version.json e con ?v= in index.html
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
const deleted = store.get('roma.deleted', {}); // id -> momento della cancellazione (per la sincronizzazione)
const TRANSIENT = new Set(['loading', 'upd']);
const itemSig = (it) => JSON.stringify(it, (k, v) => (TRANSIENT.has(k) ? undefined : v));
const sigs = new Map(); // ultima versione salvata di ogni elemento
for (const k of ['places', 'food']) lists[k].forEach((it) => sigs.set(it.id, itemSig(it)));
function save(kind) {
  // segna come modificati gli elementi cambiati, cosi' la sincronizzazione sa quale versione vince
  const now = Date.now();
  for (const it of lists[kind]) {
    const sg = itemSig(it);
    if (sigs.get(it.id) !== sg) { sigs.set(it.id, sg); it.upd = now; }
  }
  store.set(kind === 'places' ? 'roma.places' : 'roma.food', lists[kind]);
  sync.soon();
}
function removeItem(kind, id) {
  lists[kind] = lists[kind].filter((x) => x.id !== id);
  deleted[id] = Date.now(); store.set('roma.deleted', deleted);
  save(kind);
}

/* ---------------- Liste condivise (sincronizzazione online) ----------------
 * Le liste vivono in un Firebase Realtime Database, il cui indirizzo e' scritto in sync.json:
 * chiunque apra il link del sito usa la stessa lista. Ogni elemento ha un campo upd:
 * in caso di modifiche contemporanee vince la piu' recente; le cancellazioni restano in "deleted".
 * Il documento e' salvato come stringa JSON per evitare i limiti di Firebase sui nomi delle chiavi.
 */
const DB_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebasedatabase\.app|firebaseio\.com)$/;
const sync = {
  id: null, timer: null, busy: false, again: false, status: 'off',
  init() { this.id = store.get('roma.db', null); },
  async discover() {
    try {
      const d = await (await fetch('sync.json?t=' + Date.now(), { cache: 'no-store' })).json();
      // sync.json puo' elencare piu' indirizzi possibili (la regione del database cambia il dominio): vince il primo che risponde
      const cands = [].concat(d.db || []).map((x) => String(x).replace(/\/+$/, '')).filter((x) => DB_RE.test(x));
      if (this.id && cands.includes(this.id)) return;
      for (const c of cands) {
        try { const r = await fetch(`${c}/roma.json`, { cache: 'no-store' }); if (r.ok) { this.id = c; store.set('roma.db', c); return; } } catch {}
      }
    } catch {}
  },
  url() { return `${this.id}/roma.json`; },
  payload() {
    const clean = (arr) => arr.map((it) => { const o = { ...it }; delete o.loading; return o; });
    return { app: 'roma-in-tasca', places: clean(lists.places), food: clean(lists.food), deleted };
  },
  soon() { if (!this.id) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 1200); },
  setStatus(st, msg) {
    this.status = st;
    const el = $('#syncBadge'); if (el) {
      el.hidden = false;
      el.textContent = st === 'ok' ? '☁️' : st === 'busy' ? '🔄' : st === 'err' ? '⚠️' : '📱';
      el.title = msg || '';
    }
    const bar = $('#shareBar'); if (bar) bar.hidden = !!this.id;
  },
  // unisce il documento remoto nelle liste locali, modificando gli oggetti esistenti (le schede aperte restano valide)
  merge(remote) {
    let changedLocal = false;
    for (const [id, ts] of Object.entries(remote.deleted || {})) if (!deleted[id] || deleted[id] < ts) deleted[id] = ts;
    for (const kind of ['places', 'food']) {
      const byId = new Map(lists[kind].map((x) => [x.id, x]));
      for (const r of remote[kind] || []) {
        if (!r || !r.id) continue;
        const loc = byId.get(r.id);
        if (!loc) { const o = { ...r, loading: false }; lists[kind].push(o); byId.set(o.id, o); sigs.set(o.id, itemSig(o)); changedLocal = true; }
        else if ((r.upd || 0) > (loc.upd || 0)) {
          for (const k of Object.keys(loc)) if (!(k in r) && k !== 'loading') delete loc[k];
          Object.assign(loc, r, { loading: false }); sigs.set(loc.id, itemSig(loc)); changedLocal = true;
        }
      }
      const before = lists[kind].length;
      lists[kind] = lists[kind].filter((x) => !(deleted[x.id] && deleted[x.id] >= (x.upd || 0)));
      if (lists[kind].length !== before) changedLocal = true;
      lists[kind].sort((a, b) => (b.added || 0) - (a.added || 0));
      store.set(kind === 'places' ? 'roma.places' : 'roma.food', lists[kind]);
    }
    store.set('roma.deleted', deleted);
    return changedLocal;
  },
  async run() {
    if (!this.id) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.setStatus('busy', 'Sincronizzo…');
    try {
      const r = await fetch(this.url(), { cache: 'no-store' });
      if (r.status === 401 || r.status === 403) throw new Error('accesso negato dal database (regole)');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const raw = await r.json();
      let remote = {};
      try { remote = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch {}
      const changed = this.merge(remote);
      const mine = JSON.stringify(this.payload());
      const theirs = JSON.stringify({ app: 'roma-in-tasca', places: remote.places || [], food: remote.food || [], deleted: remote.deleted || {} });
      if (mine !== theirs) {
        const w = await fetch(this.url(), { method: 'PUT', body: JSON.stringify(mine) });
        if (!w.ok) throw new Error('HTTP ' + w.status);
      }
      if (changed) { renderList('places'); renderList('food'); refreshDestSelect(); }
      this.setStatus('ok', 'Liste condivise aggiornate alle ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      this.setStatus('err', 'Sincronizzazione non riuscita: ' + e.message);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.soon(); }
    }
  },
  start() {
    setInterval(() => { if (!document.hidden) this.run(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.run(); });
    window.addEventListener('online', () => this.run());
    this.setStatus(this.id ? 'busy' : 'off', this.id ? '' : 'Liste solo su questo telefono');
    this.run();
  },
};
sync.init();

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
// Photon (komoot) tollera gli errori di battitura: "colloseo", "fontana trevy"...
async function photon(q, limit = 10) {
  const [l, t, r, b] = ROME_VIEWBOX.split(',');
  const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lat=41.9&lon=12.49&bbox=${l},${b},${r},${t}`;
  const d = await getJSON(u);
  return (d.features || []).map((f) => {
    const p = f.properties || {};
    return {
      osm: { N: 'node', W: 'way', R: 'relation' }[p.osm_type] + '/' + p.osm_id,
      name: p.name || p.street || q,
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      address: [[p.street, p.housenumber].filter(Boolean).join(' '), p.district || p.locality].filter(Boolean).join(', '),
      kind: p.osm_value, cls: p.osm_key, tags: {}, needTags: true,
    };
  }).filter((x) => x.name);
}
// Tag completi (orari, prezzi, wikipedia) per un risultato Photon
async function osmTags(osm) {
  const [type, id] = osm.split('/');
  const d = await getJSON(`https://nominatim.openstreetmap.org/lookup?format=jsonv2&extratags=1&addressdetails=1&accept-language=it&osm_ids=${type[0].toUpperCase()}${id}`);
  return d[0] ? normNominatim(d[0]) : null;
}
// Wikipedia corregge i nomi sbagliati ("Did you mean")
async function wikiSuggest(q) {
  const d = await getJSON(`https://it.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q + ' Roma')}&srinfo=suggestion&srlimit=3&srprop=&format=json&origin=*`);
  const sug = d.query?.searchinfo?.suggestion?.replace(/\s*roma\s*$/i, '');
  return { suggestion: sug, titles: (d.query?.search || []).map((x) => x.title) };
}
const FOOD_TYPES = /^(restaurant|cafe|fast_food|pub|bar|ice_cream|food_court|biergarten|bakery|pastry|confectionery|deli)$/;
const JUNK_TYPES = /^(bus_stop|platform|stop_position|stop|tram_stop|subway_entrance|parking|parking_entrance|bicycle_parking|taxi|vending_machine|waste_basket|bench|atm|post_box)$/;

function renderResults(box, items, kind, onPick, note) {
  if (!items.length) { box.innerHTML = '<div class="info">Nessun risultato. Prova con un altro nome.</div>'; return; }
  box.innerHTML = (note ? `<div class="info">${note}</div>` : '') + items.map((it, i) => `
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

// Ricerca tollerante: Nominatim + Photon in parallelo; se non trova nulla, prova la correzione di Wikipedia
async function smartSearch(q, kind) {
  const run = async (term) => {
    const [a, b] = await Promise.allSettled([nominatim(term, 10), photon(term, 12)]);
    const all = [...(a.value || []), ...(b.value || [])];
    const seen = new Set(), out = [];
    for (const r of all) {
      if (seen.has(r.osm)) continue; seen.add(r.osm);
      if (JUNK_TYPES.test(r.kind)) continue;
      out.push(r);
    }
    if (a.status === 'rejected' && b.status === 'rejected') throw new Error('offline');
    return out;
  };
  let res = await run(q), note = '';
  if (kind === 'food') { const f = res.filter((r) => FOOD_TYPES.test(r.kind)); if (f.length) res = f; }
  if (res.length < 2) {
    try {
      const w = await wikiSuggest(q);
      const terms = [w.suggestion, ...w.titles].filter((t) => t && t.toLowerCase() !== q.toLowerCase()).slice(0, 2);
      for (const t of terms) {
        const more = (await run(t)).filter((r) => !res.some((x) => x.osm === r.osm));
        if (more.length) { res = res.concat(more); note = `Forse cercavi <b>${esc(t)}</b>?`; break; }
      }
    } catch {}
  }
  return { res: res.slice(0, 12), note };
}

async function doSearch(kind, q) {
  const box = kind === 'places' ? $('#placesResults') : $('#foodResults');
  if (!q.trim()) return;
  box.innerHTML = '<div class="info"><span class="spin"></span> Cerco…</div>';
  try {
    const { res, note } = await smartSearch(q.trim(), kind);
    renderResults(box, res, kind, null, note);
  } catch (err) {
    box.innerHTML = '<div class="info">Ricerca non riuscita. Controlla la connessione e riprova.</div>';
  }
}

/* ---------------- Enrichment (immagine, descrizione) ---------------- */
// Wikimedia serve in modo affidabile solo le larghezze "standard" delle miniature (es. 330, 500, 960)
const IMG_W = 960;
async function wikiSummary(lang, title) {
  const d = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}` +
    `&prop=pageimages|extracts|info&inprop=url&piprop=thumbnail|original&pithumbsize=${IMG_W}&exintro=1&explaintext=1&exsentences=4&redirects=1&format=json&origin=*`);
  const page = Object.values(d.query?.pages || {})[0] || {};
  return { images: [page.thumbnail?.source, page.original?.source].filter(Boolean), extract: page.extract || '', wiki: page.fullurl || '' };
}
const commonsUrl = (file, w = IMG_W) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/^File:/, ''))}?width=${w}`;
// Foto scattate in quel punto (Wikimedia Commons)
async function commonsNear(lat, lon, radius) {
  const d = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggsnamespace=6` +
    `&ggscoord=${lat}|${lon}&ggsradius=${radius}&ggslimit=10&prop=imageinfo&iiprop=url|mime&iiurlwidth=${IMG_W}&format=json&origin=*`);
  const pages = Object.values(d.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((p) => p.imageinfo?.[0]).filter((ii) => ii && /jpeg|png|webp/.test(ii.mime)).slice(0, 2).map((ii) => ii.thumburl || ii.url);
}
// Foto di anteprima del sito ufficiale (og:image), utile soprattutto per i ristoranti
async function siteImage(url) {
  const d = await getJSON(`https://api.microlink.io/?url=${encodeURIComponent(url)}`);
  const u = d?.data?.image?.url;
  return u && /^https:/.test(u) ? [u] : [];
}
// Varianti di una miniatura Wikimedia, se una dimensione non viene servita
function imgVariants(u) {
  const m = u.match(/^(https:\/\/upload\.wikimedia\.org\/.+?)\/thumb(\/.+?\/[^/]+)\/(\d+)px-[^/]+$/);
  if (!m) return [u];
  const base = m[1] + '/thumb' + m[2], file = m[2].split('/').pop();
  return [u, `${base}/500px-${file}`, `${base}/330px-${file}`, m[1] + m[2]];
}
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const nameWords = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(della|delle|dello|degli|piazza|chiesa|basilica|via|ristorante|trattoria|osteria|pizzeria)$/.test(w));

async function enrich(it, kind) {
  let t = it.tags || {};
  const out = { images: [] };
  // Risultato da Photon: recupera prima i tag OSM completi
  if (it.needTags && it.osm) {
    try {
      const full = await osmTags(it.osm);
      if (full) {
        t = full.tags; out.tags = t;
        out.hours = fmtHours(t.opening_hours); out.price = fmtPrice(t);
        out.website = t.website || t['contact:website'] || ''; out.phone = t.phone || t['contact:phone'] || '';
        out.cuisine = fmtCuisine(t.cuisine);
        if (!it.address && full.address) out.address = full.address;
      }
    } catch {}
  }
  const add = (arr) => arr.forEach((u) => u && !out.images.includes(u) && out.images.push(u));
  const merge = (s) => { if (!s) return; add(s.images); out.extract = out.extract || s.extract; out.wiki = out.wiki || s.wiki; };
  const site = () => it.website || out.website || t.website || t['contact:website'];

  if (kind === 'food' && site()) { try { add(await siteImage(site())); } catch {} }
  try {
    if (t.wikipedia) {
      const [lang, ...rest] = t.wikipedia.split(':');
      merge(await wikiSummary(rest.length ? lang : 'it', rest.length ? rest.join(':') : lang));
    }
  } catch {}
  try {
    if (t.wikidata) {
      const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${t.wikidata}&props=sitelinks|claims&format=json&origin=*`);
      const ent = d.entities?.[t.wikidata];
      const p18 = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (p18) add([commonsUrl(p18), commonsUrl(p18, 500)]);
      const sl = ent?.sitelinks?.itwiki || ent?.sitelinks?.enwiki;
      if (sl && (!out.extract || !out.images.length)) merge(await wikiSummary(sl.site === 'itwiki' ? 'it' : 'en', sl.title));
      const web = ent?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (web && !it.website && !out.website) out.website = web;
    }
  } catch {}
  if (t.image && /^https?:/.test(t.image)) add([t.image]);
  if (t.wikimedia_commons && /^File:/.test(t.wikimedia_commons)) add([commonsUrl(t.wikimedia_commons)]);
  // Voce Wikipedia vicina con un nome simile
  if (!out.images.length && it.lat != null) {
    try {
      const g = await getJSON(`https://it.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${it.lat}|${it.lon}&gsradius=${kind === 'food' ? 60 : 500}&gslimit=20&format=json&origin=*`);
      const words = nameWords(it.name);
      const hit = (g.query?.geosearch || []).find((p) => words.some((w) => norm(p.title).includes(w)));
      if (hit) merge(await wikiSummary('it', hit.title));
    } catch {}
  }
  // Ricerca testuale su Wikipedia (solo luoghi)
  if (!out.images.length && kind === 'places') {
    try {
      const w = await wikiSuggest(it.name);
      const words = nameWords(it.name);
      const title = w.titles.find((x) => words.some((y) => norm(x).includes(y)));
      if (title) merge(await wikiSummary('it', title));
    } catch {}
  }
  if (!out.images.length && kind === 'places' && site()) { try { add(await siteImage(site())); } catch {} }
  if (!out.images.length && it.lat != null) { try { add(await commonsNear(it.lat, it.lon, kind === 'food' ? 30 : 150)); } catch {} }
  out.image = out.images[0] || '';
  return out;
}

const IMG_V = 3; // versione della logica immagini: gli elementi con versione precedente vengono rielaborati
function applyEnrich(cur, extra) {
  if (!cur.customPhoto) { cur.image = extra.image || ''; cur.images = extra.images || []; }
  delete cur.isMap;
  cur.extract = cur.extract || extra.extract || ''; cur.wiki = cur.wiki || extra.wiki || '';
  for (const f of ['hours', 'price', 'website', 'phone', 'cuisine', 'address']) if (extra[f] && !cur[f]) cur[f] = extra[f];
  if (extra.tags) cur.tags = extra.tags;
  delete cur.needTags; cur.loading = false; cur.v = IMG_V;
}
// Aggiorna le foto degli elementi gia' salvati con la logica attuale
async function refreshMissing() {
  for (const kind of ['places', 'food']) {
    const todo = lists[kind].filter((x) => x.v !== IMG_V && !x.customPhoto);
    todo.forEach((x) => (x.loading = true));
    if (todo.length) renderList(kind);
    for (const it of todo) {
      try { applyEnrich(it, await enrich(it, kind)); } catch { it.loading = false; }
      save(kind); renderList(kind);
    }
  }
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
    cuisine: fmtCuisine(t.cuisine), tags: t, needTags: !!c.needTags, notes: '', done: false, loading: true, added: Date.now(),
  };
  list.unshift(it); save(kind); renderList(kind); refreshDestSelect();
  toast('Aggiunto: ' + it.name);
  enrich(it, kind).then((extra) => {
    const cur = lists[kind].find((x) => x.id === it.id); if (!cur) return;
    applyEnrich(cur, extra); save(kind); renderList(kind);
  });
}

/* ---------------- Lists ---------------- */
const emoji = (kind, it) => (kind === 'food' ? (/(cafe|bar)/.test(it.kind) ? '☕' : /ice_cream/.test(it.kind) ? '🍨' : /pizza/i.test(it.cuisine) ? '🍕' : '🍝') : '🏛️');
let posNow = null; // ultima posizione nota

// <img> con ripiego: prova le altre foto trovate, poi l'emoji
function imgTag(it, kind) {
  const list = [...new Set((it.images && it.images.length ? it.images : [it.image]).flatMap(imgVariants))];
  if (it.customPhoto) list.unshift(it.image);
  const [first, ...alts] = [...new Set(list)];
  return `<img src="${esc(first)}" alt="" loading="lazy" data-alts="${esc(alts.join(' '))}" data-e="${emoji(kind, it)}" onerror="imgFail(this)">`;
}
window.imgFail = (el) => {
  const alts = (el.dataset.alts || '').split(' ').filter(Boolean);
  if (alts.length) { el.dataset.alts = alts.slice(1).join(' '); el.src = alts[0]; }
  else el.replaceWith(document.createTextNode(el.dataset.e || '🏛️'));
};

function renderList(kind) {
  const box = kind === 'places' ? $('#placesList') : $('#foodList');
  const f = filters[kind];
  if (f === 'map') return renderListMap(kind, box);
  const items = lists[kind].filter((x) => (f === 'done' ? x.done : !x.done));
  // prima gli appuntamenti fissati, in ordine di data
  if (f === 'todo') items.sort((a, b) => (a.bookDate ? 0 : 1) - (b.bookDate ? 0 : 1) || (bookKey(a) < bookKey(b) ? -1 : bookKey(a) > bookKey(b) ? 1 : 0));
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
      <div class="thumb" data-open>${it.image ? imgTag(it, kind) : it.loading ? '<span class="spin"></span>' : emoji(kind, it)}</div>
      <button class="postit ${it.bookNote || it.notes || it.bookDate ? 'has' : ''}" data-note title="Nota e prenotazione" aria-label="Nota e prenotazione">📝</button>
      <div class="body">
        <div class="title" data-open>${esc(it.name)}</div>
        <div class="meta">
          ${it.kind ? `<span>${esc(catLabel(it.kind))}</span>` : ''}
          ${it.cuisine ? `<span>🍴 ${esc(it.cuisine)}</span>` : ''}
          ${d ? `<span>📍 ${d}</span>` : ''}
        </div>
        ${it.bookDate ? `<div class="book ${bookKey(it) < nowKey() ? 'past' : ''}">📅 ${esc(fmtBook(it))}</div>` : ''}
        ${it.bookNote || it.notes ? `<div class="note-line" data-note>📝 ${esc([it.bookNote, it.notes].filter(Boolean).join(' · '))}</div>` : ''}
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
    if (e.target.closest('[data-note]')) { openDetail(kind, it, true); return; }
    if (e.target.closest('[data-open]')) openDetail(kind, it);
  };
}

/* ---------------- Prenotazioni ---------------- */
const bookKey = (it) => (it.bookDate || '9999-12-31') + 'T' + (it.bookTime || '00:00');
const nowKey = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
function fmtBook(it) {
  const [y, m, d] = it.bookDate.split('-').map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  return s + (it.bookTime ? ', ore ' + it.bookTime : '');
}
function downloadIcs(kind, it) {
  const d = it.bookDate.replace(/-/g, ''), t = (it.bookTime || '').replace(':', '');
  const icsText = (x) => String(x || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  let start, end;
  if (t) {
    const [hh, mm] = it.bookTime.split(':').map(Number);
    const e = new Date(2000, 0, 1, hh + 2, mm), p = (n) => String(n).padStart(2, '0');
    start = `DTSTART;TZID=Europe/Rome:${d}T${t}00`;
    end = `DTEND;TZID=Europe/Rome:${d}T${hh + 2 >= 24 ? '2359' : p(e.getHours()) + p(e.getMinutes())}00`;
  } else {
    const n = new Date(it.bookDate + 'T12:00:00'); n.setDate(n.getDate() + 1);
    start = `DTSTART;VALUE=DATE:${d}`; end = `DTEND;VALUE=DATE:${n.toISOString().slice(0, 10).replace(/-/g, '')}`;
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Roma in Tasca//IT', 'BEGIN:VEVENT',
    `UID:${it.id}-${d}@roma-in-tasca`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, start, end,
    `SUMMARY:${icsText((kind === 'food' ? '🍝 ' : '🏛️ ') + it.name)}`,
    `DESCRIPTION:${icsText([it.bookNote, it.notes].filter(Boolean).join('\n'))}`,
    `LOCATION:${icsText([it.name, it.address, 'Roma'].filter(Boolean).join(', '))}`,
    ...(it.lat != null ? [`GEO:${it.lat};${it.lon}`] : []),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = (it.name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'prenotazione') + '.ics';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------------- Detail ---------------- */
function openDetail(kind, it, toNote = false) {
  const isFood = kind === 'food';
  const body = $('#modalBody');
  body.innerHTML = `
    <div class="hero">${it.image ? imgTag(it, kind) : emoji(kind, it)}</div>
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
      <div class="bookbox">
        <label>📅 ${isFood ? 'Prenotazione' : 'Quando ci vado / prenotazione'}</label>
        <div class="bookrow">
          <input type="date" data-f="bookDate" value="${esc(it.bookDate || '')}" aria-label="Giorno">
          <input type="time" data-f="bookTime" value="${esc(it.bookTime || '')}" aria-label="Orario">
        </div>
        <textarea data-f="bookNote" placeholder="${isFood ? 'Es. prenotato a nome Nikola, 4 persone, tavolo fuori' : 'Es. biglietti presi online, codice ABC123, ingresso dalla porta nord'}">${esc(it.bookNote || '')}</textarea>
        <div class="btns">
          <button class="btn small" data-ics>📆 Aggiungi al calendario</button>
          <button class="btn small" data-unbook>✖️ Cancella data</button>
        </div>
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
        <button class="btn" data-photo>🖼️ Cambia foto</button>
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
      removeItem(kind, it.id); renderList(kind); refreshDestSelect(); closeModal();
    } else if (e.target.closest('[data-bus]')) { closeModal(); planTo(it); }
    else if (e.target.closest('[data-ics]')) {
      if (!it.bookDate) { toast('Scegli prima il giorno'); return; }
      downloadIcs(kind, it);
    } else if (e.target.closest('[data-unbook]')) {
      it.bookDate = ''; it.bookTime = ''; save(kind); renderList(kind); openDetail(kind, it);
    } else if (e.target.closest('[data-photo]')) {
      const u = prompt('Incolla il link di una foto (es. da Google Immagini: tieni premuto sulla foto → Copia indirizzo immagine). Lascia vuoto per tornare alla foto automatica:', it.customPhoto ? it.image : '');
      if (u === null) return;
      if (u.trim() && /^https?:\/\//.test(u.trim())) { it.image = u.trim(); it.customPhoto = true; }
      else if (!u.trim()) { it.customPhoto = false; it.image = (it.images || [])[0] || ''; }
      save(kind); renderList(kind); openDetail(kind, it);
    }
  };
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  if (toNote) {
    const box = $('.bookbox', body);
    setTimeout(() => { box.scrollIntoView({ block: 'start', behavior: 'smooth' }); $('[data-f=bookNote]', box).focus({ preventScroll: true }); }, 60);
  }
}
function closeModal() { $('#modal').hidden = true; document.body.style.overflow = ''; }

/* ---------------- Manual add / nearby food ---------------- */
function manualFood() {
  const name = prompt('Nome del ristorante:'); if (!name || !name.trim()) return;
  const box = $('#foodResults');
  box.innerHTML = '<div class="info"><span class="spin"></span> Cerco dove si trova…</div>';
  smartSearch(name.trim(), 'food').then(({ res }) => {
    const hit = res.find((r) => FOOD_TYPES.test(r.kind));
    box.innerHTML = '';
    addItem('food', hit ? { ...hit, name: name.trim() } : { name: name.trim(), tags: {}, kind: 'restaurant' });
    if (!hit) toast('Non trovo la posizione: aggiunto solo il nome');
  }).catch(() => { box.innerHTML = ''; addItem('food', { name: name.trim(), tags: {}, kind: 'restaurant' }); });
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

/* ---------------- Condivisione ---------------- */
function openShare() {
  const body = $('#modalBody');
  body.innerHTML = sync.id ? `<div class="dbody"><h2>👥 Liste condivise</h2>
      <p>Le liste sono condivise con tutti quelli che usano il link <b>${esc(location.origin + location.pathname)}</b>. Le modifiche arrivano agli altri in pochi secondi.</p>
      <p class="muted small">${esc($('#syncBadge').title || '')}</p>
      <button class="btn primary" id="syncNow">🔄 Aggiorna adesso</button></div>`
    : `<div class="dbody"><h2>👥 Liste condivise</h2>
      <p>La condivisione non è ancora attiva: per ora le liste sono salvate solo su questo telefono. Appena viene attivata, quello che hai già salvato si unisce alla lista comune, senza perdere nulla.</p></div>`;
  const b = $('#syncNow'); if (b) b.onclick = () => { sync.run(); closeModal(); toast('Aggiorno le liste…'); };
  $('#modal').hidden = false; document.body.style.overflow = 'hidden';
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
    if (act === 'share') openShare();
    if (act === 'export') exportData();
    if (act === 'import') $('#importFile').click();
    if (act === 'logout') { localStorage.removeItem('roma.auth'); location.reload(); }
  });
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

  renderList('places'); renderList('food'); refreshDestSelect();
  $('#shareBtn').addEventListener('click', openShare);
  $('#syncBadge').addEventListener('click', () => { if (!sync.id) return openShare(); sync.run(); toast($('#syncBadge').title || 'Sincronizzo…'); });
  sync.discover().then(() => { sync.start(); refreshMissing(); });
  let tab = 'places'; try { tab = sessionStorage.getItem('roma.tab') || 'places'; } catch {}
  switchTab(tab);
}

// Se il browser ha in memoria una versione vecchia, ricarica quella nuova
async function checkUpdate() {
  try {
    const d = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (d.v > APP_VERSION && !sessionStorage.getItem('roma.upd' + d.v)) {
      sessionStorage.setItem('roma.upd' + d.v, '1');
      location.replace(location.pathname + '?v=' + d.v);
    }
  } catch {}
}
checkUpdate();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });

initLogin();
