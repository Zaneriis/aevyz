const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadTradeOffers(cards) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const modesStart = source.indexOf('const TRADE_MODES = ');
  const modesEnd = source.indexOf(';', modesStart);
  const fnStart = source.indexOf('function tradeOffers(');
  const fnEnd = source.indexOf('\n// Taille de l\'échange maximum', fnStart);
  assert.ok(modesStart >= 0 && modesEnd > modesStart, 'TRADE_MODES declaration exists');
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'tradeOffers function exists');

  const context = vm.createContext({
    db: { prepare: () => ({ all: () => cards }) },
  });
  vm.runInContext(`
    ${source.slice(modesStart, modesEnd + 1)}
    const TRADE_MAX = 20;
    const RISK_ORDER = { low: 0, medium: 1, high: 2 };
    const licenceEnvy = () => ({ licences: [] }); // aucune envie connue : l'ordre ne dépend que des exemplaires
    ${source.slice(fnStart, fnEnd)}
    this.tradeOffers = tradeOffers;
  `, context);
  return context.tradeOffers;
}

test('duplicate-only suggestions ignore wishlists and exclude cards already owned by the recipient', () => {
  const cards = [
    { id: 'mine-duplicate', name: 'My duplicate', licence: 'A', rarity: 4, art: null },
    { id: 'mine-single', name: 'My single', licence: 'A', rarity: 4, art: null },
    { id: 'mine-overlap', name: 'Mine, but already theirs', licence: 'A', rarity: 4, art: null },
    { id: 'their-duplicate', name: 'Their duplicate', licence: 'B', rarity: 4, art: null },
    { id: 'their-single', name: 'Their single', licence: 'B', rarity: 4, art: null },
    { id: 'their-overlap', name: 'Theirs, but already mine', licence: 'B', rarity: 4, art: null },
  ];
  const tradeOffers = loadTradeOffers(cards);
  const result = tradeOffers({
    owned: new Map([['mine-duplicate', 2], ['mine-single', 1], ['mine-overlap', 2], ['their-overlap', 1]]),
    wishes: new Set(['mine-single']),
    incoming: new Set(),
    outgoing: new Set(),
    theirs: {
      username: 'Other player',
      cards: { 'their-duplicate': 2, 'their-single': 1, 'mine-overlap': 1, 'their-overlap': 2 },
      wishes: ['their-single'],
    },
  }, 'dupes', '/profile', {});

  assert.equal(result.wishes, null);
  assert.deepEqual(Array.from(result.pack.give, card => card.id), ['mine-duplicate']);
  assert.deepEqual(Array.from(result.pack.get, card => card.id), ['their-duplicate']);
  assert.equal(result.pack.give.length, result.pack.get.length);
});

test('legendary and mythic cards can be left out of a trade independently', () => {
  const cards = [];
  for (const [r, n] of [[3, 'epic'], [4, 'leg'], [5, 'myth'], [6, 'alt']]) {
    cards.push({ id: `mine-${n}`, name: n, licence: 'A', rarity: r, art: null }, { id: `his-${n}`, name: n, licence: 'B', rarity: r, art: null });
  }
  const tradeOffers = loadTradeOffers(cards);
  const data = {
    owned: new Map(cards.filter(c => c.id.startsWith('mine-')).map(c => [c.id, 2])),
    wishes: new Set(cards.filter(c => c.id.startsWith('his-')).map(c => c.id)),
    incoming: new Set(), outgoing: new Set(),
    theirs: { username: 'X', cards: Object.fromEntries(cards.filter(c => c.id.startsWith('his-')).map(c => [c.id, 2])), wishes: cards.filter(c => c.id.startsWith('mine-')).map(c => c.id) },
  };
  const rars = opts => Array.from(tradeOffers(data, 'classic', '/p', opts).rarities, r => r.rarity);
  assert.deepEqual(rars({}), [6, 5, 4, 3]);
  assert.deepEqual(rars({ noLeg: true }), [6, 5, 3]);
  assert.deepEqual(rars({ noMyth: true }), [4, 3]);
  assert.deepEqual(rars({ noLeg: true, noMyth: true }), [3]);
});

test('rarity options do not change the risk evaluation used by « safe »', () => {
  const cards = [
    { id: 'mine-common', name: 'c', licence: 'L', rarity: 0, art: null },
    { id: 'his-wish-leg', name: 'l', licence: 'L', rarity: 4, art: null },
    { id: 'his-common', name: 'h', licence: 'L', rarity: 0, art: null },
  ];
  const tradeOffers = loadTradeOffers(cards);
  const data = {
    owned: new Map([['mine-common', 1]]), wishes: new Set(['his-common']), incoming: new Set(), outgoing: new Set(),
    theirs: { username: 'X', cards: { 'his-common': 1 }, wishes: ['mine-common', 'his-wish-leg'] },
  };
  const ids = opts => Array.from(tradeOffers(data, 'classic', '/p', opts).pack.get, c => c.id);
  assert.deepEqual(ids({ safe: true }), []);
  assert.deepEqual(ids({ safe: true, noLeg: true }), []);
});
