const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const token = '12345678-1234-1234-1234-123456789012';
const chatUrl = 'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';
const key = `transfer:${token}`;
const text = 'Référence VanCheck : unique-test\nNouvelle réponse vendeur. Pièce : ct.pdf';
const done = 'VERDICT: A VERIFIER\nSCORE: 7,5/10\nRESUME: Factures à confirmer.\nANALYSE:\nAvis.\nVANCHECK_ANALYSE_FIN';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function setup({ transfer = {}, body = '', draft = text, onSend, rich = false, onPause, onUpload, initialUrl = chatUrl } = {}) {
  const dom = new JSDOM(`<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" disabled>Envoyer</button></form>${body}`, { url: `${initialUrl}#vancheck=${token}`, runScripts: 'outside-only' });
  const w = dom.window;
  const data = { [key]: { text, adId: '1234567890', createdAt: Date.now(), metadata: { title: 'Fourgon test' }, ...transfer } };
  const calls = [];
  const intervals = new Map();
  let nextTimer = 0;
  w.setInterval = fn => { intervals.set(++nextTimer, fn); return nextTimer; };
  w.clearInterval = id => intervals.delete(id);
  // Resolve short UI stabilization delays immediately; never run the 60-second fallback loop in tests.
  w.setTimeout = (fn, ms) => { if (ms < 2000) queueMicrotask(() => { onPause?.(w, ms); fn(); }); return 1; };
  w.URL.createObjectURL = () => 'blob:test-download';
  w.URL.revokeObjectURL = () => {};
  w.DataTransfer = class {
    files = [];
    items = { add: file => this.files.push(file) };
  };
  if (onUpload) {
    const input = w.document.createElement('input');
    input.type = 'file'; input.id = 'upload-files';
    Object.defineProperty(input, 'files', { value: [], writable: true });
    input.addEventListener('change', () => onUpload(w, input.files));
    w.document.body.append(input);
  }
  w.chrome = { runtime: { id: 'test', sendMessage: async message => { calls.push(structuredClone(message)); return { ok: true }; } }, storage: { local: {
    get: async keys => keys === null ? structuredClone(data) : typeof keys === 'string' ? { [keys]: structuredClone(data[keys]) } : Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])),
    set: async patch => Object.assign(data, structuredClone(patch)), remove: async k => { delete data[k]; }
  } } };
  const editor = w.document.querySelector('textarea');
  editor.value = draft;
  let composer = editor;
  if (rich) {
    composer = w.document.createElement('div');
    composer.id = 'prompt-textarea';
    composer.setAttribute('contenteditable', 'true');
    draft.split('\n').forEach(line => { const p = w.document.createElement('p'); p.textContent = line; composer.append(p); });
    // Browsers render paragraph breaks in innerText but not in textContent.
    Object.defineProperty(composer, 'innerText', { get: () => [...composer.children].map(p => p.textContent).join('\n') });
    editor.replaceWith(composer);
  }
  composer.getClientRects = () => [{}];
  if (onSend) {
    w.document.querySelector('button').disabled = false;
    w.document.querySelector('button').addEventListener('click', event => { event.preventDefault(); onSend(); });
  }
  w.eval(fs.readFileSync(require.resolve('../followup.js'), 'utf8'));
  w.eval(fs.readFileSync(require.resolve('../chatgpt.js'), 'utf8'));
  await flush();
  return { w, data, calls, dom, tick: async () => { for (const fn of [...intervals.values()]) await fn(); await flush(); } };
}
function addUser(w, attachment = '') {
  const article = w.document.createElement('article');
  const user = w.document.createElement('div');
  user.dataset.messageAuthorRole = 'user';
  user.textContent = text;
  article.append(user);
  if (attachment) article.insertAdjacentHTML('beforeend', attachment);
  w.document.body.append(article);
}
function addAnswer(w, response = done) {
  const answer = w.document.createElement('div');
  answer.dataset.messageAuthorRole = 'assistant';
  answer.textContent = response;
  w.document.body.append(answer);
  return answer;
}
test('a draft alone never acknowledges seller replies or invents a score', async () => {
  const app = await setup({ transfer: { sellerMessageIds: ['seller-1'] } });
  await app.tick();
  assert.equal(app.calls.length, 0);
  assert.ok(app.data[key]);
  app.dom.window.close();
});
test('attachment names mentioned in the prompt are not evidence of an uploaded attachment', async () => {
  const app = await setup({ draft: 'Un autre brouillon', transfer: { sellerMessageIds: ['seller-1'], attachmentsInserted: true, attachments: [{ name: 'ct.pdf', type: 'application/pdf', base64: '' }] } });
  addUser(app.w);
  await app.tick();
  assert.equal(app.calls.length, 0);
  app.w.document.querySelector('article').insertAdjacentHTML('beforeend', '<span title="ct.pdf">Document joint</span>');
  await app.tick();
  assert.equal(app.calls.filter(m => m.type === 'VANCHECK_ACK').length, 1);
  await app.tick();
  assert.equal(app.calls.filter(m => m.type === 'VANCHECK_ACK').length, 1, 'acknowledgment is idempotent');
  app.dom.window.close();
});
test('only the completed answer after the exact transferred prompt updates the score', async () => {
  const app = await setup({ transfer: { submittedAt: Date.now(), chatUrl } });
  addAnswer(app.w, done.replace('7,5', '2'));
  await app.tick();
  assert.equal(app.calls.length, 0, 'old replies ignored');
  addUser(app.w);
  const answer = addAnswer(app.w, done.replace('VANCHECK_ANALYSE_FIN', ''));
  await app.tick(); await app.tick(); await app.tick();
  assert.equal(app.calls.length, 0, 'partial response ignored');
  answer.textContent = done;
  await app.tick(); await app.tick(); await app.tick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].type, 'VANCHECK_ANALYSIS');
  assert.equal(app.calls[0].analysis.score, 7.5);
  assert.equal(app.calls[0].adId, '1234567890');
  assert.equal(app.data[key], undefined, 'temporary transfer cleaned up');
  app.dom.window.close();
});
test('unrelated existing drafts are preserved', async () => {
  let sent = 0;
  const app = await setup({ draft: 'Mon brouillon personnel', onSend: () => sent++ });
  assert.equal(sent, 0);
  assert.equal(app.w.document.querySelector('textarea').value, 'Mon brouillon personnel');
  assert.match(app.w.document.documentElement.textContent, /n’a pas remplacé ce brouillon/);
  app.dom.window.close();
});

