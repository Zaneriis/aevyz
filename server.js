'use strict';
// Surcouche Aevyz : ouvre le booster choisi avec les boosters gratuits, sauvegarde tout l'historique.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) { console.error('PASSWORD manquant'); process.exit(1); }
const PORT = +process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGIN = process.env.AEVYZ_ORIGIN || 'https://www.aevyz.com';
const INTERVAL_MIN = +process.env.INTERVAL_MIN || 9;
const OPEN_DELAY_MS = process.env.OPEN_DELAY_MS ? +process.env.OPEN_DELAY_MS : 2000; // à augmenter si le site répond « Doucement »
const REGEN_MS = 10 * 60 * 1000;
const PAGE = 200;
const BATCH_SIZE = 9;
const BATCH_MARGIN_MS = 30000; // délai après l'arrivée du 9e booster
const MODES = { each: 'à chaque booster', batch: `par lot de ${BATCH_SIZE}`, sneaky: 'sneaky' };
// Mode sneaky : délai avant le prochain passage, d'après la courbe dessinée par Leo : [minutes, chance relative].
const SNEAKY_CURVE = [[10, 1], [30, 0.98], [37, 0.78], [40, 0.63], [46, 0.47], [56, 0.35], [66, 0.28], [90, 0.24]];
const SNEAKY_UNIT_MS = +process.env.SNEAKY_UNIT_MS || 60000; // réduit par test.js pour ne pas attendre 10 minutes
const VISIT_SYNC_MS = 15000;
// Échanges : [mes doublons requis, ses doublons requis, ignorer les envies]. Une proposition ne part que sur demande de la page.
const TRADE_MODES = { classic: [false, false, false], mine: [true, false, false], both: [true, true, false], dupes: [true, true, true] };
const TRADE_MAX = 20; // limite par côté de la fenêtre d'échange du site
const TRADE_MESSAGE_MAX = 280; // limite du message sur le site
const PLAYERS_CACHE_MS = 10 * 60000, TRADE_CACHE_MS = 60000, BADGE_CACHE_MS = 6 * 3600e3;
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
// Statistiques : classement relu toutes les 5 min ; collections et envies de quelques joueurs à chaque fois, à tour de rôle.
const STATS_MS = 5 * 60000;
const STATS_READS = process.env.STATS_READS ? +process.env.STATS_READS : 6; // ponytail: 6 × 12/h ≈ 200 joueurs en ~3 h ; test.js met 0
const STATS_SORTS = { uniq: 'pos_uniq', total: 'pos_total', opened: 'pos_opened', myth: 'pos_myth' };

// Seuls ces boosters et les événements en cours sont autorisés : jamais la Boutique, qui consomme des pièces.
const PERMANENT = [
  { id: 'tous', name: 'Tous les jeux', sub: 'Toutes les cartes', theme: 'base' },
  { id: 'licences', name: 'Grosses licences', sub: 'Les héros les plus connus', theme: 'licences' },
  { id: 'action', name: 'Action', sub: 'FPS, combat, horreur…', theme: 'action' },
  { id: 'aventure', name: 'Aventure & RPG', sub: 'Quêtes, guildes et héros', theme: 'rpg' },
  { id: 'compet', name: 'Compétition', sub: 'Esport, versus et course', theme: 'competition' },
  { id: 'detente', name: 'Détente', sub: 'Plateforme, indés, cosy', theme: 'detente' },
];
const EVENT_THEMES = { moba: 'moba', retro: 'retro', combat: 'fighting', halloween: 'halloween', action: 'action', aventure: 'rpg', compet: 'competition', detente: 'detente', licences: 'licences' };

process.umask(0o077); // la base contient le jeton de session
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'aevyz.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS openings (id TEXT PRIMARY KEY, genre TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS opening_cards (opening_id TEXT NOT NULL, pos INTEGER NOT NULL, card_id TEXT NOT NULL, PRIMARY KEY (opening_id, pos));
  CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, licence TEXT, rarity INTEGER, art TEXT);
  CREATE INDEX IF NOT EXISTS openings_date ON openings (created_at);
  CREATE INDEX IF NOT EXISTS opening_cards_card ON opening_cards (card_id);
  CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, active_at INTEGER, wishes TEXT, read_at INTEGER);
  CREATE TABLE IF NOT EXISTS snaps (player TEXT NOT NULL, at INTEGER NOT NULL, total INTEGER, uniq INTEGER, opened INTEGER, mythics INTEGER,
    pos_uniq INTEGER, pos_total INTEGER, pos_opened INTEGER, pos_myth INTEGER, PRIMARY KEY (player, at));
  CREATE TABLE IF NOT EXISTS rar_snaps (player TEXT NOT NULL, at INTEGER NOT NULL, counts TEXT NOT NULL, PRIMARY KEY (player, at));
