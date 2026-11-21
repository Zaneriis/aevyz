const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('// BOOST-START'), source.indexOf('// BOOST-END')) + '\nthis.boostPlan = boostPlan; this.boostBalance = boostBalance; this.boostOutGain = boostOutGain; this.boostCoveredGain = boostCoveredGain; this.boostDone = boostDone; this.boostLicenceGain = boostLicenceGain; this.boostSplitBacks = boostSplitBacks; this.boostReturned = boostReturned;', ctx);
const { boostPlan, boostBalance, boostOutGain, boostCoveredGain, boostDone, boostLicenceGain, boostSplitBacks, boostReturned } = ctx;

const mk = (licence, rarity, n) => Array.from({ length: n }, (_, i) => ({ id: `${licence}${rarity}-${i}`, name: 'x', licence, rarity }));
const plain = x => JSON.parse(JSON.stringify(x));
const ids = o => Array.from(o.cards, c => c.id);
const own = cards => new Map(cards.map(c => [c.id, 1]));
const base = catalog => ({ catalog, owned: own(catalog), covered: new Set(), busy: new Set(), room: 150, slots: 20 });

test('les petits groupes partagent un même échange', () => {
  const r = boostPlan(base([...mk('A', 0, 4), ...mk('B', 0, 4), ...mk('C', 1, 5)]));
  assert.equal(r.outs.length, 1);
  assert.equal(r.outs[0].cards.length, 13);
  assert.equal(r.outs[0].groups.length, 3);
});

test('20 cartes maximum par échange, un grand groupe est découpé', () => {
  const r = boostPlan(base(mk('A', 0, 25)));
  assert.deepEqual(plain(r.outs.map(o => o.cards.length)), [20, 5]);
  assert.ok(r.outs[1].groups[0].n < r.outs[1].groups[0].total);
});

test('mythiques alternatives exclues', () => {
  const r = boostPlan(base([...mk('A', 6, 3), ...mk('A', 5, 1)]));
  assert.deepEqual(plain(r.outs.flatMap(ids)), ['A5-0']);
});

test('groupe incomplet, engagé ou déjà envoyé : écarté', () => {
  const cat = [...mk('A', 0, 3), ...mk('B', 0, 3), ...mk('C', 0, 3), ...mk('D', 0, 2)];
  const owned = own(cat); owned.delete('A0-1');
  const r = boostPlan({ ...base(cat), owned, busy: new Set(['B0-0']), covered: new Set(['C0-0', 'C0-1', 'C0-2']) });
  assert.deepEqual(plain(r.outs.flatMap(ids)), ['D0-0', 'D0-1']);
  assert.deepEqual(plain(r.skipped), { done: 1, missing: 1, busy: 1, his: 0 });
});

test('la limite de cartes chez lui et les emplacements plafonnent les envois', () => {
  const cat = [...mk('A', 0, 10), ...mk('B', 0, 10), ...mk('C', 0, 10)];
  assert.equal(boostPlan({ ...base(cat), room: 20 }).outs.flatMap(ids).length, 20);
  assert.equal(boostPlan({ ...base(cat), room: 9 }).outs.length, 0);
  assert.equal(boostPlan({ ...base(cat), slots: 1 }).outs.length, 1);
  assert.equal(boostPlan({ ...base(cat), slots: 0 }).outs.length, 0);
});

test('cartes restantes seulement quand un groupe est déjà en partie envoyé', () => {
  const cat = mk('A', 0, 25);
  const r = boostPlan({ ...base(cat), covered: new Set(cat.slice(0, 20).map(c => c.id)) });
  assert.equal(r.outs.flatMap(ids).length, 5);
});

test('bilan : cartes chez lui, en attente et retours possibles', () => {
  const row = (id, dir, status, cards, parent = null) => ({ id, dir, status, cards, parent });
  const b = boostBalance([
    row(1, 'out', 'acceptee', ['a', 'b']), row(2, 'out', 'acceptee', ['c']), row(3, 'back', 'acceptee', ['c'], 2),
    row(4, 'out', 'attente', ['d']), row(5, 'out', 'refusee', ['e']), row(6, 'out', 'acceptee', ['f']), row(7, 'back', 'attente', ['f'], 6),
    row(8, 'out', 'acceptee', ['g']), row(9, 'back', 'echec', ['g'], 8),
  ]);
  assert.equal(b.atHim, 2 + 1 + 1, 'a,b + f (retour en attente) + g (retour en échec)');
  assert.equal(b.pendingOut, 1);
  assert.deepEqual(plain(b.backable.map(r => r.id)), [1, 8]);
  assert.deepEqual(plain([...b.covered].sort()), ['a', 'b', 'c', 'd', 'f', 'g']);
});

