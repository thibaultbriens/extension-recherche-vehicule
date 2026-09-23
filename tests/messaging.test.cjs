const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
const F = require('../followup.js');
global.VanCheckFollowup = F;
global.VanCheckFormatting = require('../formatting.js');
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

test('a collapsed attachment grid exposes its full expected image count', async () => {
  setup(`<li><div class="justify-start"><img alt="image en pièce jointe" src="https://attachments.messaging.bon-coin.net/1"><img alt="image en pièce jointe" src="https://attachments.messaging.bon-coin.net/2"><img alt="image en pièce jointe" src="https://attachments.messaging.bon-coin.net/3"><div><img alt="image en pièce jointe" src="https://attachments.messaging.bon-coin.net/4"><span>+ 7</span></div></div></li>`);
  const [message] = await M.readMessages(M.activeAd().region);
  assert.equal(message.attachments.length, 4);
  assert.equal(message.expectedImageCount, 10);
});

test('gallery extraction returns every original slide in order and ignores carousel clones', () => {
  setup();
  const dialog = document.createElement('div');
  dialog.innerHTML = `<div data-index="-1" class="slick-cloned"><img src="https://attachments.messaging.bon-coin.net/10?clone"></div>${Array.from({ length: 10 }, (_, index) => `<div data-index="${index}"><img src="https://attachments.messaging.bon-coin.net/${index + 1}?signed"></div>`).join('')}<div data-index="10" class="slick-cloned"><img src="https://attachments.messaging.bon-coin.net/1?clone"></div>`;
  assert.deepEqual(M.galleryImageAttachments(dialog).map(attachment => attachment.identity), Array.from({ length: 10 }, (_, index) => `https://attachments.messaging.bon-coin.net/${index + 1}`));
});