`);
try { db.exec('ALTER TABLE players ADD COLUMN dupes TEXT'); } catch {} // bases d'avant les doublons par rareté
const kvGet = k => { const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

const logs = [];
function log(msg) { console.log(msg); logs.unshift({ at: Date.now(), msg }); logs.length = Math.min(logs.length, 30); }
function stop(reason) { kvSet('genre', null); kvSet('alert', reason); log('Toggle coupé : ' + reason); }

// ---- Accès à Aevyz (Supabase) ----
let conf = null;
async function config() {
  if (conf) return conf;
  const js = await (await fetch(ORIGIN + '/config.js', { signal: AbortSignal.timeout(30000) })).text();
  const url = js.match(/supabaseUrl:\s*'([^']+)'/)?.[1], key = js.match(/supabaseAnonKey:\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('config.js du site illisible');
  return conf = { url, key };
}

let refreshing = null;
const refresh = () => refreshing ??= doRefresh().finally(() => { refreshing = null; });
async function doRefresh() {
  const { url, key } = await config(), s = kvGet('session');
  if (!s) throw new Error('Non connecté');
  const res = await fetch(url + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }), signal: AbortSignal.timeout(30000),
  });
  if (res.status === 400 || res.status === 401) { // jeton mort : seule une reconnexion peut réparer
    kvSet('session', null);
    kvSet('alert', 'Session Aevyz expirée : reconnecte-toi.');
    throw new Error('Session expirée');
  }
  if (!res.ok) throw new Error('Renouvellement de session : HTTP ' + res.status);
  const d = await res.json();
  const next = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, user_id: d.user?.id };
  kvSet('session', next); // tout de suite : l'ancien jeton n'est plus valable
  return next;
}
async function accessToken() {
  let s = kvGet('session');
  if (!s) throw new Error('Non connecté');
  if (!s.expires_at || s.expires_at * 1000 < Date.now() + 60000) s = await refresh();
  return s.access_token;
}
async function sb(route, { method = 'GET', body } = {}, retry = true) {
  const { url, key } = await config();
  const res = await fetch(url + route, {
    method, signal: AbortSignal.timeout(30000),
    headers: { apikey: key, Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401 && retry) { await refresh(); return sb(route, { method, body }, false); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.message || 'HTTP ' + res.status);
  return data;
}

async function profile() {
  const id = kvGet('session')?.user_id;
  if (!id) throw new Error('Non connecté');
  const rows = await sb(`/rest/v1/profiles?select=coins,charges,charges_at,bonus_packs,banned,ban_reason&id=eq.${encodeURIComponent(id)}`);
  if (rows.length !== 1) throw new Error('Profil introuvable');
  return rows[0];
}
// Même calcul que le site : offerts + réserve rechargée d'un booster toutes les 10 minutes.
function stock(p, max = Infinity) {
  const regen = Math.floor(Math.max(0, Date.now() - Date.parse(p.charges_at)) / REGEN_MS) || 0;
  return Math.min(max, (p.charges || 0) + regen);
}
const available = p => (p.bonus_packs || 0) + stock(p, maxStock);

// ---- Boosters ----
let events = [], maxStock = 10, eventsAt = 0;
async function refreshEvents() {
  try {
    events = await sb('/rest/v1/events?select=id,name,sub,scene,starts_at,ends_at,active');
    const fete = (await sb('/rest/v1/game_settings?select=value&key=eq.fete'))[0]?.value || {};
    const on = Date.now() < Date.parse(fete.until || '') && +fete.max_stock > 0;
    maxStock = on ? Math.min(30, Math.max(1, Math.floor(+fete.max_stock))) : 10;
    eventsAt = Date.now();
  } catch (e) { log('Événements indisponibles : ' + e.message); }
}
const isLive = e => e.active !== false && Date.now() >= Date.parse(e.starts_at) && Date.now() < Date.parse(e.ends_at);
const boosters = () => PERMANENT.concat(events.filter(isLive).map(e => (
  { id: e.id, name: e.name, sub: e.sub || 'Pack à durée limitée', theme: EVENT_THEMES[e.scene] || 'base', ends_at: e.ends_at })));
function packName(g) {
  const b = PERMANENT.find(x => x.id === g) || events.find(x => x.id === g);
  if (b) return b.name;
  return g?.startsWith('shop-') ? 'Boutique' : g?.startsWith('ev-') ? 'Pack à durée limitée' : 'Booster';
}
function packTheme(g) {
  const p = PERMANENT.find(x => x.id === g);
  if (p) return p.theme;
  return EVENT_THEMES[events.find(x => x.id === g)?.scene] || 'base';
}

// ---- Ouverture : p_buy reste toujours à false, et le solde de pièces est contrôlé à chaque booster ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function openAll(genre) {
  if (!boosters().some(b => b.id === genre)) return stop('Le booster choisi n\'est plus disponible.');
  const batch = kvGet('mode') === 'batch';
  let opened = 0;
  // Par lot : un seul appel de 9, comme le bouton ×N du site, plutôt que 9 appels d'affilée que le site freine.
  const n = batch ? BATCH_SIZE : 1;
  for (let i = 0; i < (batch ? 1 : 100) && kvGet('genre') === genre; i++) {
    const s0 = spent, before = await profile();
    if (before.banned) return stop('Compte suspendu' + (before.ban_reason ? ' : ' + before.ban_reason : '') + '.');
    if (available(before) < n) { if (batch) return; break; } // le lot n'est pas complet : on attend
    try {
      await sb('/rest/v1/rpc/open_booster', { method: 'POST', body: { p_genre: genre, p_count: n, p_buy: false } });
    } catch (e) {
      if (/pièces|suspendu|plus disponible|pas encore de cartes/.test(e.message)) return stop('Aevyz a refusé l\'ouverture : ' + e.message);
      if (!/Plus de booster|Il te manque/.test(e.message)) log('Ouverture interrompue : ' + e.message);
      break;
    }
    opened += n;
    const after = await profile();
    if (after.coins < before.coins - (spent - s0)) return stop(`Solde de pièces en baisse (${before.coins} → ${after.coins}). Vérifie ton compte.`);
    await sleep(OPEN_DELAY_MS);
  }
  log(opened ? `${opened} booster${opened > 1 ? 's' : ''} ouvert${opened > 1 ? 's' : ''} : ${packName(genre)}` : 'Aucun booster gratuit disponible');
}

// ---- Sauvegarde locale du catalogue et de l'historique ----
async function selectAll(table, columns, key = 'id') {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await sb(`/rest/v1/${table}?select=${columns}&order=${key}.asc&offset=${from}&limit=1000`);
    out.push(...rows);
    if (!rows.length) return out;
  }
}
function tx(fn) {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
async function syncCatalog() {
  const { url } = await config();
  const [cards, artRows, alts] = await Promise.all([
    selectAll('cards', 'id,name,licence,rarity'),
    selectAll('card_art', 'card_id,path', 'card_id'),
    selectAll('alt_cards', 'id,base_card,style,poster_path'),
  ]);
  const pub = p => p ? `${url}/storage/v1/object/public/cartes/${p.split('/').map(encodeURIComponent).join('/')}` : null;
  const art = new Map(artRows.map(r => [r.card_id, pub(r.path)])), byId = new Map(cards.map(c => [c.id, c]));
  // Pas de suppression : une carte retirée du jeu reste lisible dans l'historique.
  const up = db.prepare(`INSERT INTO cards VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
    name = excluded.name, licence = excluded.licence, rarity = excluded.rarity, art = COALESCE(excluded.art, art)`);
  tx(() => {
    for (const c of cards) up.run(c.id, c.name, c.licence, c.rarity, art.get(c.id) ?? null);
    for (const a of alts) {
      const b = byId.get(a.base_card);
      if (b) up.run(a.id, `${b.name} (${a.style || 'Alternative'})`, b.licence, 6, pub(a.poster_path) ?? art.get(b.id) ?? null);
    }
  });
}
let historyChecked = false;
async function syncHistory() {
  // Tout est récupéré avant d'écrire : une page en échec ne laisse pas de trou dans la sauvegarde.
  const known = db.prepare('SELECT 1 FROM openings WHERE id = ?'), fresh = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await sb(`/rest/v1/openings?select=id,genre,cards,created_at&order=created_at.desc,id.desc&offset=${from}&limit=${PAGE}`);
    if (!rows.length) break;
    const unknown = rows.filter(r => !known.get(String(r.id)));
    fresh.push(...unknown);
    // Au démarrage, tout l'historique du site est relu pour combler un éventuel trou ; ensuite on s'arrête au déjà connu.
    if (historyChecked && unknown.length < rows.length) break;
  }
  const op = db.prepare('INSERT OR IGNORE INTO openings VALUES (?, ?, ?)'), card = db.prepare('INSERT OR IGNORE INTO opening_cards VALUES (?, ?, ?)');
  tx(() => {
    for (const r of fresh) {
      op.run(String(r.id), r.genre, Date.parse(r.created_at));
      (r.cards || []).forEach((id, pos) => card.run(String(r.id), pos, String(id)));
    }
  });
  historyChecked = true;
  if (fresh.length) log(`${fresh.length} ouverture${fresh.length > 1 ? 's' : ''} ajoutée${fresh.length > 1 ? 's' : ''} à la sauvegarde`);
}

// ---- Passage périodique ----
let running = false, rerun = false, due = false, nextPass = 0, lastProfile = null, catalogAt = 0, timer = null;
function sneakyDelay() {
  const min = SNEAKY_CURVE[0][0], max = SNEAKY_CURVE.at(-1)[0];
  for (;;) { // tirage par rejet : une durée est gardée d'autant plus souvent que la courbe est haute
    const t = min + Math.random() * (max - min), i = SNEAKY_CURVE.findIndex(([x]) => x >= t) || 1;
    const [x0, y0] = SNEAKY_CURVE[i - 1], [x1, y1] = SNEAKY_CURVE[i];
    if (Math.random() < y0 + (y1 - y0) * (t - x0) / (x1 - x0)) return t * SNEAKY_UNIT_MS;
  }
}
// Par lot : instant où la réserve atteint le lot (offerts déduits), d'après le compteur du site. null si déjà atteint ou impossible.
function batchReadyAt(p) {
  const need = BATCH_SIZE - (p.bonus_packs || 0);
  if (available(p) >= BATCH_SIZE || need > maxStock) return null;
  return Date.parse(p.charges_at) + (need - (p.charges || 0)) * REGEN_MS;
}
function schedule() {
  let ms = kvGet('mode') === 'sneaky' ? sneakyDelay() : INTERVAL_MIN * 60000;
  // 30 s après le 9e booster, même dans 1 h 30 ; un passage trop tôt (booster ouvert à la main) relit le compteur et revise.
  const ready = kvGet('mode') === 'batch' && lastProfile ? batchReadyAt(lastProfile) : null;
  if (ready) ms = Math.max(0, ready - Date.now()) + BATCH_MARGIN_MS;
  nextPass = Date.now() + ms;
  clearTimeout(timer);
  timer = setTimeout(() => { due = true; schedule(); pass(); }, ms);
}
async function pass() {
  if (running) { rerun = true; return; }
  const scheduled = due;
  due = false;
  if (!kvGet('session')) return;
  running = true;
  const step = async (name, fn) => { try { await fn(); } catch (e) { log(`${name} : ${e.message}`); } };
  await step('Événements', refreshEvents);
  if (Date.now() - catalogAt > 6 * 3600e3) await step('Catalogue', async () => { await syncCatalog(); catalogAt = Date.now(); });
  const genre = kvGet('genre');
  // En mode sneaky, seul le minuteur ouvre : ni le démarrage, ni le toggle, ni un changement de mode.
  if (genre && !quietNow() && (scheduled || kvGet('mode') !== 'sneaky')) await step('Ouverture', () => openAll(genre));
  await step('Historique', syncHistory);
  await step('Profil', async () => { lastProfile = await profile(); });
  running = false;
  if (kvGet('mode') === 'batch') schedule(); // le profil vient d'être relu : on vise le prochain lot
  if (!statsStarted) { statsStarted = true; statsPass(); } // premier relevé dès que le catalogue est là
  if (rerun) { rerun = false; pass(); }
}

// ---- API de la page ----
// Une visite (chargement ou retour sur la page) marque tout comme vu : un rechargement ne réaffiche donc rien.
let visitSyncAt = 0;
async function syncVisit() { // un booster ouvert à la main sur le site apparaît dès le retour sur la page
  if (!kvGet('session') || Date.now() - visitSyncAt < VISIT_SYNC_MS) return;
  visitSyncAt = Date.now();
  try { await syncHistory(); lastProfile = await profile(); } catch (e) { log('Historique : ' + e.message); }
  if (kvGet('mode') === 'batch' && !running) schedule(); // compteur relu : un booster offert peut avancer le lot
}
function markSeen() {
  const now = Date.now(), previous = kvGet('seen_at') ?? now;
  kvSet('seen_at', now);
  return { previous, count: db.prepare('SELECT COUNT(*) AS n FROM openings WHERE created_at > ?').get(previous).n };
}
function state() {
  const p = lastProfile;
  if (kvGet('session') && Date.now() - eventsAt > 5 * 60000) { eventsAt = Date.now(); refreshEvents(); }
  return {
    connected: !!kvGet('session'), genre: kvGet('genre'), alert: kvGet('alert'), boosters: boosters(), origin: ORIGIN,
    intervalMin: INTERVAL_MIN, nextPass, running, logs,
    profile: p && { coins: p.coins, stock: stock(p, maxStock), maxStock, bonus: p.bonus_packs || 0, banned: !!p.banned },
    saved: db.prepare('SELECT COUNT(*) AS n FROM openings').get().n,
    mode: MODES[kvGet('mode')] ? kvGet('mode') : 'each', batchSize: BATCH_SIZE,
    quiet: kvGet('quiet') || { on: false, from: '23:00', to: '07:00' }, quietNow: quietNow(), recycle: recycleJob,
    boughtAt: (kvGet('market_bought') || []).map(b => b.at), // pastille de l'onglet Marché
  };
}
const marks = list => list.map(() => '?').join(',');
function openingFilter(q) {
  const where = [], args = [];
  if (+q.get('from') > 0) { where.push('o.created_at >= ?'); args.push(+q.get('from')); }
  if (+q.get('to') > 0) { where.push('o.created_at <= ?'); args.push(+q.get('to')); }
  const rarities = q.getAll('rarity').filter(r => /^[0-6]$/.test(r)).map(Number), licences = q.getAll('licence');
  if (rarities.length || licences.length) {
    // Un booster est gardé si une même carte correspond à la rareté et à la licence demandées.
    where.push(`EXISTS (SELECT 1 FROM opening_cards oc JOIN cards c ON c.id = oc.card_id WHERE oc.opening_id = o.id
      ${rarities.length ? `AND c.rarity IN (${marks(rarities)})` : ''} ${licences.length ? `AND c.licence IN (${marks(licences)})` : ''})`);
    args.push(...rarities, ...licences);
  }
  return { from: `FROM openings o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, args };
}
// Une étoile par booster pour le cadran : sa date et sa meilleure rareté.
function timeline(q) {
  const { from, args } = openingFilter(q);
  return db.prepare(`SELECT o.created_at AS at, (SELECT MAX(c.rarity) FROM opening_cards oc JOIN cards c ON c.id = oc.card_id WHERE oc.opening_id = o.id) AS best
    ${from} ORDER BY o.created_at`).all(...args).map(r => [r.at, r.best]);
}
function history(q) {
  const { from, args } = openingFilter(q);
  const limit = Math.min(+q.get('limit') || 40, 200), offset = Math.max(+q.get('offset') || 0, 0);
  // ponytail: « première fois » = première apparition dans la sauvegarde ; le site ne date pas les cartes possédées avant.
  const cards = db.prepare(`SELECT oc.card_id AS id, c.name, c.licence, c.rarity, c.art,
      NOT EXISTS (SELECT 1 FROM opening_cards x JOIN openings ox ON ox.id = x.opening_id WHERE x.card_id = oc.card_id AND (
        ox.created_at < o.created_at OR (ox.created_at = o.created_at AND ox.id < o.id) OR (ox.id = o.id AND x.pos < oc.pos))) AS first
    FROM opening_cards oc JOIN openings o ON o.id = oc.opening_id
    LEFT JOIN cards c ON c.id = oc.card_id WHERE oc.opening_id = ? ORDER BY oc.pos`);
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n,
    openings: db.prepare(`SELECT o.id, o.genre, o.created_at AS at ${from} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(o => ({ id: o.id, at: o.at, pack: packName(o.genre), theme: packTheme(o.genre), cards: cards.all(o.id) })),
    licences: db.prepare(`SELECT DISTINCT c.licence AS l FROM opening_cards oc JOIN cards c ON c.id = oc.card_id WHERE c.licence IS NOT NULL ORDER BY 1`).all().map(r => r.l),
  };
}
// Connexion Discord lancée par la surcouche (PKCE) : le code revient sur la surcouche si Aevyz l'autorise,
// sinon sur aevyz.com/?code=…, dont l'adresse se colle ici. Le code seul ne sert à rien sans le vérificateur gardé ici.
const PKCE_MS = 10 * 60000;
async function loginUrl(back) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  kvSet('pkce', { verifier, at: Date.now() });
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return `${(await config()).url}/auth/v1/authorize?provider=discord&redirect_to=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=s256`;
}
async function exchangeCode(code) {
  const p = kvGet('pkce');
  if (!p || Date.now() - p.at > PKCE_MS) throw new Error('lien expiré, relance « Se connecter avec Discord »');
  const { url, key } = await config();
  const res = await fetch(url + '/auth/v1/token?grant_type=pkce', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: p.verifier }), signal: AbortSignal.timeout(30000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.refresh_token) throw new Error(d.msg || d.error_description || d.message || 'HTTP ' + res.status);
  kvSet('pkce', null); // un code ne sert qu'une fois
  return d.refresh_token;
}
async function connect(raw) {
  // Acceptés : adresse avec ?code= (connexion Discord), adresse avec #refresh_token=, ou session copiée depuis la console.
  const code = raw.match(/[?&#]code=([^&#\s]+)/)?.[1], rt = raw.match(/[#&]refresh_token=([^&#\s]+)/)?.[1];
  let token;
  if (code) {
    try { token = await exchangeCode(decodeURIComponent(code)); } catch (e) { return [400, { error: 'Connexion refusée : ' + e.message }]; }
  } else if (rt) token = decodeURIComponent(rt);
  else { try { token = JSON.parse(raw)?.refresh_token; } catch {} }
  if (typeof token !== 'string' || !token) return [400, { error: 'Ce texte ne ressemble pas à une session Aevyz.' }];
  const previous = kvGet('session'), previousAlert = kvGet('alert');
  kvSet('session', { refresh_token: token });
  try {
    await refresh();
  } catch (e) { // un mauvais collage ne doit pas casser une session valide
    kvSet('session', previous);
    kvSet('alert', previousAlert);
    return [400, { error: 'Connexion refusée : ' + e.message }];
  }
  kvSet('alert', null);
  log('Compte Aevyz connecté');
  catalogAt = 0;
  pass();
  return [200, { ok: true }];
}
async function toggle(genre) {
  if (genre === null) { kvSet('genre', null); log('Toggle désactivé'); return [200, { ok: true }]; }
  kvSet('alert', null); // avant refreshEvents, qui peut signaler une session expirée
  await refreshEvents();
  const b = boosters().find(x => x.id === genre);
  if (!b) return [400, { error: 'Booster inconnu ou indisponible.' }];
  kvSet('genre', genre); // une seule valeur : un seul booster peut être actif
  log('Toggle activé : ' + b.name);
  pass();
  return [200, { ok: true }];
}

// ---- Échanges : lectures à la demande ; trade_propose seulement via le bouton d'envoi de la page ----
let playersCache = null, mineCache = null;
const theirsCache = new Map();
async function players() {
  if (playersCache && Date.now() - playersCache.at < PLAYERS_CACHE_MS) return playersCache.value;
  // ponytail: les 200 premiers, comme le classement du site ; le jeu n'offre pas de pagination.
  const rows = await sb('/rest/v1/rpc/leaderboard', { method: 'POST', body: { p_sort: 'uniq', p_limit: 200 } });
  const value = {
    total: rows[0]?.players ?? rows.length,
    players: rows.filter(r => r.id && !r.is_me).map(r => ({ id: r.id, name: r.username, avatar: r.avatar_url, pos: r.pos, uniq: r.uniq })),
  };
  playersCache = { at: Date.now(), value };
  return value;
}
const activity = () => new Map(db.prepare('SELECT id, active_at FROM players').all().map(r => [r.id, r.active_at]));

// ---- Statistiques ----
const SNAP_KEYS = ['total', 'uniq', 'opened', 'mythics', ...Object.values(STATS_SORTS)];
function saveRarity(player, cards, catalog, at) {
  const counts = [0, 0, 0, 0, 0, 0, 0], dupes = counts.map(() => [0, 0]); // doublons : [cartes en double, exemplaires en trop]
  for (const [id, n] of cards) {
    const r = catalog.get(id)?.rarity;
    if (n > 0 && r != null) counts[r]++; // cartes uniques par rareté, comme le profil du site
    if (n > 1 && r != null) { dupes[r][0]++; dupes[r][1] += n - 1; }
  }
  db.prepare('UPDATE players SET dupes = ? WHERE id = ?').run(JSON.stringify(dupes), player);
  const json = JSON.stringify(counts), last = db.prepare('SELECT counts FROM rar_snaps WHERE player = ? ORDER BY at DESC LIMIT 1').get(player);
  if (last?.counts !== json) db.prepare('INSERT OR REPLACE INTO rar_snaps VALUES (?, ?, ?)').run(player, at, json);
}
let statsRunning = false, statsStarted = false;
async function statsPass() {
  const me = kvGet('session')?.user_id;
  if (!me || statsRunning) return;
  statsRunning = true;
  try {
    const now = Date.now(), rows = new Map();
    for (const [sort, col] of Object.entries(STATS_SORTS)) {
      for (const r of await sb('/rest/v1/rpc/leaderboard', { method: 'POST', body: { p_sort: sort, p_limit: 200 } })) {
        const id = r.is_me ? me : r.id;
        if (!id) continue; // profil masqué
        const x = rows.get(id) || rows.set(id, { name: r.username, avatar: r.avatar_url, total: r.total, uniq: r.uniq, opened: r.opened, mythics: r.mythics }).get(id);
        x[col] = r.pos;
      }
    }
    const last = db.prepare('SELECT * FROM snaps WHERE player = ? ORDER BY at DESC LIMIT 1');
    const ins = db.prepare(`INSERT OR REPLACE INTO snaps VALUES (?, ?, ${SNAP_KEYS.map(() => '?').join(',')})`);
    const up = db.prepare('INSERT INTO players (id, name, avatar) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar');
    const active = db.prepare('UPDATE players SET active_at = ? WHERE id = ?');
    tx(() => {
      for (const [id, x] of rows) {
        up.run(id, x.name ?? null, x.avatar ?? null);
        const prev = last.get(id), v = SNAP_KEYS.map(k => x[k] ?? null);
        if (!prev || SNAP_KEYS.some((k, i) => prev[k] !== v[i])) ins.run(id, now, ...v); // seulement les changements
        // Activité : seulement les boosters ouverts (une vente ou un échange accepté par l'autre change la collection sans action du joueur).
        if (prev && prev.opened !== (x.opened ?? null)) active.run(now, id);
      }
    });
    const catalog = catalogMap();
    saveRarity(me, (await selectAll('owned_cards', 'card_id,count', 'card_id')).map(r => [r.card_id, r.count]), catalog, now);
    // Les autres : collection et envies, les moins récemment lus d'abord, avec une pause irrégulière entre deux lectures.
    const todo = db.prepare('SELECT id FROM players WHERE id != ? ORDER BY read_at IS NOT NULL, read_at LIMIT ?').all(me, STATS_READS);
    for (const { id } of todo) {
      try {
        const { theirs } = await theirsOf(id, 0);
        if (!theirs?.private) saveRarity(id, Object.entries(theirs?.cards || {}), catalog, Date.now());
        db.prepare('UPDATE players SET read_at = ?, wishes = ? WHERE id = ?').run(Date.now(), theirs?.private ? null : JSON.stringify(theirs?.wishes || []), id);
      } catch (e) { log('Stats ' + id + ' : ' + e.message); }
      await sleep(OPEN_DELAY_MS * (1 + Math.random() * 1.5));
    }
    envyCache = null;
  } catch (e) { log('Statistiques : ' + e.message); }
  statsRunning = false;
}
function statsPlayers() {
  const me = kvGet('session')?.user_id;
  return db.prepare(`SELECT p.id, p.name, p.avatar, p.active_at, p.read_at, p.dupes, s.total, s.uniq, s.opened, s.mythics, s.pos_uniq, s.pos_total, s.pos_opened, s.pos_myth
    FROM players p LEFT JOIN snaps s ON s.player = p.id AND s.at = (SELECT MAX(at) FROM snaps WHERE player = p.id) ORDER BY s.pos_uniq IS NULL, s.pos_uniq`).all()
    .map(p => ({ ...p, dupes: p.dupes ? JSON.parse(p.dupes) : null, me: p.id === me }));
}
function statsPlayer(id) {
  return {
    snaps: db.prepare(`SELECT at, ${SNAP_KEYS.join(', ')} FROM snaps WHERE player = ? ORDER BY at`).all(id),
    rarity: db.prepare('SELECT at, counts FROM rar_snaps WHERE player = ? ORDER BY at').all(id).map(r => ({ at: r.at, counts: JSON.parse(r.counts) })),
    dupes: JSON.parse(db.prepare('SELECT dupes FROM players WHERE id = ?').get(id)?.dupes || 'null'),
    // ponytail: cartes connues du catalogue local, retirées du jeu comprises ; filtrer si le site en retire beaucoup.
    rarityTotals: db.prepare('SELECT rarity, COUNT(*) AS n FROM cards WHERE rarity IS NOT NULL GROUP BY rarity').all()
      .reduce((t, r) => { t[r.rarity] = r.n; return t; }, [0, 0, 0, 0, 0, 0, 0]),
  };
}
// Licences les plus enviées : joueurs qui veulent au moins une carte de la licence, puis cartes voulues.
let envyCache = null;
function licenceEnvy() {
  if (envyCache) return envyCache;
  const catalog = catalogMap(), m = new Map(), size = new Map();
  for (const c of catalog.values()) if (c.licence && c.rarity < 6) size.set(c.licence, (size.get(c.licence) || 0) + 1);
  const rows = db.prepare('SELECT wishes FROM players WHERE wishes IS NOT NULL').all();
  for (const { wishes } of rows) {
    const seen = new Set();
    for (const id of JSON.parse(wishes)) {
      const l = catalog.get(id)?.licence;
      if (!l) continue;
      const e = m.get(l) || m.set(l, { licence: l, players: 0, cards: 0, size: size.get(l) || 0 }).get(l);
      e.cards++;
      if (!seen.has(l)) { seen.add(l); e.players++; }
    }
  }
  return envyCache = { known: rows.length, licences: [...m.values()].sort((a, b) => b.players - a.players || b.cards - a.cards) };
}
// maxAge : la fiche ouverte reste fraîche, les pastilles de toute la liste relisent le jeu bien moins souvent.
async function tradeData(user, maxAge = TRADE_CACHE_MS) {
  if (!mineCache || Date.now() - mineCache.at >= TRADE_CACHE_MS) {
    const [owned, wishes, market] = await Promise.all([
      selectAll('owned_cards', 'card_id,count', 'card_id'),
      selectAll('card_wishes', 'card_id', 'card_id'),
      sb('/rest/v1/rpc/market_me', { method: 'POST', body: {} }),
    ]);
    // Comme sur le site : dans un échange en attente, j'ai proposé give contre get ; dans un échange reçu, c'est l'inverse.
    const waiting = (market?.trades || []).filter(t => t.status === 'attente');
    const incoming = waiting.flatMap(t => (t.mine ? t.get : t.give) || []), outgoing = waiting.flatMap(t => (t.mine ? t.give : t.get) || []);
    mineCache = { at: Date.now(), owned: new Map(owned.map(r => [r.card_id, r.count])), wishes: new Set(wishes.map(r => r.card_id)), incoming: new Set(incoming), outgoing: new Set(outgoing) };
  }
  const { theirs, read } = await theirsOf(user, maxAge);
  return { owned: mineCache.owned, wishes: mineCache.wishes, incoming: mineCache.incoming, outgoing: mineCache.outgoing, theirs, read };
}
async function theirsOf(user, maxAge) {
  let entry = theirsCache.get(user), read = false;
  if (!entry || Date.now() - entry.at >= maxAge) {
    entry = { at: Date.now(), theirs: await sb('/rest/v1/rpc/trade_cards_of', { method: 'POST', body: { p_user: user } }) };
    theirsCache.set(user, entry);
    read = true;
  }
  return { theirs: entry.theirs, read };
}
// Trouve des échanges à rareté égale ; le mode « dupes » ignore les envies des deux joueurs.
// safe : écarte ses seuls exemplaires dans une licence qu'il cherche (un doublon reste proposé).
// pending : écarte les cartes déjà engagées dans un échange en attente, des deux côtés, sans toucher aux envies du site.
function tradeOffers({ owned, wishes, incoming, outgoing, theirs }, mode, link, { safe = false, pending = false } = {}) {
  if (theirs?.private) return { private: true, name: theirs.username, link };
  const [onlyMyDupes, onlyTheirDupes, ignoreWishes] = TRADE_MODES[mode];
  const hisCards = theirs?.cards || {}, hisWishes = new Set(theirs?.wishes || []);
  const catalog = new Map(db.prepare('SELECT id, name, licence, rarity, art FROM cards').all().map(c => [c.id, c]));
  // Les variantes alternatives ne comptent pas dans la progression d'une licence.
  const known = list => [...list].map(id => catalog.get(id)).filter(c => c && c.rarity != null);
  const perLicence = list => { const m = new Map(); for (const c of list) if (c.rarity < 6) m.set(c.licence, (m.get(c.licence) || 0) + 1); return m; };
  const licenceTotal = perLicence(catalog.values()), hisOwned = perLicence(known(Object.keys(hisCards))), hisLicenceWishes = perLicence(known(hisWishes));
  const giveSource = ignoreWishes ? owned.keys() : hisWishes;
  const getSource = ignoreWishes ? Object.keys(hisCards) : wishes;
  const give = known(giveSource).filter(c => !(ignoreWishes && hisCards[c.id] > 0) && !(pending && outgoing.has(c.id)) && (owned.get(c.id) || 0) >= (onlyMyDupes ? 2 : 1)).map(c => ({ ...c, copies: owned.get(c.id) }));
  const giveIds = new Set(give.map(c => c.id));
  const get = known(getSource).filter(c => !(ignoreWishes && owned.get(c.id) > 0) && !(pending && incoming.has(c.id)) && !giveIds.has(c.id) && hisCards[c.id] >= (onlyTheirDupes ? 2 : 1)).map(c => {
    const copies = hisCards[c.id], n = hisLicenceWishes.get(c.licence) || 0, have = hisOwned.get(c.licence) || 0, total = licenceTotal.get(c.licence) || 0;
    // ponytail: simple estimation ; un doublon se donne sans risque, sinon envies dans la licence puis progression à 50 %.
    const level = copies > 1 ? 'low' : n > 0 ? 'high' : have * 2 >= total ? 'medium' : 'low';
    return { ...c, copies, risk: { level, wishes: n, owned: have, total } };
  }).filter(c => !safe || c.risk.level !== 'high');
  // À choix égal : je donne d'abord mes doublons des licences les moins enviées, et je demande ses cartes des licences les plus enviées.
  const envy = new Map(licenceEnvy().licences.map(l => [l.licence, l.players])), env = c => envy.get(c.licence) || 0;
  give.sort((a, b) => (b.copies > 1) - (a.copies > 1) || env(a) - env(b) || b.copies - a.copies);
  get.sort((a, b) => RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || env(b) - env(a) || b.copies - a.copies);
  const rarities = [], pack = { give: [], get: [] };
  for (let rarity = 6; rarity >= 0; rarity--) {
    const g = give.filter(c => c.rarity === rarity), r = get.filter(c => c.rarity === rarity), pairs = Math.min(g.length, r.length);
    if (!pairs) continue;
    rarities.push({ rarity, pairs, give: g, get: r });
    const n = Math.min(pairs, TRADE_MAX - pack.give.length);
    pack.give.push(...g.slice(0, n));
    pack.get.push(...r.slice(0, n));
  }
  return { name: theirs?.username, link, wishes: ignoreWishes ? null : hisWishes.size, pack, rarities };
}
// Taille de l'échange maximum pour chaque combinaison de filtres : la page change de filtre sans rien relire.
function tradeCounts(data) {
  const counts = {};
  if (!data.theirs?.private) {
    for (const mode of Object.keys(TRADE_MODES)) {
      for (const safe of [false, true]) for (const pending of [false, true])
        counts[mode + (safe ? 'Safe' : '') + (pending ? 'Pending' : '')] = tradeOffers(data, mode, '', { safe, pending }).pack.give.length;
    }
  }
  return { counts, read: data.read };
}
// Échange manuel : toutes les cartes des deux côtés, avec la cote du site pour la jauge de valeur.
// Valeur = cote de référence du marché, sinon le prix moyen par rareté du site (MK_BASE).
const BASE_VALUE = [5, 20, 40, 75, 175, 1200, 1200]; // ponytail: Mythique Alternative comptée comme une Mythique, le site n'a pas de prix pour elle
let cotesCache = null;
async function cotes() {
  if (!cotesCache || Date.now() - cotesCache.at >= MARKET_CACHE_MS) cotesCache = { at: Date.now(), value: await sb('/rest/v1/rpc/market_cotes', { method: 'POST', body: {} }) || {} };
  return cotesCache.value;
}
async function manualTrade(user) {
  const [{ owned, wishes, incoming, outgoing, theirs }, k] = await Promise.all([tradeData(user), cotes()]);
  const catalog = catalogMap(), his = theirs?.private ? null : theirs?.cards || {}, hisWishes = new Set(his ? theirs.wishes || [] : []);
  // Collection privée : on peut demander n'importe quelle carte du catalogue, comme sur le site.
  const ids = his ? new Set([...owned.keys(), ...Object.keys(his)]) : catalog.keys(), cards = [];
  for (const id of ids) {
    const c = catalog.get(id), mine = owned.get(id) || 0, their = his ? his[id] || 0 : null;
    if (c && (mine || their !== 0)) cards.push({ ...c, mine, theirs: their, myWish: wishes.has(id), theirWish: hisWishes.has(id),
      pendingOut: outgoing.has(id), pendingIn: incoming.has(id), value: k[id]?.[0] || BASE_VALUE[c.rarity] || BASE_VALUE[0] });
  }
  return { private: !!theirs?.private, name: theirs?.username, cards };
}
async function proposeTrade({ to, give, get, message = '' }) {
  // Une même carte peut revenir plusieurs fois (plusieurs exemplaires), comme sur le site, qui vérifie les exemplaires.
  const validCards = l => Array.isArray(l) && l.length >= 1 && l.length <= TRADE_MAX && l.every(id => typeof id === 'string' && id);
  if (typeof to !== 'string' || !to || !validCards(give) || !validCards(get)) return [400, { error: `Il faut de 1 à ${TRADE_MAX} cartes de chaque côté.` }];
  if (typeof message !== 'string' || message.trim().length > TRADE_MESSAGE_MAX) return [400, { error: `Message limité à ${TRADE_MESSAGE_MAX} caractères.` }];
  // Les pièces restent toujours à zéro : la surcouche n'en dépense jamais.
  const id = await sb('/rest/v1/rpc/trade_propose', { method: 'POST', body: { p_to: to, p_give: give, p_get: get, p_give_coins: 0, p_get_coins: 0, p_message: message.trim() } });
  mineCache = null;
  theirsCache.delete(to);
  log(`Proposition d'échange envoyée : ${give.length} contre ${get.length}`);
  return [200, { ok: true, id }];
}
// ---- Échanges en attente : vus de mon côté (je donne / je reçois), avec mes exemplaires de chaque carte ----
const catalogMap = () => new Map(db.prepare('SELECT id, name, licence, rarity, art FROM cards').all().map(c => [c.id, c]));
async function pendingTrades(all = false) {
  const [market, owned] = await Promise.all([sb('/rest/v1/rpc/market_me', { method: 'POST', body: {} }), selectAll('owned_cards', 'card_id,count', 'card_id')]);
  const have = new Map(owned.map(r => [r.card_id, r.count])), catalog = catalogMap();
  const trades = (market?.trades || []).filter(t => all || t.status === 'attente');
  // Historique : exemplaires actuels de l'autre joueur (null si collection privée ou illisible).
  // ponytail: une lecture par joueur, en série, gardée 6 h comme les pastilles ; à étaler si l'historique devient long.
  const others = new Map();
  if (all) for (const p of new Set(trades.map(t => t.mine ? t.to : t.from).filter(Boolean))) {
    try { const { theirs } = await theirsOf(p, BADGE_CACHE_MS); others.set(p, theirs?.private ? null : theirs?.cards || {}); } catch { others.set(p, null); }
  }
  const card = (id, his) => ({ id, name: null, licence: null, rarity: null, art: null, ...catalog.get(id), owned: have.get(id) || 0,
    ...(all && { theirs: his ? his[id] || 0 : null }) });
  const act = activity();
  return trades.map(t => { const his = others.get(t.mine ? t.to : t.from); return {
    id: t.id, mine: !!t.mine, status: t.status, closed_at: t.closed_at, message: t.message || '', created_at: t.created_at, expires_at: t.expires_at,
    name: t.mine ? t.to_name : t.from_name, avatar: t.mine ? t.to_av : t.from_av, player: t.mine ? t.to : t.from, active_at: act.get(t.mine ? t.to : t.from) ?? null,
    give: ((t.mine ? t.give : t.get) || []).map(id => card(id, his)), get: ((t.mine ? t.get : t.give) || []).map(id => card(id, his)),
    giveCoins: (t.mine ? t.give_coins : t.get_coins) || 0, getCoins: (t.mine ? t.get_coins : t.give_coins) || 0,
  }; });
}
async function respondTrade({ id, accept }) {
  const t = (await pendingTrades()).find(x => x.id === id);
  if (!t) return [400, { error: 'Cet échange n\'est plus en attente.' }];
  // Même règle que l'envoi : la surcouche ne dépense jamais de pièces.
  if (accept && !t.mine && t.giveCoins > 0) return [400, { error: 'Cet échange te coûte des pièces : accepte-le sur le site.' }];
  await sb('/rest/v1/rpc/trade_respond', { method: 'POST', body: { p_id: id, p_accept: !t.mine && accept === true } });
  mineCache = null;
  if (t.player) theirsCache.delete(t.player);
  log(`Échange avec ${t.name || 'un joueur'} ${t.mine ? 'annulé' : accept === true ? 'accepté' : 'refusé'}`);
  return [200, { ok: true }];
}

// ---- Recyclage : toujours au moins un exemplaire gardé, une carte à la fois en arrière-plan ----
const RECYCLE_VALUE = [1, 1, 3, 5, 10, 50]; // pièces par carte selon la rareté, comme sur le site
let recycleJob = null;
async function collection() {
  const catalog = catalogMap();
  return (await selectAll('owned_cards', 'card_id,count', 'card_id'))
    .map(r => ({ ...catalog.get(r.card_id), count: r.count }))
    .filter(c => c.id && c.count > 0 && RECYCLE_VALUE[c.rarity] != null); // ponytail: Mythiques Alternatives exclues, valeur de recyclage inconnue
}
async function startRecycle({ items }) {
  if (recycleJob?.running) return [409, { error: 'Un recyclage est déjà en cours.' }];
  if (!Array.isArray(items) || !items.length || items.length > 2000) return [400, { error: 'Sélection vide ou invalide.' }];
  const owned = new Map((await collection()).map(c => [c.id, c])), list = [];
  for (const { id, n } of items) {
    const c = owned.get(id);
    if (!c || !Number.isInteger(n) || n < 1 || n > c.count - 1 || list.some(x => x.id === id)) return [400, { error: `${c?.name || id} : quantité invalide, il faut garder au moins un exemplaire.` }];
    list.push({ id, n, name: c.name });
  }
  recycleJob = { running: true, done: 0, total: list.length, cards: 0, coins: 0, error: null };
  (async () => {
    for (const { id, n, name } of list) {
      try {
        const r = await sb('/rest/v1/rpc/recycle_card', { method: 'POST', body: { p_card: id, p_n: n } });
        recycleJob.cards += r?.cards ?? n;
        recycleJob.coins += r?.coins ?? 0;
      } catch (e) { recycleJob.error = `${name} : ${e.message}`; break; }
      recycleJob.done++;
      await sleep(OPEN_DELAY_MS);
    }
    recycleJob.running = false;
    mineCache = null;
    log(`Recyclage : ${recycleJob.cards} carte${recycleJob.cards > 1 ? 's' : ''}, +${recycleJob.coins} pièces` + (recycleJob.error ? ` (arrêté : ${recycleJob.error})` : ''));
    try { lastProfile = await profile(); } catch {}
  })();
  return [200, { ok: true }];
}

// ---- Marché : routines d'achat à prix fixe, achat après un délai tiré au hasard ----
const MARKET_MS = (+process.env.MARKET_MIN || 5) * 60000;
const MARKET_CACHE_MS = process.env.MARKET_CACHE_MS ? +process.env.MARKET_CACHE_MS : 60000; // annonces affichées : relues au plus une fois par minute
const DELAY_UNIT_MS = +process.env.DELAY_UNIT_MS || 60000; // réduit par test.js
let market = { at: 0, listings: [] }, spent = 0; // spent : pièces engagées au marché, pour que openAll ne crie pas à la fuite
const planned = new Map(); // id d'annonce → { routine, card, price, at, timer }
// Conditions d'une routine, comme un WHERE : where = [groupe OU groupe…], chaque groupe = [condition ET condition…].
const COND_OPS = { card: ['=', '!='], licence: ['=', '!='], rarity: ['=', '!=', '>=', '<='], price: ['<='] };
const CMP = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };
// Ancien format (une cible + un prix max) converti à la lecture.
const upgrade = r => r.where ? r : { ...r, where: [[{ f: r.kind, op: '=', v: r.kind === 'rarity' ? +r.value : r.value }, { f: 'price', op: '<=', v: r.max }]] };
const routines = () => (kvGet('routines') || []).map(upgrade);
const listMarket = async () => (market = { at: Date.now(), listings: await sb('/rest/v1/rpc/market_list', { method: 'POST', body: {} }) || [] }).listings;
function matches(r, l, c) {
  if (!r.on || l.kind !== 'fixe' || l.mine || (l.status ?? 'active') !== 'active') return false;
  const val = { card: l.card, licence: c?.licence, rarity: c?.rarity, price: l.price };
  return r.where.some(g => g.every(k => CMP[k.op](val[k.f], k.v)));
}
// Tranches [min, max] en minutes, chacune avec son poids : on tire une tranche selon les poids, puis une durée uniforme dedans.
function pickDelay(delays) {
  let x = Math.random() * delays.reduce((s, d) => s + d.pct, 0);
  const d = delays.find(d => (x -= d.pct) < 0) || delays.at(-1);
  return (d.min + Math.random() * (d.max - d.min)) * DELAY_UNIT_MS;
}
const busy = id => [...planned.values()].filter(p => p.routine === id).length;
async function scanMarket() {
  const active = routines().filter(r => r.on && r.left > 0);
  if (!kvGet('session') || !active.length || quietNow(kvGet('market_quiet'))) return;
  try { await listMarket(); } catch (e) { return log('Marché : ' + e.message); }
  const catalog = catalogMap();
  for (const l of [...market.listings].sort((a, b) => a.price - b.price)) {
    if (planned.has(l.id)) continue;
    const r = active.find(r => r.left - busy(r.id) > 0 && matches(r, l, catalog.get(l.card)));
    if (!r) continue;
    const ms = pickDelay(r.delays), name = catalog.get(l.card)?.name || l.card;
    planned.set(l.id, { routine: r.id, card: l.card, price: l.price, at: Date.now() + ms, timer: setTimeout(() => buy(l.id), ms) });
    log(`Marché : ${name} à ${l.price} pièces, achat prévu dans ${Math.round(ms / 60000)} min`);
  }
}
async function buy(id) {
  const p = planned.get(id);
  planned.delete(id);
  const r = routines().find(x => x.id === p.routine), name = catalogMap().get(p.card)?.name || p.card;
  // Tombé dans la pause : abandonné ; le premier scan après la pause le reprogramme avec un nouveau délai.
  if (quietNow(kvGet('market_quiet'))) return log(`Marché : pause, achat de ${name} reporté`);
  try {
    // Relu juste avant : l'annonce a pu partir, changer de prix, ou la routine être modifiée entre-temps.
    const l = (await listMarket()).find(x => x.id === id);
    if (!r || r.left <= 0 || !l || !matches(r, l, catalogMap().get(l.card))) return log(`Marché : ${name} n'est plus à prendre, achat annulé`);
    spent += l.price;
    try { await sb('/rest/v1/rpc/market_buy', { method: 'POST', body: { p_id: id } }); } catch (e) { spent -= l.price; throw e; }
    kvSet('routines', routines().map(x => x.id === r.id ? { ...x, left: x.left - 1 } : x));
    addBought({ card: l.card, price: l.price, routine: r.id });
    log(`Marché : ${name} acheté ${l.price} pièces`);
    lastProfile = await profile();
  } catch (e) { log(`Marché : achat de ${name} refusé : ${e.message}`); }
}
function saveRoutines(list) {
  const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!Array.isArray(list) || list.length > 50) return [400, { error: 'Liste de routines invalide.' }];
  const out = [];
  const cond = k => COND_OPS[k?.f]?.includes(k.op) && (k.f === 'rarity' ? Number.isInteger(k.v) && num(k.v, 0, 6)
    : k.f === 'price' ? Number.isInteger(k.v) && k.v >= 1 : typeof k.v === 'string' && k.v.length > 0);
  for (const r of list.map(x => x && upgrade(x))) {
    const ok = r && Array.isArray(r.where) && r.where.length >= 1 && r.where.length <= 20
      // Garde-fou : chaque groupe OU porte son prix maximum, sinon une routine pourrait vider le compte.
      && r.where.every(g => Array.isArray(g) && g.length >= 1 && g.length <= 10 && g.every(cond) && g.some(k => k.f === 'price'))
      && Number.isInteger(r.left) && num(r.left, 0, 1000)
      && Array.isArray(r.delays) && r.delays.length >= 1 && r.delays.length <= 10
      && r.delays.every(d => num(d?.min, 0, 1440) && num(d.max, d.min, 1440) && num(d.pct, 0.01, 100));
    if (!ok) return [400, { error: 'Routine invalide : conditions (chaque groupe OU avec un prix maximum), quantité et tranches de délai (min ≤ max, en minutes, poids > 0).' }];
    out.push({ id: typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID(), on: r.on !== false, left: r.left,
      where: r.where.map(g => g.map(k => ({ f: k.f, op: k.op, v: k.v }))), delays: r.delays.map(d => ({ min: d.min, max: d.max, pct: d.pct })) });
  }
  kvSet('routines', out);
  log(`Marché : ${out.length} routine${out.length > 1 ? 's' : ''} enregistrée${out.length > 1 ? 's' : ''}`);
  scanMarket();
  return [200, { ok: true, routines: out }];
}
function addBought(b) {
  kvSet('market_bought', [{ at: Date.now(), ...b }, ...(kvGet('market_bought') || [])].slice(0, 50));
  mineCache = null;
}

