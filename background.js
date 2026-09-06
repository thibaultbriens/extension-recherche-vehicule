'use strict';
let writes = Promise.resolve();
const MAX_FILE_BYTES = 6 * 1024 * 1024;

async function attachment(urlString) {
  const url = new URL(urlString);
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'attachments.messaging.bon-coin.net' || url.username || url.password || url.port) {
    throw new Error('Cette pièce jointe ne provient pas du serveur de fichiers Leboncoin.');
  }
  url.protocol = 'https:';
  const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Pièce jointe inaccessible. Recharge la conversation puis réessaie.');
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!/^(image\/(jpeg|png|bmp|tiff|webp)|application\/pdf)$/.test(type || '')) throw new Error('Format de pièce jointe non pris en charge.');
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw new Error('Pièce jointe trop volumineuse (6 Mo maximum).');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('Pièce jointe trop volumineuse (6 Mo maximum).'); }
    chunks.push(value);
  }
  let binary = '';
  for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
  return { base64: btoa(binary), type, size };
}

async function update(message) {
  const { analyses = {}, chatUrls = {} } = await chrome.storage.local.get(['analyses', 'chatUrls']);
  const previous = analyses[message.adId] || {};
  if (message.type === 'VANCHECK_ACK') {
    if (!analyses[message.adId]) throw new Error('Analyse supprimée ; transfert non associé.');
    const followup = previous.followup || {};
    analyses[message.adId] = { ...previous, followup: { ...followup, sentIds: [...new Set([...(followup.sentIds || []), ...message.ids])] } };
  } else if (message.type === 'VANCHECK_ANALYSIS') {
    // An older ChatGPT tab must not overwrite a more recent analysis.
    if ((previous.analysisRequestedAt || 0) > message.requestedAt) return;
    analyses[message.adId] = { ...previous, ...message.metadata, ...message.analysis,
      aiScore: message.analysis.score, aiSummary: message.analysis.summary,
      score: previous.manualScore ?? message.analysis.score,
      summary: previous.manualSummary ?? message.analysis.summary,
      chatUrl: message.chatUrl || previous.chatUrl || chatUrls[message.adId] || null,
      adId: message.adId, savedAt: new Date().toISOString(), analysisRequestedAt: message.requestedAt };
    if (message.chatUrl) chatUrls[message.adId] = message.chatUrl;
  } else if (message.type === 'VANCHECK_REVIEW') {
    if (!analyses[message.adId]) throw new Error('Enregistre d’abord une analyse pour cette annonce.');
    const next = { ...previous };
    if (message.reset) {
      next.score = Object.hasOwn(previous, 'aiScore') ? previous.aiScore : previous.score ?? null;
      next.summary = previous.aiSummary ?? previous.summary;
      delete next.manualScore;
      delete next.manualSummary;
    } else {
      const patch = message.patch || {};
      if (Object.hasOwn(patch, 'personalNote')) {
        if (typeof patch.personalNote !== 'string' || patch.personalNote.length > 10000) throw new Error('La note personnelle est limitée à 10 000 caractères.');
        next.personalNote = patch.personalNote;
      }
      if (Object.hasOwn(patch, 'score')) {
        if (typeof patch.score !== 'number' || !Number.isFinite(patch.score) || patch.score < 0 || patch.score > 10) throw new Error('Le score doit être compris entre 0 et 10.');
        if (!Object.hasOwn(next, 'aiScore')) next.aiScore = previous.score ?? null;
        next.manualScore = next.score = patch.score;
      }
      if (Object.hasOwn(patch, 'summary')) {
        if (typeof patch.summary !== 'string') throw new Error('Renseigne un résumé en une phrase.');
        const summary = patch.summary.replace(/\s+/g, ' ').trim();
        if (!summary || summary.length > 180) throw new Error('Le résumé doit contenir entre 1 et 180 caractères.');
        if (!Object.hasOwn(next, 'aiSummary')) next.aiSummary = previous.summary;
        next.manualSummary = next.summary = summary;
      }
    }
    next.personalUpdatedAt = new Date().toISOString();
    analyses[message.adId] = next;
  } else if (message.type === 'VANCHECK_CONTACT') {
    if (!analyses[message.adId]) return;
    analyses[message.adId] = { ...previous, contactStatus: message.status, contactUpdatedAt: new Date().toISOString(),
      followup: { ...previous.followup, conversationId: message.conversationId, lastObservedId: message.lastId } };
  }
  await chrome.storage.local.set({ analyses, chatUrls });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  const origin = new URL(sender.url).origin;
  if (!/^\d{7,}$/.test(message.adId || '') && message.type !== 'VANCHECK_ATTACHMENT') return;
  let work;
  if (message.type === 'VANCHECK_ATTACHMENT' && origin === 'https://www.leboncoin.fr') work = attachment(message.url);
  else if ((['VANCHECK_ACK', 'VANCHECK_ANALYSIS'].includes(message.type) && origin === 'https://chatgpt.com') ||
      (['VANCHECK_CONTACT', 'VANCHECK_REVIEW'].includes(message.type) && origin === 'https://www.leboncoin.fr')) {
    work = writes.then(() => update(message));
    writes = work.catch(() => {});
  } else return;
  work.then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message }));
  return true;
});
