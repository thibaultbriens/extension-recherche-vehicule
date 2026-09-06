const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../followup.js');

test('scores: decimal commas, markdown, bounds, old analyses without a score', () => {
  const response = score => `**VERDICT:** A VERIFIER\n${score}\n**RESUME:** Entretien à confirmer.\nANALYSE:\nAvis`;
  assert.equal(F.parseResponse(response('**SCORE:** 7,5 / 10')).score, 7.5);
  assert.equal(F.parseResponse(response('SCORE: 0/10')).score, 0);
  assert.equal(F.parseResponse(response('SCORE: 10')).score, 10);
  assert.equal(F.parseResponse(response('')).score, null);
  for (const score of ['11/10', '-1/10', 'NaN', '7/5', '7 environ']) assert.throws(() => F.parseResponse(response(`SCORE: ${score}`)));
  assert.throws(() => F.parseResponse('VERDICT: INTERESSANT | A VERIFIER\nRESUME: test'));
});

test('only unacknowledged seller replies go to ChatGPT; outbound messages never do', () => {
  const messages = [
    { id: 'a', direction: 'seller', text: 'Ancienne réponse', attachments: [] },
    { id: 'b', direction: 'buyer', text: 'Mon message confidentiel', attachments: [] },
    { id: 'c', direction: 'seller', text: 'Nouvelle réponse', attachments: [] },
    { id: 'd', direction: 'seller', text: '', attachments: [{ name: 'ct.pdf' }] }
  ];
  const pending = F.newSellerMessages(messages, ['a']);
  assert.deepEqual(pending.map(m => m.id), ['c', 'd']);
  const prompt = F.buildFollowupPrompt('1234567890', 'test-ref', pending);
  assert.match(prompt, /Nouvelle réponse/);
  assert.match(prompt, /ct.pdf/);
  assert.doesNotMatch(prompt, /Ancienne réponse|Mon message confidentiel/);
  assert.match(prompt, /SCORE:/);
  assert.match(prompt, /MESSAGE_VENDEUR_DEBUT/);
  assert.equal(F.contactStatus(messages), 'WAITING_ME');
  assert.equal(F.contactStatus([...messages, { direction: 'buyer' }]), 'WAITING_SELLER');
  assert.equal(F.contactStatus([]), null);
  assert.deepEqual(F.newSellerMessages(messages, ['a', 'c', 'd']), []);
});

test('followups require a real ChatGPT conversation and valid Leboncoin conversation path', () => {
  assert.ok(F.chatUrl('https://chatgpt.com/g/g-p-example/c/12345678-1234-1234-1234-123456789012'));
  assert.equal(F.chatUrl('https://chatgpt.com/'), null);
  assert.equal(F.chatUrl('https://chatgpt.com.evil.example/c/12345678-1234-1234-1234-123456789012'), null);
  assert.equal(F.chatUrl('javascript:alert(1)'), null);
  assert.equal(F.conversationId('/messages/id/28a29b32-ade4-4118-9341-9545b6beda66'), '28a29b32-ade4-4118-9341-9545b6beda66');
  assert.equal(F.conversationId('/ad/utilitaires/1234567890'), null);
});

test('shared analysis instructions and followups enforce the minimum usable width after insulation', () => {
  assert.match(F.responseFormat, /au minimum 1,80 m de largeur habitable réellement disponible après isolation et habillage/);
  assert.match(F.responseFormat, /critère obligatoire et éliminatoire/);
  assert.match(F.responseFormat, /confirmée inférieure à 1,80 m, classe l'annonce « A EVITER »/);
  assert.match(F.responseFormat, /dimensions.+ne sont pas connues, classe l'annonce « A VERIFIER »/);
  const prompt = F.buildFollowupPrompt('1234567890', 'ref', []);
  assert.match(prompt, /au minimum 1,80 m de largeur habitable réellement disponible après isolation/);
});