// ---- Enchères : offre automatique juste avant la fin, au minimum accepté par le site, jamais au-delà du plafond ----
// Le site prolonge de 2 min toute offre faite dans les 2 dernières minutes : on se réarme sur la nouvelle fin.
const SNIPE_LEAD_MS = +process.env.SNIPE_LEAD_MS || 3000;
const SNIPE_CHECK_MS = +process.env.SNIPE_CHECK_MS || 5000; // relecture après la fin pour connaître le gagnant
const minBid = l => l.bid == null ? l.price : Math.max(l.bid + 1, Math.ceil(l.bid * 1.05)); // même règle que le site (mkNeed)
const snipes = () => kvGet('snipes') || [];
const snipeTimers = new Map();
const setSnipe = (id, patch) => kvSet('snipes', snipes().map(s => s.id === id ? { ...s, ...patch } : s));
function armSnipe(s) {
  clearTimeout(snipeTimers.get(s.id));
  if (s.status !== 'wait') return snipeTimers.delete(s.id);
  const at = Date.parse(s.ends_at) + (s.leading ? SNIPE_CHECK_MS : -SNIPE_LEAD_MS);
  snipeTimers.set(s.id, setTimeout(() => fireSnipe(s.id), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1)));
}
async function fireSnipe(id) {
  const s = snipes().find(x => x.id === id);
  if (!s || s.status !== 'wait') return;
  const name = catalogMap().get(s.card)?.name || s.card;
  const end = (status, msg) => {
    setSnipe(id, { status });
    log(`Enchère ${name} : ${msg}`);
    if (status === 'won') addBought({ card: s.card, price: s.bid, auction: true });
  };
  let l;
  try { l = (await listMarket()).find(x => x.id === id); } catch (e) {
    log(`Enchère ${name} : lecture impossible (${e.message})`);
    if (Date.parse(s.ends_at) > Date.now()) return setTimeout(() => fireSnipe(id), 1000);
    return end('error', 'fin manquée');
  }
  // Disparue ou échue : gagnée si on menait au dernier passage.
  if (!l || (l.status ?? 'active') !== 'active' || Date.parse(l.ends_at) <= Date.now()) {
    const won = l ? !!l.leading : s.leading;
    return end(won ? 'won' : 'lost', won ? `gagnée à ${s.bid} pièces` : 'perdue');
  }
  const cur = { ends_at: l.ends_at, leading: !!l.leading, current: l.bid ?? null };
  if (l.leading || Date.parse(l.ends_at) - Date.now() > SNIPE_LEAD_MS + 1000) { setSnipe(id, cur); return armSnipe({ ...s, ...cur }); }
  const need = minBid(l);
  if (need > s.max) return end('over', `offre minimum ${need} au-dessus du plafond ${s.max}`);
  spent += need;
  try {
    const r = await sb('/rest/v1/rpc/market_bid', { method: 'POST', body: { p_id: id, p_amount: need } });
    const next = { ...cur, leading: true, bid: need, current: need, ends_at: r?.ends_at || l.ends_at };
    setSnipe(id, next);
    log(`Enchère ${name} : offre de ${need} pièces (plafond ${s.max})`);
    armSnipe({ ...s, ...next });
  } catch (e) {
    spent -= need;
    log(`Enchère ${name} : offre refusée (${e.message})`);
    if (Date.parse(l.ends_at) > Date.now() + 500) setTimeout(() => fireSnipe(id), 500); else end('error', 'offre refusée à la fin');
  }
}
async function saveSnipe({ id, max }) {
  if (max == null) { // retrait
    clearTimeout(snipeTimers.get(id));
    kvSet('snipes', snipes().filter(s => s.id !== id));
    return [200, { ok: true }];
  }
  const l = (await listMarket()).find(x => x.id === id);
  if (!l || l.kind !== 'enchere' || l.mine || Date.parse(l.ends_at) <= Date.now()) return [400, { error: 'Cette enchère n\'est plus disponible.' }];
  if (!Number.isInteger(max) || max < minBid(l)) return [400, { error: `Plafond trop bas : l'offre minimum est de ${minBid(l)} pièces.` }];
  const old = snipes().find(s => s.id === id);
  const s = { id, card: l.card, max, ends_at: l.ends_at, leading: !!l.leading, current: l.bid ?? null, bid: old?.bid ?? (l.leading ? l.bid : null), status: 'wait', at: old?.at ?? Date.now() };
  kvSet('snipes', [s, ...snipes().filter(x => x.id !== id)].slice(0, 100));
  armSnipe(s);
  log(`Enchère ${catalogMap().get(l.card)?.name || l.card} : plafond ${max} pièces`);
  return [200, { ok: true }];
}