test('both workflows submit their verified prompt automatically once', async () => {
  let sent = 0;
  const followup = await setup({ transfer: { sellerMessageIds: ['seller-1'] }, onSend: () => sent++ });
  assert.equal(sent, 1);
  await followup.tick();
  assert.equal(followup.calls.length, 0, 'a click alone is not an acknowledgment');
  followup.dom.window.close();
  const initial = await setup({ onSend: () => sent++ });
  assert.equal(sent, 2, 'initial analysis uses the same automatic-send path');
  await initial.tick();
  assert.equal(sent, 2, 'the first prompt is sent once');
  initial.dom.window.close();
});

test('missing attachment blocks automatic submission even with an enabled send button', async () => {
  let sent = 0;
  const app = await setup({ transfer: { sellerMessageIds: ['seller-1'], attachmentsInserted: true, attachments: [{ name: 'ct.pdf', type: 'application/pdf', base64: '' }] }, onSend: () => sent++ });
  assert.equal(sent, 0);
  assert.match(app.w.document.documentElement.textContent, /envoi automatique non confirmé/);
  app.dom.window.close();
});

test('regression: rich-editor paragraph concatenation cannot masquerade as an uploaded file', async () => {
  let sent = 0;
  const app = await setup({ rich: true, transfer: { sellerMessageIds: ['seller-1'], attachmentsInserted: true, attachments: [{ name: 'ct.pdf', type: 'application/pdf', base64: '' }] }, onUpload: () => {}, onSend: () => sent++ });
  assert.equal(sent, 0, 'the filename inside the ProseMirror prompt is not an attachment');
  app.dom.window.close();
});


test('delayed multi-file upload: wait for every file and the end of async loading before sending once', async () => {
  let sent = 0;
  let uploaded = false;
  let elapsed = 0;
  let completed = false;
  const attachments = [
    { name: 'ct.pdf', type: 'application/pdf', base64: 'AQID' },
    { name: 'piece-1.jpg', type: 'image/jpeg', base64: 'AQID' }
  ];
  const app = await setup({ rich: true, transfer: { sellerMessageIds: ['seller-1'], attachments },
    onUpload: (w, files) => {
      assert.deepEqual(files.map(f => f.name), ['ct.pdf', 'piece-1.jpg']);
      assert.deepEqual(files.map(f => f.size), [3, 3]);
      uploaded = true;
    },
    onPause: w => {
      if (!uploaded) return;
      elapsed++;
      const form = w.document.querySelector('form');
      if (elapsed === 2) form.insertAdjacentHTML('afterbegin', '<span title="ct.pdf">ct.pdf</span>');
      if (elapsed === 5) form.insertAdjacentHTML('afterbegin', '<span title="piece-1.jpg">piece-1.jpg</span><span aria-busy="true" id="upload-progress"></span>');
      if (elapsed === 9) { w.document.querySelector('#upload-progress').remove(); completed = true; }
    },
    onSend: () => { assert.ok(completed, 'send must wait for actual files AND the async upload state'); sent++; }
  });
  assert.ok(uploaded);
  assert.equal(sent, 1);
  assert.ok(elapsed >= 13, 'all ready checks must remain stable after upload completes');
  app.dom.window.close();
});

