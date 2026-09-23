const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(fetcher) {
  let listener;
  const data = { analyses: { '1234567890': { title: 'Fourgon', contactStatus: 'WAITING_ME', followup: { sentIds: ['old'] } } } };
  const chrome = { runtime: { id: 'test', onMessage: { addListener: fn => listener = fn } }, storage: { local: {
    get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value))
  } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), { chrome, URL, fetch: fetcher, AbortSignal, btoa, Date, console });
  const send = (message, origin = 'https://chatgpt.com') => new Promise(resolve => {
    const handled = listener(message, { id: 'test', tab: {}, url: origin + '/' }, resolve);
    if (!handled) resolve(null);
  });
  return { data, send };
}
test('simultaneous acknowledgments and contact updates preserve both histories', async () => {
  const { data, send } = setup();
  await Promise.all([
    send({ type: 'VANCHECK_ACK', adId: '1234567890', ids: ['one', 'two'] }),
    send({ type: 'VANCHECK_CONTACT', adId: '1234567890', conversationId: 'conversation', lastId: 'last', status: 'WAITING_SELLER' }, 'https://www.leboncoin.fr'),
    send({ type: 'VANCHECK_ACK', adId: '1234567890', ids: ['two', 'three'] })
  ]);
  assert.deepEqual(data.analyses['1234567890'].followup.sentIds, ['old', 'one', 'two', 'three']);
  assert.equal(data.analyses['1234567890'].contactStatus, 'WAITING_SELLER');
});
test('a dismissed reminder is retained without changing the conversation status', async () => {
  const { data, send } = setup();
  await send({ type: 'VANCHECK_DISMISS_ANALYSIS', adId: '1234567890', ids: ['seller-reply'] }, 'https://www.leboncoin.fr');
  assert.deepEqual(data.analyses['1234567890'].followup.dismissedIds, ['seller-reply']);
  assert.equal(data.analyses['1234567890'].contactStatus, 'WAITING_ME');
});
test('a muted conversation stays muted when Leboncoin refreshes its status and can be resumed', async () => {
  const { data, send } = setup();
  await send({ type: 'VANCHECK_MUTE_CONVERSATION', adId: '1234567890' }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses['1234567890'].contactStatus, 'DISMISSED');
  assert.equal(data.analyses['1234567890'].followup.muted, true);
  await send({ type: 'VANCHECK_CONTACT', adId: '1234567890', conversationId: 'conversation', lastId: 'later', status: 'WAITING_ME' }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses['1234567890'].contactStatus, 'DISMISSED');
  await send({ type: 'VANCHECK_RESUME_CONVERSATION', adId: '1234567890', status: 'WAITING_ME' }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses['1234567890'].contactStatus, 'WAITING_ME');
  assert.equal(data.analyses['1234567890'].followup.muted, undefined);
});
test('late analyses cannot overwrite a more recent score or erase contact state', async () => {
  const { data, send } = setup();
  await send({ type: 'VANCHECK_ANALYSIS', adId: '1234567890', analysis: { score: 8 }, metadata: {}, requestedAt: 20 });
  await send({ type: 'VANCHECK_ANALYSIS', adId: '1234567890', analysis: { score: 4 }, metadata: {}, requestedAt: 10 });
  assert.equal(data.analyses['1234567890'].score, 8);
  assert.equal(data.analyses['1234567890'].contactStatus, 'WAITING_ME');
  assert.deepEqual(data.analyses['1234567890'].followup.sentIds, ['old']);
});
test('a follow-up stays pending until analysis completes and remembers the sent proposal', async () => {
  const { data, send } = setup();
  await send({ type: 'VANCHECK_ACK', adId: '1234567890', ids: ['reply'] });
  assert.equal(data.analyses['1234567890'].followup.analysisPending, true);
  await send({ type: 'VANCHECK_ANALYSIS', adId: '1234567890', analysis: { score: 7, summary: 'Réponse analysée' }, metadata: {}, requestedAt: 20 });
  assert.equal(data.analyses['1234567890'].followup.analysisPending, false);
  await send({ type: 'VANCHECK_CONTACT', adId: '1234567890', conversationId: 'conversation', lastId: 'last', status: 'WAITING_SELLER', lastOutboundMessage: 'Merci pour votre réponse.' }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses['1234567890'].lastOutboundMessage, 'Merci pour votre réponse.');
});
test('attachment fetch restricts host and MIME, upgrades HTTPS and returns actual bytes', async () => {
  let called;
  const { send } = setup(async (url, options) => { called = { url, options }; return new Response(new Uint8Array([1,2,3]), { headers: { 'content-type': 'application/pdf' } }); });
  const bad = await send({ type: 'VANCHECK_ATTACHMENT', url: 'https://evil.example/file' }, 'https://www.leboncoin.fr');
  assert.equal(bad.ok, false);
  assert.equal(called, undefined);
  const good = await send({ type: 'VANCHECK_ATTACHMENT', url: 'http://attachments.messaging.bon-coin.net/api/v1/file/test?jwt=example' }, 'https://www.leboncoin.fr');
  assert.equal(good.ok, true);
  assert.equal(good.value.base64, 'AQID');
  assert.match(called.url, /^https:/);
  assert.equal(called.options.redirect, 'error');
  assert.equal(await send({ type: 'VANCHECK_ATTACHMENT', url: called.url }), null);
});
test('attachment failures are explicit and do not modify acknowledgments', async () => {
  const { data, send } = setup(async () => new Response('Login page', { headers: { 'content-type': 'text/html' } }));
  const result = await send({ type: 'VANCHECK_ATTACHMENT', url: 'https://attachments.messaging.bon-coin.net/api/v1/file/test' }, 'https://www.leboncoin.fr');
  assert.equal(result.ok, false);
  assert.deepEqual(data.analyses['1234567890'].followup.sentIds, ['old']);
});