async function marketState() {
  if (kvGet('session') && Date.now() - market.at >= MARKET_CACHE_MS) await listMarket().catch(e => log('Marché : ' + e.message));
  const catalog = catalogMap(), card = id => ({ id, ...catalog.get(id) }), open = market.listings.filter(l => !l.mine && (l.status ?? 'active') === 'active');
  return {
    at: market.at, every: MARKET_MS, routines: routines(),
    quiet: kvGet('market_quiet') || { on: false, from: '23:00', to: '07:00' }, quietNow: quietNow(kvGet('market_quiet')),
    listings: open.filter(l => l.kind === 'fixe').map(l => ({ id: l.id, price: l.price, seller: l.seller_name, card: card(l.card), planned: planned.get(l.id)?.at ?? null })),
    auctions: open.filter(l => l.kind === 'enchere').map(l => ({ id: l.id, price: l.price, bid: l.bid ?? null, bids: l.bids || 0, need: minBid(l), leading: !!l.leading,
      ends_at: l.ends_at, seller: l.seller_name, card: card(l.card) })),
    snipes: snipes().map(s => ({ ...s, card: card(s.card) })),
    bought: (kvGet('market_bought') || []).map(b => ({ ...b, card: card(b.card) })),
    cards: [...catalog.values()].map(c => [c.id, c.name, c.licence, c.rarity]),
  };
}

