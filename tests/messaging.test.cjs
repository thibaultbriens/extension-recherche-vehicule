const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const F = require('../followup.js');
global.VanCheckFollowup = F;
const M = require('../messaging.js');
const conversation = '28a29b32-ade4-4118-9341-9545b6beda66';
const seller = text => `<li><div class="justify-start"><div data-qa-id="message-bubble">${text}</div></div><p>il y a 2 min</p></li>`;
const buyer = text => `<li><div class="justify-end"><div data-qa-id="message-bubble">${text}</div></div><span aria-label="message lu"></span></li>`;
const photo = `<li><div class="justify-start"><div><img alt="image en pièce jointe" src="https://attachments.messaging.bon-coin.net/api/v1/photo/1?jwt=old"></div></div><p>il y a 2 min</p></li>`;
function setup(rows = '') {
  const dom = new JSDOM(`<div aria-label="Liste des conversations"><a href="/messages/id/${conversation}"><p>Fourgon test</p></a></div><div aria-label="Conversation"><ol>${rows}</ol></div><div aria-label="Informations à propos de l‘annonce"><a href="/ad/utilitaires/1234567890">Fourgon test 7000 €</a></div><article><a href="/ad/utilitaires/1234567890">Galerie</a></article>`, { url: `https://www.leboncoin.fr/messages/id/${conversation}` });
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.crypto = webcrypto;
  return dom;
}

test('DOM extraction matches observed Leboncoin markup and excludes system cards', async () => {
  setup(`${buyer('Bonjour')}<li><div class="justify-start">Message automatique leboncoin</div></li>${seller('CT disponible')}${photo}<li><div class="justify-start"><a href="https://attachments.messaging.bon-coin.net/api/v1/file/ct?jwt=test">ct.pdf</a></div></li>`);
  const context = M.activeAd();
  assert.equal(context.adId, '1234567890');
  const messages = await M.readMessages(context.region);
  assert.deepEqual(messages.map(m => m.direction), ['buyer', 'seller', 'seller', 'seller']);
  assert.equal(messages[2].text, '');
  assert.equal(messages[2].attachments.length, 1);
  assert.equal(messages[3].attachments[0].name, 'ct.pdf');
  const oldIds = messages.map(m => m.id);
  document.querySelector('img').src = 'https://attachments.messaging.bon-coin.net/api/v1/photo/1?jwt=renewed';
  document.querySelectorAll('li > p').forEach(p => p.textContent = '09:21');
  assert.deepEqual((await M.readMessages(context.region)).map(m => m.id), oldIds, 'timestamps and renewed signed URLs cannot cause replays');
});

test('identical consecutive replies are distinct; new outbound messages change the status', async () => {
  setup(seller('Oui') + seller('Oui'));
  const region = M.activeAd().region;
  const initial = await M.readMessages(region);
  assert.notEqual(initial[0].id, initial[1].id);
  assert.equal(F.newSellerMessages(initial, [initial[0].id]).length, 1);
  region.querySelector('ol').insertAdjacentHTML('beforeend', buyer('Merci'));
  const next = await M.readMessages(region);
  assert.equal(F.contactStatus(next), 'WAITING_SELLER');
  assert.deepEqual(F.newSellerMessages(next, initial.map(m => m.id)), []);
});

test('unknown author and explicitly failed/pending outbound rows are ignored', async () => {
  setup(seller('Réponse') + '<li><div data-qa-id="message-bubble">Auteur inconnu</div></li><li><div class="justify-end"><div data-qa-id="message-bubble">Essai</div></div><span aria-label="échec de l’envoi"></span></li>');
  assert.equal((await M.readMessages(M.activeAd().region)).length, 1);
});

test('SPA navigation cannot associate an old ad with a new selected conversation', () => {
  setup();
  document.querySelector('[aria-label="Liste des conversations"] p').textContent = 'Autre annonce';
  assert.equal(M.activeAd(), null);
});

test('scores update in both conversation list and gallery without duplicate badges', () => {
  setup();
  const analyses = { '1234567890': { adId: '1234567890', title: 'Fourgon test', score: 7.5, summary: 'À vérifier', followup: { conversationId: conversation } } };
  M.scoreBadges(analyses);
  assert.equal(document.querySelector('[aria-label="Liste des conversations"] [data-vancheck-score]').textContent, '7,5 / 10');
  assert.equal(document.querySelector('article [data-vancheck-score]').textContent, '7,5 / 10');
  const count = document.querySelectorAll('[data-vancheck-score]').length;
  analyses['1234567890'].score = 3;
  M.scoreBadges(analyses);
  assert.equal(document.querySelectorAll('[data-vancheck-score]').length, count);
  assert.equal(document.querySelector('article [data-vancheck-score]').textContent, '3 / 10');
  M.scoreBadges({});
  assert.equal(document.querySelectorAll('[data-vancheck-score]').length, 0);
});