test('or espéré : barème par rareté, groupes complets seulement', () => {
  const coins = [10, 15, 25, 40, 75];
  assert.equal(boostOutGain([{ rarity: 0, n: 4, total: 4 }, { rarity: 4, n: 2, total: 2 }, { rarity: 1, n: 5, total: 9 }, { rarity: 5, n: 1, total: 1 }], coins), 85);
  const cat = [...mk('A', 0, 3), ...mk('B', 2, 2)];
  assert.equal(boostCoveredGain(cat, new Set(cat.map(c => c.id)), coins), 35);
  assert.equal(boostCoveredGain(cat, new Set(['A0-0', 'A0-1', 'B2-0', 'B2-1']), coins), 25);
});

test('or espéré : un envoi qui complète un groupe en partie déjà envoyé est valorisé', () => {
  const cat = mk('A', 0, 25);
  const r = boostPlan({ ...base(cat), covered: new Set(cat.slice(0, 20).map(c => c.id)) });
  assert.equal(boostOutGain(r.outs[0].groups, [10]), 10);
});

test('groupe déjà complet chez lui : jamais envoyé, groupe partiel envoyé en entier', () => {
  const cat = [...mk('A', 0, 3), ...mk('B', 0, 3)];
  const his = { 'A0-0': 1, 'A0-1': 2, 'A0-2': 1, 'B0-0': 1 };
  const hisDone = boostDone(cat, his);
  assert.deepEqual(plain([...hisDone].sort()), ['A0-0', 'A0-1', 'A0-2']);
  const r = boostPlan({ ...base(cat), hisDone });
  assert.deepEqual(plain(r.outs.flatMap(ids)), ['B0-0', 'B0-1', 'B0-2']);
  assert.equal(r.skipped.his, 1);
});

test('or espéré : les groupes déjà complets chez lui ne rapportent rien', () => {
  const cat = [...mk('A', 0, 2), ...mk('B', 1, 2)];
  const hisDone = boostDone(cat, { 'A0-0': 1, 'A0-1': 1 });
  const goldCards = cat.filter(c => !hisDone.has(c.id));
  const coins = [10, 15, 25, 40, 75];
  const every = boostPlan({ ...base(cat), hisDone, room: Infinity, slots: Infinity });
  assert.equal(boostCoveredGain(goldCards, new Set(every.outs.flatMap(o => o.cards.map(c => c.id))), coins), 15);
  assert.equal(boostCoveredGain(goldCards, new Set(), coins), 0);
});

test('groupe complété chez lui grâce à nos envois : toujours compté dans l\'or', () => {
  const cat = mk('A', 0, 2);
  const covered = new Set(['A0-0', 'A0-1']);
  const hisDone = boostDone(cat, { 'A0-0': 1, 'A0-1': 1 }, covered);
  assert.equal(hisDone.size, 0);
  assert.equal(boostCoveredGain(cat.filter(c => !hisDone.has(c.id)), covered, [10, 15, 25, 40, 75]), 10);
  assert.equal(boostDone(cat, { 'A0-0': 1, 'A0-1': 1 }).size, 2);
});

test('bonus de licence : 5 pièces par carte, seulement une fois la licence entière chez lui ou couverte', () => {
  const cat = [...mk('A', 0, 3), ...mk('A', 1, 2), ...mk('B', 0, 2)];
  const ids5 = cat.filter(c => c.licence === 'A').map(c => c.id);
  assert.equal(boostLicenceGain(cat, new Set(ids5)).gold, 25);
  assert.equal(boostLicenceGain(cat, new Set(ids5.slice(1))).gold, 0);
  // une carte déjà chez lui complète la licence avec nos envois
  assert.equal(boostLicenceGain(cat, new Set(ids5.slice(1)), { [ids5[0]]: 1 }).gold, 25);
  // déjà complète chez lui avant nous : rien
  assert.equal(boostLicenceGain(cat, new Set(), Object.fromEntries(ids5.map(i => [i, 1]))).gold, 0);
});