// ---- Pause horaire : aucun booster ouvert entre from et to (heure du serveur, TZ du docker-compose) ----
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function quietNow(q = kvGet('quiet'), d = new Date()) {
  if (!q?.on) return false;
  const m = d.getHours() * 60 + d.getMinutes(), min = s => +s.slice(0, 2) * 60 + +s.slice(3);
  const f = min(q.from), t = min(q.to);
  return f < t ? m >= f && m < t : f > t && (m >= f || m < t); // f > t : la pause passe minuit
}

// ---- Serveur HTTP ----
const hash = s => crypto.createHash('sha256').update(s).digest();
function authorized(req) {
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const given = Buffer.from(value, 'base64').toString();
  return crypto.timingSafeEqual(hash(given.slice(given.indexOf(':') + 1)), hash(PASSWORD));
}
// ponytail: compteur global, une attaque bloque aussi la connexion légitime tant qu'elle dure ; par IP si ça arrive.
const MAX_BAD_LOGINS = 10;
let badLogins = 0;
setInterval(() => { badLogins = 0; }, 60000).unref();
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 65536) { reject(new Error('Trop volumineux')); req.destroy(); } });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
const page = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, {
      'Content-Type': type, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; img-src https: http:; font-src https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (badLogins >= MAX_BAD_LOGINS) { res.writeHead(429, { 'Retry-After': '60' }); return res.end(); }
  if (!authorized(req)) {
    if (req.headers.authorization) badLogins++;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Aevyz", charset="UTF-8"' });
    return res.end();
  }
  try {
    const url = new URL(req.url, 'http://x');
    url.pathname = url.pathname.replace(/^\/aevyz(?=\/|$)/, '') || '/'; // publié sous /aevyz/, préfixe retiré ou non par le proxy
    if (req.method === 'GET' && url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, state());
    if (req.method === 'GET' && url.pathname === '/api/login') {
      const back = url.searchParams.get('back') || '';
      if (!/^https?:\/\/[^\s]+$/.test(back)) return send(400, { error: 'Adresse de retour invalide' });
      res.writeHead(302, { Location: await loginUrl(back), 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/history') return send(200, history(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/timeline') return send(200, timeline(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/players') {
      const d = await players(), act = activity();
      return send(200, { ...d, players: d.players.map(p => ({ ...p, active_at: act.get(p.id) ?? null })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats/players') return send(200, statsPlayers());
    if (req.method === 'GET' && url.pathname === '/api/stats/player') return send(200, statsPlayer(url.searchParams.get('id') || ''));
    if (req.method === 'GET' && url.pathname === '/api/stats/licences') return send(200, licenceEnvy());
    if (req.method === 'GET' && url.pathname === '/api/notifications')
      return send(200, await sb('/rest/v1/notifications?select=id,kind,title,body,link,read_at,created_at&order=created_at.desc&limit=40'));
    if (req.method === 'GET' && url.pathname === '/api/trades') {
      const user = url.searchParams.get('user'), mode = url.searchParams.get('mode');
      if (!user || !Object.hasOwn(TRADE_MODES, mode)) return send(400, { error: 'Joueur ou option invalide' });
      return send(200, tradeOffers(await tradeData(user), mode, `${ORIGIN}/profil?profil=${encodeURIComponent(user)}`, { safe: url.searchParams.get('safe') === '1', pending: url.searchParams.get('pending') === '1' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/trades/manual') {
      const user = url.searchParams.get('user');
      if (!user) return send(400, { error: 'Joueur invalide' });
      return send(200, await manualTrade(user));
    }
    if (req.method === 'GET' && url.pathname === '/api/trades/counts') {
      const user = url.searchParams.get('user');
      if (!user) return send(400, { error: 'Joueur invalide' });
      return send(200, tradeCounts(await tradeData(user, BADGE_CACHE_MS)));
    }
    if (req.method === 'GET' && url.pathname === '/api/pending') return send(200, await pendingTrades(url.searchParams.get('all') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/collection') return send(200, await collection());
    if (req.method === 'GET' && url.pathname === '/api/market') return send(200, await marketState());
    if (req.method === 'POST') {
      // Un autre site ne peut pas envoyer ce Content-Type sans préflight : protège contre le CSRF.
      if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'JSON attendu' });
      const body = JSON.parse(await readBody(req));
      if (url.pathname === '/api/session') return send(...await connect(String(body.session ?? '')));
      if (url.pathname === '/api/seen') { await syncVisit(); return send(200, markSeen()); }
      if (url.pathname === '/api/mode') {
        if (!Object.hasOwn(MODES, body.mode)) return send(400, { error: 'Mode inconnu' });
        kvSet('mode', body.mode);
        log('Mode : ' + MODES[body.mode]);
        schedule();
        pass();
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/trades/propose') return send(...await proposeTrade(body));
      if (url.pathname === '/api/pending/respond') return send(...await respondTrade(body));
      if (url.pathname === '/api/recycle') return send(...await startRecycle(body));
      if (url.pathname === '/api/routines') return send(...saveRoutines(body.routines));
      if (url.pathname === '/api/snipes') return send(...await saveSnipe(body));
      if (url.pathname === '/api/quiet' || url.pathname === '/api/market/quiet') { // deux pauses indépendantes : boosters et marché
        const q = { on: body.on === true, from: body.from, to: body.to }, mkt = url.pathname !== '/api/quiet';
        if (!HHMM.test(q.from) || !HHMM.test(q.to)) return send(400, { error: 'Heures attendues au format HH:MM' });
        kvSet(mkt ? 'market_quiet' : 'quiet', q);
        log(`${mkt ? 'Marché : pause' : 'Pause horaire'} ` + (q.on ? `${q.from} → ${q.to}` : 'désactivée'));
        if (mkt) scanMarket();
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/toggle') return send(...await toggle(typeof body.genre === 'string' ? body.genre : null));
    }
    send(404, { error: 'Introuvable' });
  } catch (e) {
    log('Erreur API : ' + e.message);
    send(500, { error: e.message });
  }
});

schedule();
setInterval(statsPass, STATS_MS).unref();
setInterval(scanMarket, MARKET_MS).unref();
snipes().forEach(armSnipe);
server.listen(PORT, () => { console.log(`Surcouche Aevyz sur le port ${PORT}`); pass(); scanMarket(); });