test('file preparation expands a collapsed grid and transfers every gallery image', async () => {
  setup();
  const trigger = document.createElement('img');
  trigger.src = 'https://attachments.messaging.bon-coin.net/thumbnail-1';
  trigger.addEventListener('click', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `${Array.from({ length: 10 }, (_, index) => `<div data-index="${index}"><img src="https://attachments.messaging.bon-coin.net/original-${index + 1}?signed"></div>`).join('')}<button aria-label="Fermer"></button>`;
    dialog.querySelector('button').addEventListener('click', () => dialog.remove());
    document.body.append(dialog);
  });
  const requested = [];
  global.chrome = { runtime: { sendMessage: async message => {
    requested.push(message.url);
    return { ok: true, value: { type: 'image/jpeg', size: 1, base64: 'AA==' } };
  } } };
  const message = { expectedImageCount: 10, attachments: [{ element: trigger, url: trigger.src }] };
  const files = await M.prepareFiles([message], conversation);
  assert.equal(files.length, 10);
  assert.equal(message.attachments.length, 10, 'the follow-up prompt must list the expanded gallery too');
  assert.deepEqual(files.map(file => file.name), Array.from({ length: 10 }, (_, index) => `piece-${index + 1}.jpg`));
  assert.deepEqual(requested.map(url => new URL(url).pathname), Array.from({ length: 10 }, (_, index) => `/original-${index + 1}`));
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('attachments below 6 MiB are returned byte-for-byte without compression', async () => {
  const files = [{ name: 'piece-1.jpg', type: 'image/jpeg', size: 1024, base64: 'original' }];
  let calls = 0;
  const result = await M.optimizeFiles(files, 2048, async () => { calls++; return {}; });
  assert.strictEqual(result, files);
  assert.equal(calls, 0);
  assert.equal(result[0].base64, 'original');
});

test('only images are compressed when the combined transfer exceeds the limit', async () => {
  const pdf = { name: 'ct.pdf', type: 'application/pdf', size: 400, base64: 'pdf' };
  const photo = { name: 'piece-2.png', type: 'image/png', size: 800, base64: 'photo' };
  const calls = [];
  const result = await M.optimizeFiles([pdf, photo], 1000, async (file, target) => {
    calls.push({ file, target });
    return { ...file, name: 'piece-2.jpg', type: 'image/jpeg', size: 500, base64: 'compressed' };
  });
  assert.equal(calls.length, 1);
  assert.strictEqual(result[0], pdf);
  assert.equal(result[0].base64, 'pdf');
  assert.equal(result[1].base64, 'compressed');
  assert.equal(result.reduce((sum, file) => sum + file.size, 0), 900);
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

test('a conversation exposes only its validated linked ChatGPT discussion', () => {
  const chat = 'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';
  assert.equal(M.linkedChatUrl({ adId: '1234567890', chatUrl: chat }), chat);
  assert.equal(M.linkedChatUrl({ adId: '1234567890' }, { '1234567890': chat }), chat);
  assert.equal(M.linkedChatUrl({ adId: '1234567890', chatUrl: 'https://chatgpt.com/' }), '');
  assert.equal(M.linkedChatUrl({ adId: '1234567890', chatUrl: 'https://chatgpt.com.evil.example/c/22222222-2222-2222-2222-222222222222' }), '');
});

test('conversation list keeps the reply reminder after analysis until it is dismissed or answered', () => {
  setup();
  const analyses = { '1234567890': { adId: '1234567890', title: 'Fourgon test', contactStatus: 'WAITING_ME', followup: { conversationId: conversation, lastObservedId: 'reply-1', sentIds: ['reply-1'], analysisPending: true } } };
  M.scoreBadges(analyses);
  assert.equal(document.querySelector('[data-vancheck-analysis]').getAttribute('aria-label'), 'Réponse à envoyer au vendeur');
  assert.equal(document.querySelector('[aria-label="Liste des conversations"] p').firstElementChild.dataset.vancheckAnalysis, '');
  analyses['1234567890'].followup.dismissedIds = ['reply-1'];
  M.scoreBadges(analyses);
  assert.equal(document.querySelector('[data-vancheck-analysis]'), null);
  analyses['1234567890'].followup.dismissedIds = [];
  analyses['1234567890'].contactStatus = 'WAITING_SELLER';
  M.scoreBadges(analyses);
  assert.equal(document.querySelector('[data-vancheck-analysis]'), null, 'an outbound reply clears the reminder');
});

test('a muted conversation never displays the orange reply marker', () => {
  setup();
  const analyses = { '1234567890': { adId: '1234567890', title: 'Fourgon test', contactStatus: 'DISMISSED', followup: { conversationId: conversation, lastObservedId: 'reply-1', muted: true } } };
  M.scoreBadges(analyses);
  assert.equal(document.querySelector('[data-vancheck-analysis]'), null);
});

test('dismissed seller replies are excluded from the analysis queue only', async () => {
  setup(seller('Première réponse') + seller('Nouvelle réponse'));
  const messages = await M.readMessages(M.activeAd().region);
  const saved = { followup: { dismissedIds: [messages[0].id] } };
  assert.deepEqual(M.pendingSellerMessages(messages, saved).map(message => message.id), [messages[1].id]);
});

test('the proposed reply appears only after the follow-up analysis is complete and is not offered twice', () => {
  const fullAnalysis = 'VERDICT: A VERIFIER\nRESUME: À compléter.\nMESSAGE_VENDEUR_DEBUT\nBonjour, pouvez-vous confirmer la date du contrôle technique ?\nMESSAGE_VENDEUR_FIN';
  const saved = { contactStatus: 'WAITING_ME', fullAnalysis, followup: { analysisPending: false } };
  assert.match(M.proposedSellerMessage(saved), /contrôle technique/);
  assert.equal(M.proposedSellerMessage({ ...saved, followup: { analysisPending: true } }), '');
  assert.equal(M.proposedSellerMessage(saved, [{ id: 'new' }]), '');
  assert.equal(M.proposedSellerMessage({ ...saved, lastOutboundMessage: 'Bonjour, pouvez-vous confirmer la date du contrôle technique ?' }), '');
});
