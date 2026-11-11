'use strict';
// Lance le vrai server.js contre un faux Aevyz : aucun appel au vrai site. Usage : node test.js
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const FAKE = 18788, APP = 18787, PASS = 'test-pass';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aevyz-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ME = 'user-1';
const iso = ago => new Date(Date.now() - ago).toISOString();

const game = {
  profile: { coins: 500, charges: 0, charges_at: iso(0), bonus_packs: 0, banned: false },
  openings: [
    { id: 'manual-old', genre: 'action', cards: ['c1', 'c2'], created_at: iso(40 * 864e5) },
    { id: 'manual-new', genre: 'ev-old', cards: ['c3', 'retired'], created_at: iso(3600e3) },
  ],
  calls: [], refreshTokens: new Set(['rt-0']), coinsDropOnOpen: 0, serial: 0,
  board: [
    { id: 'moi', username: 'Moi', is_me: true, uniq: 9, total: 20, opened: 5, mythics: 1 },
    { id: 'lui', username: 'Lui', uniq: 8, total: 30, opened: 9, mythics: 0 },
    { id: null, username: 'Masqué', uniq: 7, total: 7, opened: 1, mythics: 0 },
    { id: 'prive', username: 'Privé', uniq: 6, total: 6, opened: 2, mythics: 2 },
  ],
};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const json = (d, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const page = rows => { const o = +url.searchParams.get('offset') || 0, l = Math.min(+url.searchParams.get('limit') || 1000, 50); return json(rows.slice(o, o + l)); };
    if (p === '/config.js') { res.end(`window.KAIRO_CONFIG = { supabaseUrl: 'http://127.0.0.1:${FAKE}', supabaseAnonKey: 'anon' };`); return; }
    if (p === '/auth/v1/token') {
      const { refresh_token: rt, auth_code, code_verifier } = JSON.parse(body);
      if (url.searchParams.get('grant_type') === 'pkce') {
        const ok = auth_code === 'good' && require('node:crypto').createHash('sha256').update(code_verifier || '').digest('base64url') === game.pkce;
        if (!ok) return json({ msg: 'invalid flow state' }, 400);
      } else if (!game.refreshTokens.delete(rt)) return json({ message: 'invalid' }, 400);
      const next = 'rt-' + ++game.serial;
      game.refreshTokens.add(next);
      return json({ access_token: 'at-' + game.serial, refresh_token: next, expires_at: Date.now() / 1000 + 3600, user: { id: ME } });
    }
    if (game.jwtDead || !/^Bearer at-/.test(req.headers.authorization || '')) return json({ message: 'jwt' }, 401);
    if (p === '/rest/v1/profiles') { assert.strictEqual(url.searchParams.get('id'), 'eq.' + ME); return json([game.profile]); }
    if (p === '/rest/v1/events') return json([
      { id: 'ev-live', name: 'Live', scene: 'moba', starts_at: iso(1000), ends_at: iso(-3600e3), active: true },
      { id: 'ev-old', name: 'Vieux pack', scene: 'moba', starts_at: iso(9e9), ends_at: iso(8e9), active: true },
    ]);
    if (p === '/rest/v1/game_settings') return json([]);
    if (p === '/rest/v1/cards') return page([
      { id: 'c1', name: 'Un', licence: 'Doom', rarity: 0 }, { id: 'c2', name: 'Deux', licence: 'Doom', rarity: 4 },
      { id: 'c3', name: 'Trois', licence: 'Zelda', rarity: 5 },
      ...[['ac0', 'Alpha', 0], ['ac1', 'Alpha', 0], ['ar0', 'Alpha', 2], ['ar1', 'Alpha', 2], ['am5', 'Alpha', 5],
        ['bc0', 'Beta', 0], ['br0', 'Beta', 2], ['br1', 'Beta', 2], ['be3', 'Beta', 3], ['bc1', 'Gamma', 0], ['g2', 'Gamma', 0], ['g3', 'Gamma', 1]]
        .map(([id, licence, rarity]) => ({ id, name: id, licence, rarity })),
    ]);
    if (p === '/rest/v1/card_art') return page([{ card_id: 'c1', path: 'a/c1.webp' }]);
    if (p === '/rest/v1/alt_cards') return page([{ id: 'alt1', base_card: 'c3', style: 'Néon', poster_path: null }]);
    if (p === '/rest/v1/openings') return page(game.openings);
    if (p === '/rest/v1/owned_cards') return page([['ac0', 3], ['ac1', 1], ['ar0', 2], ['ar1', 1], ['am5', 1]].map(([card_id, count]) => ({ card_id, count })));
    if (p === '/rest/v1/card_wishes') return page(['bc0', 'bc1', 'br0', 'br1', 'be3'].map(card_id => ({ card_id })));
    if (p === '/rest/v1/rpc/market_me') return json({ trades: [
      { id: 1, mine: true, status: 'attente', to: 'lui', to_name: 'Lui', give: ['ac1'], get: ['bc0'] }, // envoyé : je donnerais ac1, je recevrais bc0
      { id: 2, mine: false, status: 'attente', from: 'lui', from_name: 'Lui', give: ['br0'], get: ['ar1', 'bc1'], message: 'Salut' }, // reçu : je recevrais br0, je donnerais ar1 et bc1
      { id: 3, mine: true, status: 'refusee', give: ['ar0'], get: ['br1'] }, // terminé : ne compte plus
      { id: 4, mine: false, status: 'attente', from: 'prive', from_name: 'Privé', give: ['bc0'], get: [], get_coins: 40 }, // reçu : me coûterait 40 pièces
    ] });
    if (p === '/rest/v1/rpc/leaderboard') {
      // Classement trié comme demandé : la position dépend du critère.
      const key = { uniq: 'uniq', total: 'total', opened: 'opened', myth: 'mythics' }[JSON.parse(body).p_sort];
      return json(game.board.slice().sort((a, b) => b[key] - a[key]).map((r, i) => ({ ...r, pos: i + 1, players: 40 })));
    }
    if (p === '/rest/v1/notifications') return json([{ id: 1, title: 'Échange reçu', body: 'Lui te propose un échange', read_at: null, created_at: iso(60000) }]);
    if (p === '/rest/v1/rpc/trade_cards_of') {
      game.tradeReads = (game.tradeReads || 0) + 1;
      if (JSON.parse(body).p_user === 'prive') return json({ private: true, username: 'Privé' });
      return json({ private: false, username: 'Lui', cards: { bc0: 2, bc1: 1, br0: 2, br1: 1, be3: 1, zzz: 1 }, wishes: ['ac0', 'ac1', 'ar0', 'ar1', 'g2'] });
    }
    if (p === '/rest/v1/rpc/market_cotes') return json({ bc0: [12, 3], br0: [null, 0] });
    if (p === '/rest/v1/rpc/trade_propose' && game.tradeRefusal) return json({ message: game.tradeRefusal }, 400);
    if (p === '/rest/v1/rpc/trade_propose') game.tradeProposal = JSON.parse(body);
    if (p === '/rest/v1/rpc/trade_respond') (game.responses ||= []).push(JSON.parse(body));
    if (p === '/rest/v1/rpc/recycle_card') {
      const a = JSON.parse(body);
      (game.recycled ||= []).push(a);
      if (game.recycleRefusal) return json({ message: game.recycleRefusal }, 400);
      return json({ cards: a.p_n, coins: a.p_n * 2, left: 1, total: 0 });
    }
    if (p === '/rest/v1/rpc/market_list') return json(game.listings || []);
    if (p === '/rest/v1/rpc/market_buy') {
      const { p_id } = JSON.parse(body), l = (game.listings || []).find(x => x.id === p_id);
      (game.bought ||= []).push(p_id);
      game.profile.coins -= l.price;
      game.listings = game.listings.filter(x => x !== l);
      return json({ coins: game.profile.coins, card: l.card });
    }
    if (p === '/rest/v1/rpc/market_bid') {
      const { p_id, p_amount } = JSON.parse(body), l = (game.listings || []).find(x => x.id === p_id);
      (game.bids ||= []).push([p_id, p_amount]);
      const need = l.bid == null ? l.price : Math.max(l.bid + 1, Math.ceil(l.bid * 1.05));
      if (p_amount < need) return json({ message: 'Offre minimum : ' + need }, 400);
      Object.assign(l, { bid: p_amount, bids: l.bids + 1, leading: true });
      if (Date.parse(l.ends_at) - Date.now() < 600) l.ends_at = iso(-600); // prolongation, à l'échelle du test
      return json({ coins: game.profile.coins, bid: p_amount, ends_at: l.ends_at });
    }
    if (p.startsWith('/rest/v1/rpc/trade_')) { game.tradeWrites = (game.tradeWrites || 0) + 1; return json({}); }
    if (p === '/rest/v1/rpc/open_booster') {
      const a = JSON.parse(body);
      game.calls.push(a);
      if (game.profile.bonus_packs + game.profile.charges < a.p_count) return json({ message: 'Plus de booster' }, 400);
      for (let i = 0; i < a.p_count; i++) {
        if (game.profile.bonus_packs > 0) game.profile.bonus_packs--; else game.profile.charges--;
        game.profile.coins -= game.coinsDropOnOpen;
        game.openings.unshift({ id: 'auto-' + game.openings.length, genre: a.p_genre, cards: ['c1', 'c2', 'c3', 'alt1', 'c1'], created_at: iso(0) });
      }
      return json(Array(a.p_count).fill(['c1', 'c2', 'c3', 'alt1', 'c1']).flat());
    }
    json({ message: 'route inconnue ' + p }, 404);
  });
});