test('an existing same-name attachment cannot prove that the new file was uploaded', async () => {
  let sent = 0;
  const app = await setup({ rich: true, transfer: { sellerMessageIds: ['seller-1'], attachments: [{ name: 'ct.pdf', type: 'application/pdf', base64: 'AQID' }] },
    onPause: w => {
      if (!w.document.querySelector('#old-file')) w.document.querySelector('form').insertAdjacentHTML('afterbegin', '<span title="ct.pdf" id="old-file">ct.pdf</span>');
    },
    onUpload: () => {}, onSend: () => sent++
  });
  assert.equal(sent, 0);
  app.dom.window.close();
});

test('a generic image preview and a filename in the prompt cannot satisfy the upload gate', async () => {
  let sent = 0;
  const app = await setup({ rich: true, transfer: { sellerMessageIds: ['seller-1'], attachments: [{ name: 'piece-1.jpg', type: 'image/jpeg', base64: 'AQID' }] },
    onUpload: w => {
      w.document.querySelector('form').insertAdjacentHTML('afterbegin', '<img alt="Uploaded image" src="blob:other-image">');
      const img = w.document.querySelector('form img');
      Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 640 } });
    },
    onSend: () => sent++
  });
  assert.equal(sent, 0);
  app.dom.window.close();
});

test('file upload errors never submit or acknowledge seller replies', async () => {
  let sent = 0;
  const app = await setup({ transfer: { sellerMessageIds: ['seller-1'], attachments: [{ name: 'ct.pdf', type: 'application/pdf', base64: 'AQID' }] },
    onUpload: w => w.document.querySelector('form').insertAdjacentHTML('afterbegin', '<span title="ct.pdf">ct.pdf</span><span role="alert">Upload failed</span>'),
    onSend: () => sent++
  });
  assert.equal(sent, 0);
  await app.tick();
  assert.equal(app.calls.length, 0);
  app.dom.window.close();
});


test('image-only previews: all new removable tiles must finish loading, even without filenames', async () => {
  let sent = 0;
  let uploaded = false;
  let elapsed = 0;
  let secondImage;
  const appendImage = (w, src) => {
    const tile = w.document.createElement('div');
    tile.innerHTML = `<img alt="Uploaded image" src="${src}"><button aria-label="Remove image"></button>`;
    const img = tile.querySelector('img');
    Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 640, configurable: true } });
    w.document.querySelector('form').prepend(tile);
    return img;
  };
  const app = await setup({ rich: true, transfer: { sellerMessageIds: ['photo-1', 'photo-2'], attachments: [
    { name: 'piece-1.jpg', type: 'image/jpeg', base64: 'AQID' },
    { name: 'piece-2.jpg', type: 'image/jpeg', base64: 'AQID' }
  ] },
    onUpload: () => { uploaded = true; },
    onPause: w => {
      if (!uploaded) return;
      elapsed++;
      if (elapsed === 1) appendImage(w, 'blob:first');
      if (elapsed === 7) {
        secondImage = appendImage(w, 'blob:second');
        Object.defineProperties(secondImage, { complete: { value: false, configurable: true }, naturalWidth: { value: 0, configurable: true } });
      }
      if (elapsed === 10) {
        Object.defineProperties(secondImage, { complete: { value: true }, naturalWidth: { value: 640 } });
      }
    },
    onSend: () => { assert.ok(elapsed >= 14, 'never send on the first thumbnail or before the second image is loaded'); sent++; }
  });
  assert.equal(sent, 1);
  app.dom.window.close();
});


test('initial analysis: capture the first answer after ChatGPT creates a new conversation', async () => {
  const metadata = { title: 'Nouvelle annonce', price: '8000 EUR', url: 'https://www.leboncoin.fr/ad/utilitaires/1234567890' };
  let sent = 0;
  const app = await setup({ initialUrl: 'https://chatgpt.com/g/g-p-example/project', transfer: { metadata }, onSend: () => sent++ });
  assert.equal(sent, 1);
  assert.match(app.w.document.documentElement.textContent, /envoi demandé/);
  addUser(app.w);
  await app.tick();
  assert.equal(app.calls.length, 0, 'wait for the new conversation URL');
  app.w.history.replaceState(null, '', chatUrl);
  addAnswer(app.w, done.replace('Avis.', 'Avis.\nMESSAGE_VENDEUR_DEBUT\nBonjour, avez-vous les factures ?\nMESSAGE_VENDEUR_FIN'));
  await app.tick(); await app.tick(); await app.tick();
  assert.equal(app.calls.length, 1, 'a first analysis has no seller-message acknowledgment');
  const result = app.calls[0];
  assert.equal(result.type, 'VANCHECK_ANALYSIS');
  assert.equal(result.adId, '1234567890');
  assert.equal(result.chatUrl, chatUrl);
  assert.deepEqual(result.metadata, metadata);
  assert.equal(result.analysis.score, 7.5);
  assert.match(result.analysis.fullAnalysis, /Bonjour, avez-vous les factures/);
  assert.equal(app.data[key], undefined);
  app.dom.window.close();
});
