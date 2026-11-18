const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('// SORT-START'), html.indexOf('// SORT-END'));
const ctx = vm.createContext({});
vm.runInContext(code + '\nthis.cardSorter = cardSorter;', ctx);
const { cardSorter } = ctx;

const cards = [
  { id: 'a', name: 'A', licence: 'X', rarity: 1, value: 10, n: 3 },
  { id: 'b', name: 'B', licence: 'Y', rarity: 2, value: 50, n: 1 },
  { id: 'c', name: 'C', licence: 'Z', rarity: 0, value: 30, n: 2 },
];
const pop = new Map([['X', { players: 1, cards: 5 }], ['Y', { players: 4, cards: 0 }]]);
pop.get('X').players = 1; const ids = key => cards.slice().sort(cardSorter(key, c => c.n, pop)).map(c => c.id).join('');

test('tri par défaut : rareté décroissante', () => assert.equal(ids(''), 'bac'));
test('tri par cote', () => { assert.equal(ids('value'), 'acb'); assert.equal(ids('-value'), 'bca'); });
test('tri par exemplaires', () => { assert.equal(ids('count'), 'bca'); assert.equal(ids('-count'), 'acb'); });
test('tri par popularité de la licence (inconnue = 0)', () => { assert.equal(ids('-pop'), 'bac'); assert.equal(ids('pop'), 'cab'); });
test('tri par rareté croissante', () => assert.equal(ids('rarity'), 'cab'));