test('first automatic analysis creates the listing and conversation link without a manual import', async () => {
  const { data, send } = setup();
  const adId = '9876543210';
  assert.equal(data.analyses[adId], undefined);
  const chatUrl = 'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';
  const result = await send({ type: 'VANCHECK_ANALYSIS', adId, requestedAt: 30, chatUrl,
    metadata: { title: 'Nouveau fourgon', price: '8000 EUR', url: `https://www.leboncoin.fr/ad/utilitaires/${adId}` },
    analysis: { verdict: 'INTERESSANT', summary: 'Entretien documenté', score: 8, fullAnalysis: 'Analyse complète' }
  });
  assert.equal(result.ok, true);
  assert.equal(data.analyses[adId].score, 8);
  assert.equal(data.analyses[adId].title, 'Nouveau fourgon');
  assert.equal(data.analyses[adId].fullAnalysis, 'Analyse complète');
  assert.equal(data.analyses[adId].chatUrl, chatUrl);
  assert.equal(data.chatUrls[adId], chatUrl);
  assert.equal(data.analyses[adId].contactStatus, undefined, 'automatic analysis does not pretend to contact the seller');
});

test('personal score and summary survive subsequent ChatGPT analyses; reset uses the latest AI values', async () => {
  const { data, send } = setup();
  const adId = '1234567890';
  const analysis = (score, summary, requestedAt) => send({ type: 'VANCHECK_ANALYSIS', adId, analysis: { score, summary, fullAnalysis: 'Texte ChatGPT' }, requestedAt });
  await analysis(7, 'Premier avis', 1);
  await send({ type: 'VANCHECK_REVIEW', adId, patch: { score: 4.5, summary: 'Trop bas pour mon projet.', personalNote: 'À revoir après visite.' } }, 'https://www.leboncoin.fr');
  await analysis(8, 'Entretien confirmé.', 2);
  assert.equal(data.analyses[adId].score, 4.5);
  assert.equal(data.analyses[adId].summary, 'Trop bas pour mon projet.');
  assert.equal(data.analyses[adId].personalNote, 'À revoir après visite.');
  assert.equal(data.analyses[adId].aiScore, 8);
  assert.equal(data.analyses[adId].aiSummary, 'Entretien confirmé.');
  assert.deepEqual(data.analyses[adId].followup.sentIds, ['old']);
  await send({ type: 'VANCHECK_REVIEW', adId, reset: true }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses[adId].score, 8);
  assert.equal(data.analyses[adId].summary, 'Entretien confirmé.');
  assert.equal(data.analyses[adId].personalNote, 'À revoir après visite.');
  assert.equal(data.analyses[adId].manualScore, undefined);
});

test('saving a personal note alone does not freeze the automatic score or summary', async () => {
  const { data, send } = setup();
  const adId = '1234567890';
  await send({ type: 'VANCHECK_REVIEW', adId, patch: { personalNote: 'Essai prévu lundi' } }, 'https://www.leboncoin.fr');
  await send({ type: 'VANCHECK_ANALYSIS', adId, analysis: { score: 9, summary: 'Bon historique' }, requestedAt: 2 });
  assert.equal(data.analyses[adId].score, 9);
  assert.equal(data.analyses[adId].summary, 'Bon historique');
  assert.equal(data.analyses[adId].personalNote, 'Essai prévu lundi');
});

test('a manual review can create a listing, and its first ChatGPT analysis takes precedence', async () => {
  const { data, send } = setup();
  const adId = '9876543210';
  await send({ type: 'VANCHECK_REVIEW', adId, metadata: { title: 'Fourgon évalué à la main' }, patch: { score: 3.5, personalNote: 'Rouille à contrôler.' } }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses[adId].score, 3.5);
  assert.equal(data.analyses[adId].personalNote, 'Rouille à contrôler.');
  await send({ type: 'VANCHECK_ANALYSIS', adId, requestedAt: 2, analysis: { score: 8, summary: 'Historique rassurant' } });
  assert.equal(data.analyses[adId].score, 8);
  assert.equal(data.analyses[adId].summary, 'Historique rassurant');
  assert.equal(data.analyses[adId].manualScore, undefined);
  assert.equal(data.analyses[adId].personalNote, 'Rouille à contrôler.');
});

test('invalid personal edits fail atomically and ChatGPT cannot modify personal fields through the review endpoint', async () => {
  const { data, send } = setup();
  const adId = '1234567890';
  for (const patch of [{ score: 11 }, { score: -1 }, { score: NaN }, { summary: '' }, { summary: 'a'.repeat(181) }, { personalNote: 'a'.repeat(10001) }]) {
    const before = structuredClone(data);
    const result = await send({ type: 'VANCHECK_REVIEW', adId, patch }, 'https://www.leboncoin.fr');
    assert.equal(result.ok, false);
    assert.deepEqual(data, before);
  }
  assert.equal(await send({ type: 'VANCHECK_REVIEW', adId, patch: { score: 1 } }), null);
});

test('legacy unscored analyses can restore their original null score after a manual edit', async () => {
  const { data, send } = setup();
  const adId = '1234567890';
  data.analyses[adId].score = null;
  data.analyses[adId].summary = 'Ancien résumé';
  await send({ type: 'VANCHECK_REVIEW', adId, patch: { score: 0, summary: 'Mon résumé' } }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses[adId].score, 0);
  await send({ type: 'VANCHECK_REVIEW', adId, reset: true }, 'https://www.leboncoin.fr');
  assert.equal(data.analyses[adId].score, null);
  assert.equal(data.analyses[adId].summary, 'Ancien résumé');
});