test('les envois d\'une même licence sont regroupés, licences bouclables en premier', () => {
  const cat = [...mk('A', 0, 12), ...mk('B', 0, 12), ...mk('A', 1, 12), ...mk('B', 1, 12), ...mk('C', 0, 3)];
  const owned = own(cat); cat.filter(c => c.licence === 'C').forEach(c => owned.delete(c.id));
  const r = boostPlan({ ...base(cat), owned });
  const lics = r.outs.map(o => [...new Set(o.groups.map(g => g.licence))]);
  assert.deepEqual(plain(lics), [['A'], ['A'], ['B'], ['B']]);
  assert.equal(r.outs.length, 4);
});

test('retours : pas avant la licence complète, sinon retour anticipé', () => {
  const cat = [...mk('A', 0, 2), ...mk('A', 1, 1)];
  const map = new Map(cat.map(c => [c.id, c]));
  const back = [{ id: 1, cards: ['A0-0', 'A0-1'] }];
  const partial = boostSplitBacks(back, map, new Set(['A0-0', 'A0-1']));
  assert.equal(partial.ready.length, 0); assert.equal(partial.early.length, 1);
  const full = boostSplitBacks(back, map, new Set(['A0-0', 'A0-1', 'A1-0']));
  assert.equal(full.ready.length, 1);
  assert.equal(boostSplitBacks(back, map, new Set(['A0-0', 'A0-1']), { 'A1-0': 1 }).ready.length, 1);
});

test('bonus de licence : les Mythiques Alternatives ne comptent pas et ne bloquent pas', () => {
  const cat = [...mk('A', 0, 3), ...mk('A', 6, 1)];
  const c = new Set(['A0-0', 'A0-1', 'A0-2']);
  assert.equal(boostLicenceGain(cat, c).gold, 15);
  const map = new Map(cat.map(x => [x.id, x]));
  assert.equal(boostSplitBacks([{ id: 1, cards: [...c] }], map, c).ready.length, 1);
});

test('licence bouclable avant une plus grosse licence non bouclable', () => {
  const cat = [...mk('Z', 0, 3), ...mk('Big', 0, 15), ...mk('Big', 1, 5)];
  const owned = own(cat); owned.delete('Big1-0');
  const r = boostPlan({ ...base(cat), owned });
  assert.equal(r.outs[0].groups[0].licence, 'Z');
});

test('retours faits à la main : détectés sans toucher à l\'historique, toujours engagés', () => {
  const row = (id, dir, status, cards, parent = null) => ({ id, dir, status, cards, parent, closed_at: 100 });
  const rows = [row(1, 'out', 'acceptee', ['a', 'b']), row(2, 'out', 'acceptee', ['c']), row(3, 'out', 'acceptee', ['d']), row(4, 'back', 'echec', ['d'], 3), row(5, 'out', 'acceptee', ['e', 'f']), row(6, 'back', 'attente', ['e', 'f'], 5)];
  const snapshot = JSON.stringify(rows);
  const ret = boostReturned(rows, { c: 1, e: 0 }, 200);
  assert.deepEqual(plain([...ret].sort()), [1, 3], 'a,b et d absents de sa collection ; c encore là ; 5 a un retour en attente');
  assert.equal(JSON.stringify(rows), snapshot);
  const b = boostBalance(rows, ret);
  assert.equal(b.atHim, 1 + 2, 'c + e,f');
  assert.deepEqual(plain(b.backable.map(r => r.id)), [2]);
  assert.deepEqual(plain([...b.covered].sort()), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(boostReturned(rows, null, 200).size, 0, 'sans scan : rien déduit');
  assert.equal(boostReturned(rows, { c: 1 }, 100).size, 0, 'scan antérieur à l\'acceptation (cache) : rien déduit');
});

test('retours : une licence impossible à boucler ne bloque plus', () => {
  const cat = [...mk('A', 0, 2), ...mk('A', 1, 1)];
  const map = new Map(cat.map(c => [c.id, c]));
  const back = [{ id: 1, cards: ['A0-0', 'A0-1'] }], acc = new Set(['A0-0', 'A0-1']);
  assert.equal(boostSplitBacks(back, map, acc, {}, new Set(['A1-0'])).early.length, 1, 'la carte manquante peut encore être envoyée');
  const never = boostSplitBacks(back, map, acc, {}, new Set());
  assert.equal(never.ready.length, 1); assert.equal(never.early.length, 0);
});