const auth = 'Basic ' + Buffer.from('x:' + PASS).toString('base64');
const api = (route, opts = {}) => fetch(`http://127.0.0.1:${APP}${route}`, { ...opts, headers: { Authorization: auth, ...opts.headers } });
const post = (route, body) => api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const state = async () => (await api('/api/state')).json();
const hist = async q => (await api('/api/history?' + q)).json();
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); }
  assert.fail('Délai dépassé : ' + what);
};
const settled = async () => { await sleep(100); await until(async () => !(await state()).running, 'fin du passage'); };
const env = { ...process.env, PASSWORD: PASS, PORT: String(APP), DATA_DIR: dir, AEVYZ_ORIGIN: `http://127.0.0.1:${FAKE}`, OPEN_DELAY_MS: '0', INTERVAL_MIN: '60', STATS_READS: '0', DELAY_UNIT_MS: '100', SNIPE_LEAD_MS: '300', SNIPE_CHECK_MS: '200', MARKET_CACHE_MS: '0' };
let app;
const start = async () => {
  app = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => api('/api/state').then(r => r.ok, () => false), 'démarrage');
};

(async () => {
  const noPass = { ...env }; delete noPass.PASSWORD;
  assert.notStrictEqual(spawnSync(process.execPath, [path.join(__dirname, 'server.js')], { env: noPass }).status, 0, 'refuse de démarrer sans mot de passe');

  await new Promise(r => fake.listen(FAKE, r));
  await start();

  assert.strictEqual((await fetch(`http://127.0.0.1:${APP}/api/state`)).status, 401, 'mot de passe requis');
  assert.strictEqual((await api('/api/toggle', { method: 'POST', body: '{}' })).status, 415, 'protection CSRF');

  assert.strictEqual((await post('/api/session', { session: 'nope' })).status, 400);
  assert.strictEqual((await post('/api/session', { session: '{"refresh_token":"mauvais"}' })).status, 400);
  assert.strictEqual((await state()).connected, false);
  assert.strictEqual((await post('/api/session', { session: JSON.stringify({ refresh_token: 'rt-0', access_token: 'ignored' }) })).status, 200);
  await settled();

  // Connecté, sans toggle : l'historique du site est sauvegardé, rien n'est ouvert.
  assert.strictEqual(game.calls.length, 0);
  assert.strictEqual((await state()).saved, 2);
  const base = await hist('');
  assert.strictEqual(base.total, 2);
  assert.deepStrictEqual(base.openings.map(o => o.id), ['manual-new', 'manual-old'], 'plus récent en premier');
  assert.deepStrictEqual(base.openings[0].cards.map(c => c.id), ['c3', 'retired'], "cartes groupées, dans l'ordre");
  assert.strictEqual(base.openings[0].cards[1].name, null, 'carte retirée conservée');
  assert.strictEqual(base.openings[0].pack, 'Vieux pack', "nom d'un événement terminé");
  assert.strictEqual(base.openings[1].pack, 'Action');

  // Boutique et booster inconnu refusés.
  for (const genre of ['sh-bf', 'sh-myth', 'ev-old', 'nimporte']) assert.strictEqual((await post('/api/toggle', { genre })).status, 400, genre);
  assert.strictEqual((await state()).genre, null);

  // Réserve vide : aucun appel d'ouverture.
  assert.strictEqual((await post('/api/toggle', { genre: 'tous' })).status, 200);
  await settled();
  assert.strictEqual(game.calls.length, 0, 'réserve vide : aucune ouverture');

  // Réserve + offerts : tout est ouvert, sans achat, et un seul toggle à la fois.
  game.profile.charges = 2; game.profile.bonus_packs = 1;
  assert.strictEqual((await post('/api/toggle', { genre: 'ev-live' })).status, 200);
  await settled();
  assert.strictEqual(game.calls.length, 3, 'réserve et offerts ouverts');
  assert.ok(game.calls.every(c => c.p_buy === false && c.p_count === 1 && c.p_genre === 'ev-live'));
  assert.strictEqual(game.profile.coins, 500);
  let s = await state();
  assert.strictEqual(s.genre, 'ev-live');
  assert.deepStrictEqual([s.profile.stock, s.profile.bonus, s.profile.coins], [0, 0, 500]);
  assert.strictEqual(s.saved, 5);

  // Recharge calculée depuis charges_at (25 minutes = 2 boosters).
  game.calls.length = 0;
  game.profile.charges_at = iso(25 * 60000);
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.ok(game.calls.length >= 1, 'recharge détectée');
  assert.strictEqual(game.calls.length, 1, 'refus du serveur : arrêt immédiat');
  game.profile.charges_at = iso(0);

  // Filtres : un booster entier est renvoyé dès qu'une carte correspond.
  const ids = async q => (await hist(q)).openings.map(o => o.id);
  const mNew = 'manual-new', mOld = 'manual-old'; // new : c3 (5, Zelda) + retirée ; old : c1 (0, Doom) + c2 (4, Doom)
  assert.deepStrictEqual((await ids('rarity=4')).includes(mOld), true);
  assert.deepStrictEqual((await hist('rarity=4')).openings.find(o => o.id === mOld).cards.length, 2, 'booster complet');
  assert.strictEqual((await ids('rarity=4')).includes(mNew), false);
  assert.ok((await ids('rarity=4&rarity=5')).includes(mNew) && (await ids('rarity=4&rarity=5')).includes(mOld), 'plusieurs raretés');
  assert.strictEqual((await ids('rarity=6')).includes(mOld), false);
  assert.ok((await ids('rarity=6')).length > 0, 'Mythique Alternative');
  assert.ok((await ids('licence=Doom&licence=Zelda')).includes(mNew) && (await ids('licence=Doom&licence=Zelda')).includes(mOld), 'plusieurs licences');
  assert.ok(!(await ids('licence=Zelda')).includes(mOld));
  assert.ok((await ids('licence=Doom&rarity=4')).includes(mOld), 'même carte');
  assert.ok(!(await ids('licence=Doom&rarity=5')).includes(mOld), 'rareté et licence sur la même carte');
  assert.ok(!(await ids('licence=Zelda&rarity=4')).includes(mNew));
  const now = Date.now();
  assert.ok(!(await ids('from=' + (now - 8 * 3600e3))).includes(mOld), 'dernières 8 heures');
  assert.ok((await ids('from=' + (now - 8 * 3600e3))).includes(mNew));
  assert.ok(!(await ids('from=' + (now - 1800e3))).includes(mNew), 'dernières 30 minutes');
  assert.deepStrictEqual(await ids(`from=${now - 2 * 3600e3}&to=${now - 1800e3}`), [mNew], 'plage du/au');
  assert.strictEqual((await hist("licence=' OR 1=1 --")).total, 0, 'injection SQL');
  assert.strictEqual((await hist('rarity=9')).total, (await hist('')).total, 'rareté invalide ignorée');
  assert.ok((await hist('')).openings.flatMap(o => o.cards).find(c => c.art)?.art.endsWith('/cartes/a/c1.webp'));
  assert.deepStrictEqual((await hist('limit=1&offset=1')).openings.length, 1);

  // Première fois : seule la toute première apparition d'une carte est marquée.
  const flags = o => o.cards.map(c => !!c.first);
  let all = (await hist('limit=200')).openings;
  assert.deepStrictEqual(flags(all.find(o => o.id === 'manual-old')), [true, true]);
  assert.deepStrictEqual(flags(all.find(o => o.id === 'manual-new')), [true, true]);
  assert.deepStrictEqual(flags(all.at(-3)), [false, false, false, true, false], 'premier booster auto : seule alt1 est nouvelle');
  assert.deepStrictEqual(flags(all[0]), [false, false, false, false, false], 'ensuite plus rien de nouveau');
  game.openings.unshift({ id: 'dup', genre: 'tous', cards: ['z9', 'z9'], created_at: iso(0) });
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  all = (await hist('limit=200')).openings;
  assert.deepStrictEqual(flags(all.find(o => o.id === 'dup')), [true, false], 'doublon dans le même booster');

  // Cadran : une étoile par booster, avec sa meilleure rareté, et mêmes filtres que l'historique.
  const tl = await (await api('/api/timeline')).json();
  assert.strictEqual(tl.length, (await hist('')).total);
  assert.strictEqual(tl[0][1], 4, 'le plus ancien (manual-old) a pour meilleure carte une Légendaire');
  assert.ok(tl.every((r, i) => !i || tl[i - 1][0] <= r[0]), 'du plus ancien au plus récent');
  assert.strictEqual((await (await api('/api/timeline?licence=Inconnue')).json()).length, 0);

  // Mode par lot : rien sous 9, exactement 9 ensuite, offerts compris.
  assert.strictEqual((await post('/api/mode', { mode: 'autre' })).status, 400);
  game.calls.length = 0;
  game.profile.charges = 8; game.profile.bonus_packs = 0;
  assert.strictEqual((await post('/api/mode', { mode: 'batch' })).status, 200);
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual(game.calls.length, 0, '8 boosters : on attend');
  assert.strictEqual((await state()).mode, 'batch');
  game.profile.charges = 9; game.profile.bonus_packs = 3;
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.deepStrictEqual(game.calls.map(c => c.p_count), [9], '12 disponibles : un seul appel de 9');
  assert.ok(game.calls.every(c => c.p_buy === false));
  assert.strictEqual(game.profile.bonus_packs + game.profile.charges, 3);
  game.calls.length = 0;
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual(game.calls.length, 0, 'les 3 restants attendent le prochain lot');
  // Prochain passage : 30 s après l'arrivée du 9e booster d'après le compteur du site (1 en réserve + 8 recharges de 10 min),
  // au-delà du passage régulier (60 min ici) : le lot n'est pas avancé.
  game.profile.charges = 1; game.profile.bonus_packs = 0; game.profile.charges_at = iso(5 * 60000);
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual(game.calls.length, 0);
  const wait = (await state()).nextPass - Date.now();
  assert.ok(Math.abs(wait - (75 * 60000 + 30000)) < 5000, 'passage visé 1 h 15 min 30 plus tard, pas ' + Math.round(wait / 1000) + ' s');
  game.profile.charges = 2; game.profile.bonus_packs = 1; game.profile.charges_at = iso(0);
  await post('/api/mode', { mode: 'each' });
  await settled();
  assert.strictEqual(game.calls.length, 3, 'retour au mode normal : tout est ouvert');
  game.profile.charges = 0; game.profile.bonus_packs = 0;

  // Mode sneaky : le délai suit la courbe (10 à 90 min), et seul le minuteur ouvre.
  const restart = async () => { await new Promise(r => { app.once('exit', r); app.kill(); }); await start(); await settled(); };
  game.calls.length = 0;
  game.profile.charges = 3;
  const samples = [];
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual((await post('/api/mode', { mode: 'sneaky' })).status, 200);
    samples.push(((await state()).nextPass - Date.now()) / 60000);
  }
  await settled();
  assert.ok(Math.min(...samples) > 9.9 && Math.max(...samples) <= 90, 'délai entre 10 et 90 min');
  const share = (a, b) => samples.filter(m => m >= a && m < b).length / samples.length;
  assert.ok(Math.abs(share(10, 30) - 0.44) < 0.07, 'plateau : ' + share(10, 30));
  assert.ok(Math.abs(share(66, 90) - 0.14) < 0.05, 'queue : ' + share(66, 90));
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual(game.calls.length, 0, 'ni le toggle ni le changement de mode n\'ouvrent');
  await restart();
  assert.strictEqual(game.calls.length, 0, 'le démarrage n\'ouvre pas');
  assert.strictEqual((await state()).mode, 'sneaky');
  // Un booster manquant dans la sauvegarde est récupéré au démarrage, même plus ancien que le reste.
  const hole = { id: 'trou', genre: 'tous', cards: ['c1'], created_at: iso(400 * 864e5) };
  game.openings.push(hole);
  env.SNEAKY_UNIT_MS = '5';
  await restart();
  await until(() => game.calls.length === 3, 'ouverture par le minuteur');
  assert.ok(game.calls.every(c => c.p_buy === false && c.p_genre === 'tous'));
  await until(async () => (await hist('limit=200')).openings.some(o => o.id === 'trou'), 'trou comblé');
  delete env.SNEAKY_UNIT_MS;
  await restart();
  // Un booster ouvert à la main apparaît dès le retour sur la page, sans attendre un passage.
  game.openings.unshift({ id: 'main', genre: 'action', cards: ['c2'], created_at: iso(0) });
  assert.strictEqual((await (await post('/api/seen', {})).json()).count, 0, 'première visite : aucun badge');
  assert.strictEqual((await hist('limit=1')).openings[0].id, 'main');
  await post('/api/mode', { mode: 'each' });
  await settled();
  game.calls.length = 0;

  // Échanges : envies croisées et même rareté, selon les trois options.
  const people = await (await api('/api/players')).json();
  assert.strictEqual(people.total, 40);
  assert.deepStrictEqual(people.players.map(x => x.id), ['lui', 'prive'], 'ni moi ni les profils masqués');
  const trades = async mode => (await api(`/api/trades?user=lui&mode=${mode}`)).json();
  const cardIds = list => list.map(c => c.id);
  const classic = await trades('classic');
  assert.deepStrictEqual(classic.rarities.map(r => [r.rarity, r.pairs]), [[2, 2], [0, 2]], 'pas d\'épique : rien à donner en face');
  assert.deepStrictEqual(cardIds(classic.rarities[1].give), ['ac0', 'ac1']);
  assert.deepStrictEqual(cardIds(classic.rarities[1].get), ['bc0', 'bc1']);
  assert.deepStrictEqual(cardIds(classic.rarities[0].get), ['br0', 'br1']);
  assert.deepStrictEqual(classic.pack.give.map(c => c.rarity), classic.pack.get.map(c => c.rarity), 'mêmes raretés de chaque côté');
  assert.strictEqual(classic.pack.give.length, 4);
  const riskOf = id => classic.rarities.flatMap(r => r.get).find(c => c.id === id).risk.level;
  assert.strictEqual(riskOf('bc0'), 'low', 'un doublon se donne facilement');
  assert.strictEqual(riskOf('bc1'), 'high', 'seul exemplaire et envies dans la licence');
  assert.strictEqual(riskOf('br1'), 'medium', 'seul exemplaire, licence bien avancée');
  const mine = await trades('mine');
  assert.deepStrictEqual(mine.rarities.flatMap(r => cardIds(r.give)), ['ar0', 'ac0'], 'seulement mes doublons');
  assert.deepStrictEqual(cardIds(mine.rarities[0].get), ['br0', 'br1'], 'toutes ses cartes');
  assert.strictEqual(mine.pack.give.length, 2);
  const both = await trades('both');
  assert.deepStrictEqual(both.rarities.flatMap(r => cardIds(r.get)), ['br0', 'bc0'], 'seulement ses doublons');
  assert.strictEqual(game.tradeReads, 1, 'changer d\'option ne relit pas le jeu');
  assert.deepStrictEqual(await (await api('/api/trades?user=prive&mode=classic')).json(), { private: true, name: 'Privé', link: `http://127.0.0.1:${FAKE}/profil?profil=prive` });
  assert.strictEqual((await api('/api/trades?user=lui&mode=autre')).status, 400);
  assert.strictEqual((await api('/api/trades?mode=classic')).status, 400);
  assert.ok(!game.tradeWrites, 'aucune proposition envoyée au jeu');

  // Filtre : ses seuls exemplaires d'une licence qu'il cherche sont écartés, jamais ses doublons, et ça se combine aux options.
  const safe = await (await api('/api/trades?user=lui&mode=classic&safe=1')).json();
  assert.deepStrictEqual(safe.rarities.flatMap(r => cardIds(r.get)), ['br0', 'br1', 'bc0'], 'bc1 écartée, le doublon bc0 reste');
  assert.deepStrictEqual(safe.rarities.map(r => r.pairs), [2, 1]);
  assert.strictEqual(safe.pack.give.length, 3);

  // Filtre « en attente » : les cartes déjà engagées disparaissent, chacune de son côté seulement.
  const waiting = await (await api('/api/trades?user=lui&mode=classic&pending=1')).json();
  assert.deepStrictEqual(waiting.rarities.flatMap(r => cardIds(r.get)), ['br1', 'bc1'], 'bc0 et br0 attendues ; br1 (refusé) et bc1 (de l\'autre côté) restent');
  assert.deepStrictEqual(waiting.rarities.flatMap(r => cardIds(r.give)), ['ar0', 'ac0'], 'ac1 et ar1 déjà proposées ; ar0 (échange refusé) reste');

  // Pastilles : toutes les combinaisons d'un coup, sans relire le jeu si la collection est en cache.
  const reads = game.tradeReads;
  const counted = await (await api('/api/trades/counts?user=lui')).json();
  assert.deepStrictEqual(counted, { counts: {
    classic: 4, classicSafe: 3, classicPending: 2, classicSafePending: 1,
    mine: 2, mineSafe: 2, minePending: 2, mineSafePending: 1,
    both: 2, bothSafe: 2, bothPending: 0, bothSafePending: 0,
    dupes: 2, dupesSafe: 2, dupesPending: 0, dupesSafePending: 0,
  }, read: false });
  assert.strictEqual(game.tradeReads, reads);
  assert.deepStrictEqual((await (await api('/api/trades/counts?user=prive')).json()).counts, {}, 'collection privée : pas de pastille');
  assert.strictEqual((await api('/api/trades/counts')).status, 400);

  // Envoi : refus avant tout appel au jeu si la proposition est invalide.
  const proposal = { to: 'lui', give: ['ac0'], get: ['bc0'], message: '  Salut !  ' };
  const tooMany = Array.from({ length: 21 }, (_, i) => 'x' + i);
  for (const bad of [{ give: [] }, { get: [] }, { get: tooMany }, { to: '' }, { message: 'x'.repeat(281) }, { message: 3 }])
    assert.strictEqual((await post('/api/trades/propose', { ...proposal, ...bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.ok(!game.tradeWrites, 'proposition invalide jamais transmise');
  game.tradeRefusal = 'Carte déjà engagée';
  const refused = await post('/api/trades/propose', proposal);
  assert.strictEqual(refused.status, 500);
  assert.strictEqual((await refused.json()).error, 'Carte déjà engagée', 'le refus du site est affiché tel quel');
  delete game.tradeRefusal;
  assert.strictEqual((await post('/api/trades/propose', { ...proposal, p_give_coins: 500 })).status, 200);
  assert.deepStrictEqual(game.tradeProposal, { p_to: 'lui', p_give: ['ac0'], p_get: ['bc0'], p_give_coins: 0, p_get_coins: 0, p_message: 'Salut !' }, 'jamais de pièces');
  assert.strictEqual((await post('/api/trades/propose', { ...proposal, give: ['ac0', 'ac0'] })).status, 200, 'deux exemplaires de la même carte');
  assert.deepStrictEqual(game.tradeProposal.p_give, ['ac0', 'ac0']);
  const beforeResend = game.tradeReads;
  await api('/api/trades?user=lui&mode=classic');
  assert.strictEqual(game.tradeReads, beforeResend + 1, 'les collections sont relues après un envoi');
  // Échange manuel : les deux collections, envies, cartes en attente et valeur (cote, sinon prix par rareté).
  const man = await (await api('/api/trades/manual?user=lui')).json(), mc = id => man.cards.find(c => c.id === id);
  assert.deepStrictEqual([man.private, man.name, man.cards.length], [false, 'Lui', 10], 'mes cartes et les siennes, carte inconnue ignorée');
  assert.deepStrictEqual(mc('ac0'), { id: 'ac0', name: 'ac0', licence: 'Alpha', rarity: 0, art: null, mine: 3, theirs: 0, myWish: false, theirWish: true, pendingOut: false, pendingIn: false, value: 5 });
  assert.deepStrictEqual([mc('bc0').value, mc('bc0').myWish, mc('bc0').pendingIn, mc('br0').value, mc('ac1').pendingOut, mc('am5').value], [12, true, true, 40, true, 1200], 'cote, envie, en attente');
  const manPriv = await (await api('/api/trades/manual?user=prive')).json();
  assert.deepStrictEqual([manPriv.private, manPriv.cards.length, manPriv.cards.every(c => c.theirs === null)], [true, 16, true], 'collection privée : tout le catalogue');
  assert.strictEqual((await api('/api/trades/manual')).status, 400);

  // Échanges en attente : vus de mon côté, avec mes exemplaires.
  const pend = await (await api('/api/pending')).json();
  assert.deepStrictEqual(pend.map(t => t.id), [1, 2, 4], 'seulement les échanges en attente');
  const sent = pend[0], got = pend[1];
  assert.deepStrictEqual([sent.mine, sent.name, sent.give.map(c => c.id), sent.get.map(c => c.id)], [true, 'Lui', ['ac1'], ['bc0']]);
  assert.deepStrictEqual([got.mine, got.give.map(c => [c.id, c.owned]), got.get.map(c => [c.id, c.owned])], [false, [['ar1', 1], ['bc1', 0]], [['br0', 0]]], "reçu : je donne ce qu'il demande");
  assert.strictEqual(pend[2].giveCoins, 40);
  const histo = await (await api('/api/pending?all=1')).json();
  assert.deepStrictEqual(histo.map(t => [t.id, t.status]), [[1, 'attente'], [2, 'attente'], [3, 'refusee'], [4, 'attente']], 'historique : tous les statuts');
  assert.deepStrictEqual(histo[1].give.concat(histo[1].get).map(c => [c.id, c.owned, c.theirs]), [['ar1', 1, 0], ['bc1', 0, 1], ['br0', 0, 2]], 'exemplaires actuels des deux côtés');
  assert.deepStrictEqual(histo[3].get.map(c => c.theirs), [null], 'collection privée : inconnu');
  assert.ok(!('theirs' in pend[0].give[0]), 'en attente : pas de lecture des autres collections');
  const respond = b => post('/api/pending/respond', b);
  assert.strictEqual((await respond({ id: 4, accept: true })).status, 400, 'jamais de pièces dépensées');
  assert.strictEqual((await respond({ id: 3, accept: false })).status, 400, 'échange terminé');
  assert.strictEqual((await respond({ id: 2, accept: true })).status, 200);
  assert.strictEqual((await respond({ id: 1, accept: true })).status, 200, "un envoi ne peut qu'être annulé");
  assert.deepStrictEqual(game.responses, [{ p_id: 2, p_accept: true }, { p_id: 1, p_accept: false }]);

  // Recyclage : jamais le dernier exemplaire, une carte à la fois.
  const col = await (await api('/api/collection')).json();
  assert.deepStrictEqual(col.map(c => [c.id, c.count, c.rarity]), [['ac0', 3, 0], ['ac1', 1, 0], ['ar0', 2, 2], ['ar1', 1, 2], ['am5', 1, 5]]);
  const recycle = items => post('/api/recycle', { items });
  for (const bad of [[], [{ id: 'ac0', n: 3 }], [{ id: 'ac1', n: 1 }], [{ id: 'ac0', n: 0 }], [{ id: 'ac0', n: 1.5 }], [{ id: 'zzz', n: 1 }], [{ id: 'ac0', n: 1 }, { id: 'ac0', n: 1 }]])
    assert.strictEqual((await recycle(bad)).status, 400, JSON.stringify(bad));
  assert.ok(!game.recycled, 'sélection invalide jamais transmise');
  assert.strictEqual((await recycle([{ id: 'ac0', n: 2 }, { id: 'ar0', n: 1 }])).status, 200);
  await until(async () => !(await state()).recycle.running, 'fin du recyclage');
  assert.deepStrictEqual(game.recycled, [{ p_card: 'ac0', p_n: 2 }, { p_card: 'ar0', p_n: 1 }]);
  assert.deepStrictEqual((await state()).recycle, { running: false, done: 2, total: 2, cards: 3, coins: 6, error: null });
  game.recycleRefusal = 'Doucement';
  await recycle([{ id: 'ac0', n: 1 }, { id: 'ar0', n: 1 }]);
  await until(async () => !(await state()).recycle.running, 'arrêt du recyclage');
  assert.strictEqual(game.recycled.length, 3, 'arrêt au premier refus');
  assert.match((await state()).recycle.error, /Doucement/);
  delete game.recycleRefusal;

  // Pause horaire : aucune ouverture pendant la tranche, même si elle passe minuit.
  const hhmm = ms => { const d = new Date(Date.now() + ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  assert.strictEqual((await post('/api/quiet', { on: true, from: '7h', to: '08:00' })).status, 400);
  assert.strictEqual((await post('/api/quiet', { on: true, from: hhmm(-60000), to: hhmm(-120000) })).status, 200, 'presque 24 h, à cheval sur minuit');
  game.calls.length = 0;
  game.profile.charges = 2;
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  s = await state();
  assert.strictEqual(s.quietNow, true);
  assert.strictEqual(game.calls.length, 0, 'en pause : rien ouvert');
  await post('/api/quiet', { on: true, from: hhmm(120000), to: hhmm(180000) });
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual((await state()).quietNow, false);
  assert.strictEqual(game.calls.length, 2, 'hors de la tranche : ouverture');
  await post('/api/quiet', { on: false, from: '23:00', to: '07:00' });
  game.profile.charges = 0;

  // Statistiques : classement à chaque relevé, collections et envies lues à tour de rôle.
  env.STATS_READS = '6';
  await restart();
  const statsOf = async () => (await api('/api/stats/players')).json();
  await until(async () => (await statsOf()).find(x => x.id === 'lui')?.read_at, 'lecture des collections');
  let st = await statsOf();
  assert.deepStrictEqual(st.map(x => [x.id, x.me, x.pos_uniq, x.pos_total, x.pos_opened, x.pos_myth]),
    [[ME, true, 1, 2, 2, 2], ['lui', false, 2, 1, 1, 3], ['prive', false, 4, 4, 3, 1]], 'moi sous mon id, profils masqués écartés, une place par classement');
  const luiStats = await (await api('/api/stats/player?id=lui')).json();
  assert.deepStrictEqual(luiStats.rarity.map(r => r.counts), [[2, 0, 2, 1, 0, 0, 0]], 'cartes uniques par rareté, carte inconnue ignorée');
  assert.deepStrictEqual(luiStats.dupes, [[1, 1], [0, 0], [1, 1], [0, 0], [0, 0], [0, 0], [0, 0]], 'doublons par rareté : cartes en double, exemplaires en trop');
  assert.deepStrictEqual((await (await api('/api/stats/player?id=' + ME)).json()).dupes.slice(0, 3), [[1, 2], [0, 0], [1, 1]], 'mes doublons');
  assert.deepStrictEqual((await statsOf()).find(x => x.id === 'lui').dupes, luiStats.dupes, 'doublons dans la liste des joueurs');
  // Relecture à la demande d'une collection.
  const readsBefore = game.tradeReads;
  assert.strictEqual((await post('/api/stats/refresh', { id: 'lui' })).status, 200);
  assert.strictEqual(game.tradeReads, readsBefore + 1, 'collection relue tout de suite');
  assert.strictEqual((await post('/api/stats/refresh', { id: 'prive' })).status, 400, 'collection privée');
  assert.strictEqual((await post('/api/stats/refresh', { id: 'inconnu' })).status, 400, 'joueur inconnu');
  assert.strictEqual((await post('/api/stats/refresh', { id: ME })).status, 200, 'ma collection');
  assert.deepStrictEqual((await (await api('/api/stats/player?id=prive')).json()).rarity, [], 'collection privée : pas de raretés');
  assert.deepStrictEqual(luiStats.rarityTotals, [6, 1, 4, 1, 1, 2, 1], 'cartes du catalogue par rareté, alternatives comprises');
  assert.deepStrictEqual(await (await api('/api/stats/licences')).json(), { known: 1, licences: [
    { licence: 'Alpha', players: 1, cards: 4, size: 5 }, { licence: 'Gamma', players: 1, cards: 1, size: 3 }] }, 'licences enviées, sans mes envies');
  assert.strictEqual(st.find(x => x.id === 'lui').active_at, null, 'pas encore de mouvement');
  // Collection qui bouge sans booster (vente, échange accepté par l'autre) : pas d'activité.
  game.board[1].uniq = 7;
  const snapsBefore = (await (await api('/api/stats/player?id=prive')).json()).snaps.length;
  await restart();
  await until(async () => (await (await api('/api/stats/player?id=lui')).json()).snaps.length === 2, 'relevé des uniques');
  assert.strictEqual((await statsOf()).find(x => x.id === 'lui').active_at, null, 'collection seule : pas actif');
  game.board[1].opened++; // un booster ouvert
  await restart();
  await until(async () => (await statsOf()).find(x => x.id === 'lui').active_at, 'activité détectée');
  st = await statsOf();
  assert.strictEqual(st.find(x => x.id === ME).active_at, null, 'moi : rien n\'a bougé');
  assert.strictEqual((await (await api('/api/stats/player?id=lui')).json()).snaps.length, 3, 'un relevé par changement');
  assert.strictEqual((await (await api('/api/stats/player?id=prive')).json()).snaps.length, snapsBefore, 'rien de nouveau : pas de relevé');
  assert.ok((await (await api('/api/players')).json()).players.find(x => x.id === 'lui').active_at > 0, 'activité dans la liste des échanges');
  assert.ok((await (await api('/api/pending')).json()).find(t => t.player === 'lui').active_at > 0, 'activité sur les échanges en attente');
  assert.strictEqual((await (await api('/api/notifications')).json())[0].title, 'Échange reçu');
  env.STATS_READS = '0';

  // Solde en baisse : le toggle se coupe tout de suite.
  game.calls.length = 0;
  game.profile.charges = 5; game.coinsDropOnOpen = 150;
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  s = await state();
  assert.strictEqual(game.calls.length, 1, 'arrêt dès la première baisse');
  assert.strictEqual(s.genre, null);
  assert.match(s.alert, /pièces/);
  game.coinsDropOnOpen = 0; game.profile.charges = 0;

  // Suspension : aucune ouverture, toggle coupé.
  game.calls.length = 0;
  game.profile.banned = true; game.profile.charges = 3;
  await post('/api/toggle', { genre: 'tous' });
  await settled();
  assert.strictEqual(game.calls.length, 0);
  assert.strictEqual((await state()).genre, null);
  game.profile.banned = false; game.profile.charges = 0;

  // Redémarrage : session (jeton renouvelé), toggle et historique conservés.
  await post('/api/toggle', { genre: 'action' });
  await settled();
  const saved = (await state()).saved;
  app.kill(); await sleep(200);
  await start(); await settled();
  s = await state();
  assert.deepStrictEqual([s.connected, s.genre, s.saved], [true, 'action', saved]);

  // Boosters vus : une visite efface tout, donc un rechargement ne réaffiche rien.
  const seen = async () => (await post('/api/seen', {})).json();
  await seen();
  await sleep(20);
  game.profile.charges = 1;
  await post('/api/toggle', { genre: 'action' });
  await settled();
  const back = await seen();
  assert.strictEqual(back.count, 1, "ouvert pendant l'absence");
  assert.ok(back.previous < Date.now());
  assert.strictEqual((await seen()).count, 0, 'rechargement : plus rien de nouveau');

  // Marché : seules les annonces fixes, pas à moi, sous le prix max et dans la cible ; achat après le délai, quantité respectée.
  game.listings = [
    { id: 1, card: 'c2', kind: 'fixe', price: 40, mine: false, status: 'active' }, // Doom légendaire : oui
    { id: 2, card: 'c1', kind: 'fixe', price: 30, mine: false, status: 'active' }, // Doom commune : oui, la moins chère d'abord
    { id: 3, card: 'c2', kind: 'fixe', price: 99, mine: false, status: 'active' }, // trop cher
    { id: 4, card: 'c1', kind: 'enchere', price: 1, mine: false, status: 'active' }, // enchère
    { id: 5, card: 'c1', kind: 'fixe', price: 1, mine: true, status: 'active' }, // la mienne
    { id: 6, card: 'c3', kind: 'fixe', price: 1, mine: false, status: 'active' }, // autre licence
    { id: 9, card: 'c1', kind: 'fixe', price: 36, mine: false, status: 'active' }, // Doom commune, au-dessus du prix des communes
  ];
  // (Doom ET Légendaire ET prix ≤ 45) OU (Doom ET rareté ≤ Peu commune ET prix ≤ 35) : un prix par rareté.
  const doom = (rar, op, price) => [{ f: 'licence', op: '=', v: 'Doom' }, { f: 'rarity', op, v: rar }, { f: 'price', op: '<=', v: price }];
  const routine = { where: [doom(4, '=', 45), doom(1, '<=', 35)], left: 3, delays: [{ min: 0, max: 1, pct: 40 }, { min: 1, max: 2, pct: 60 }] };
  assert.strictEqual((await post('/api/routines', { routines: [{ ...routine, delays: [{ min: 5, max: 1, pct: 10 }] }] })).status, 400, 'tranche min > max refusée');
  assert.strictEqual((await post('/api/routines', { routines: [{ ...routine, where: [doom(4, '=', 0)] }] })).status, 400, 'prix max nul refusé');
  assert.strictEqual((await post('/api/routines', { routines: [{ ...routine, where: [doom(4, '=', 45), [{ f: 'licence', op: '=', v: 'Doom' }]] }] })).status, 400, 'groupe sans prix maximum refusé');
  assert.strictEqual((await post('/api/routines', { routines: [{ ...routine, where: [[{ f: 'rarity', op: '>', v: 1 }, { f: 'price', op: '<=', v: 9 }]] }] })).status, 400, 'opérateur inconnu refusé');
  const legacy = await (await post('/api/routines', { routines: [{ kind: 'rarity', value: '4', max: 7, left: 0, delays: routine.delays }] })).json();
  assert.deepStrictEqual(legacy.routines[0].where, [[{ f: 'rarity', op: '=', v: 4 }, { f: 'price', op: '<=', v: 7 }]], 'ancien format converti');
  assert.strictEqual((await post('/api/routines', { routines: [routine] })).status, 200);
  await until(async () => (game.bought || []).length >= 2, 'achats des routines');
  await sleep(200);
  assert.deepStrictEqual(game.bought.sort(), [1, 2], 'seulement les annonces correspondant à un groupe');
  let m = await (await api('/api/market')).json();
  assert.strictEqual(m.routines[0].left, 1, 'quantité décomptée');
  assert.strictEqual(m.bought.length, 2);
  assert.strictEqual((await state()).boughtAt.length, 2, 'pastille du marché');
  m.routines[0].left = 0;
  game.listings.push({ id: 7, card: 'c1', kind: 'fixe', price: 10, mine: false, status: 'active' });
  await post('/api/routines', { routines: m.routines });
  await sleep(300);
  assert.strictEqual(game.bought.length, 2, 'routine épuisée : plus rien');
  // Annonce disparue entre le scan et l'achat : rien n'est acheté.
  await post('/api/routines', { routines: [{ ...routine, left: 1, delays: [{ min: 3, max: 3, pct: 1 }] }] });
  await sleep(100);
  assert.ok((await (await api('/api/market')).json()).listings.some(l => l.planned), 'achat prévu');
  game.listings = [];
  await sleep(500);
  assert.strictEqual(game.bought.length, 2, 'annonce partie : achat annulé');
  // Pause du marché, indépendante de celle des boosters : ni scan ni achat.
  assert.strictEqual((await post('/api/market/quiet', { on: true, from: hhmm(-3600e3), to: hhmm(3600e3) })).status, 200);
  assert.strictEqual((await state()).quiet.on, false, 'pause des boosters inchangée');
  game.listings = [{ id: 8, card: 'c1', kind: 'fixe', price: 10, mine: false, status: 'active' }];
  await post('/api/routines', { routines: [{ ...routine, left: 1 }] });
  await sleep(500);
  m = await (await api('/api/market')).json();
  assert.ok(m.quietNow && !m.listings.some(l => l.planned) && game.bought.length === 2, 'marché en pause : rien de prévu ni acheté');
  // Modifier une routine garde son identifiant ; la fin de la pause relance le scan.
  const id = m.routines[0].id;
  await post('/api/market/quiet', { on: false, from: '23:00', to: '07:00' });
  await post('/api/routines', { routines: [{ ...m.routines[0], where: [doom(4, '=', 5), doom(1, '<=', 5)] }] });
  await sleep(500);
  m = await (await api('/api/market')).json();
  assert.strictEqual(m.routines[0].id, id, 'même routine après modification');
  assert.strictEqual(game.bought.length, 2, 'prix max abaissé : plus de correspondance');
  await post('/api/routines', { routines: [] });

  // Enchères : offre au minimum du site (+5 %, au moins +1) juste avant la fin, relance si dépassé, jamais au-dessus du plafond.
  const soon = ms => new Date(Date.now() + ms).toISOString();
  game.listings = [
    { id: 20, card: 'c2', kind: 'enchere', price: 10, bid: 50, bids: 1, leading: false, mine: false, status: 'active', ends_at: soon(1500) },
    { id: 21, card: 'c3', kind: 'enchere', price: 100, bid: null, bids: 0, leading: false, mine: false, status: 'active', ends_at: soon(1500) },
  ];
  game.bids = [];
  m = await (await api('/api/market')).json();
  assert.deepStrictEqual(m.auctions.map(a => [a.id, a.need]), [[20, 53], [21, 100]], 'enchères et offre minimum');
  assert.strictEqual((await post('/api/snipes', { id: 20, max: 52 })).status, 400, 'plafond sous le minimum refusé');
  assert.strictEqual((await post('/api/snipes', { id: 20, max: 60 })).status, 200);
  assert.strictEqual((await post('/api/snipes', { id: 21, max: 104 })).status, 200);
  assert.strictEqual(game.bids.length, 0, 'rien avant la fin');
  await until(async () => game.bids.length >= 2, 'offres juste avant la fin');
  assert.deepStrictEqual(game.bids.slice().sort((a, b) => a[0] - b[0]), [[20, 53], [21, 100]], 'offre minimum, pas le plafond');
  const a20 = game.listings.find(l => l.id === 20), a21 = game.listings.find(l => l.id === 21);
  Object.assign(a20, { bid: 57, leading: false, ends_at: soon(2500) }); // quelqu'un repasse devant, l'enchère est prolongée
  Object.assign(a21, { bid: 101, leading: false, ends_at: soon(2500) }); // minimum 107 > plafond 104
  await until(async () => game.bids.length >= 3, 'surenchère');
  assert.deepStrictEqual(game.bids[2], [20, 60], 'surenchère au minimum suivant');
  await until(async () => (await (await api('/api/market')).json()).snipes.find(s => s.id === 21).status === 'over', 'plafond dépassé');
  game.listings = game.listings.filter(l => l.id !== 20); // fin de l'enchère 20 : je menais
  await until(async () => (await (await api('/api/market')).json()).snipes.find(s => s.id === 20).status === 'won', 'enchère gagnée');
  m = await (await api('/api/market')).json();
  assert.deepStrictEqual([m.bought[0].card.id, m.bought[0].price, m.bought[0].auction], ['c2', 60, true], 'enchère gagnée dans les achats');
  assert.strictEqual(game.bids.length, 3, "pas d'offre au-delà du plafond");
  await post('/api/snipes', { id: 20, max: null });
  assert.ok(!(await (await api('/api/market')).json()).snipes.some(s => s.id === 20), 'enchère effacée');
  game.listings = [];

  // Connexion Discord (PKCE) : redirection vers Supabase, puis code collé ou renvoyé sur la surcouche, utilisable une seule fois.
  assert.strictEqual((await api('/api/login?back=javascript:alert(1)')).status, 400);
  const lr = await api('/api/login?back=' + encodeURIComponent('https://ex.org/aevyz/'), { redirect: 'manual' });
  assert.strictEqual(lr.status, 302);
  const loc = new URL(lr.headers.get('location'));
  assert.strictEqual(loc.pathname, '/auth/v1/authorize');
  assert.strictEqual(loc.searchParams.get('redirect_to'), 'https://ex.org/aevyz/');
  assert.strictEqual(loc.searchParams.get('code_challenge_method'), 's256');
  game.pkce = loc.searchParams.get('code_challenge');
  assert.strictEqual((await post('/api/session', { session: 'https://www.aevyz.com/?code=mauvais' })).status, 400, 'mauvais code refusé');
  assert.strictEqual((await state()).connected, true, 'mauvais code : session gardée');
  assert.strictEqual((await post('/api/session', { session: 'https://www.aevyz.com/?code=good#/' })).status, 200, 'adresse avec le code acceptée');
  assert.strictEqual((await post('/api/session', { session: 'https://www.aevyz.com/?code=good' })).status, 400, 'code à usage unique');
  await settled();

  // Un mauvais collage garde la session en place.
  assert.strictEqual((await post('/api/session', { session: '{"refresh_token":"mort"}' })).status, 400);
  assert.strictEqual((await state()).connected, true);

  // Session révoquée sur Aevyz : déconnexion et alerte, sans ouverture.
  game.calls.length = 0;
  game.profile.charges = 3;
  game.refreshTokens.clear(); game.jwtDead = true;
  await post('/api/toggle', { genre: 'action' });
  await settled();
  s = await state();
  assert.strictEqual(s.connected, false);
  assert.match(s.alert, /expirée/);
  assert.strictEqual(game.calls.length, 0);

  // Publication sous /aevyz/ : le préfixe est accepté, et la page n'appelle que des URL relatives.
  assert.strictEqual((await api('/aevyz/api/state')).status, 200);
  assert.strictEqual((await api('/aevyz')).status, 200);
  assert.strictEqual((await api('/aevyzz')).status, 404);
  assert.doesNotMatch(await (await api('/')).text(), /['"`]\/api\//);

  // Mots de passe faux : blocage après 10 essais, même avec le bon.
  const bad = () => fetch(`http://127.0.0.1:${APP}/api/state`, { headers: { Authorization: 'Basic ' + Buffer.from('x:faux').toString('base64') } });
  for (let i = 0; i < 10; i++) assert.strictEqual((await bad()).status, 401);
  assert.strictEqual((await bad()).status, 429);
  assert.strictEqual((await api('/api/state')).status, 429);

  console.log('OK : tous les contrôles passent');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (app) app.kill();
  fake.close(); fake.closeAllConnections();
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 300);
});
