const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('// BOOST-START'), source.indexOf('// BOOST-END')) + '\nthis.boostPlan = boostPlan; this.boostBalance = boostBalance; this.boostOutGain = boostOutGain; this.boostCoveredGain = boostCoveredGain;', ctx);
const { boostPlan, boostBalance, boostOutGain, boostCoveredGain } = ctx;

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
  assert.deepEqual(plain(r.skipped), { done: 1, missing: 1, busy: 1 });
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
