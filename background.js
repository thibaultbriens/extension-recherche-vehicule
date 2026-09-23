'use strict';
let writes = Promise.resolve();
// Source images may be larger than the final 6 Mo transfer: the content script
// needs their bytes in order to resize them locally before uploading.
const MAX_SOURCE_FILE_BYTES = 24 * 1024 * 1024;

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
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_FILE_BYTES) throw new Error('Pièce jointe source trop volumineuse (24 Mo maximum).');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SOURCE_FILE_BYTES) { await reader.cancel(); throw new Error('Pièce jointe source trop volumineuse (24 Mo maximum).'); }
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
    analyses[message.adId] = { ...previous, followup: { ...followup, sentIds: [...new Set([...(followup.sentIds || []), ...message.ids])], analysisPending: true } };
  } else if (message.type === 'VANCHECK_ANALYSIS') {
    // An older ChatGPT tab must not overwrite a more recent analysis.
    if ((previous.analysisRequestedAt || 0) > message.requestedAt) return;
    const hasPreviousAiAnalysis = Object.hasOwn(previous, 'aiScore');
    analyses[message.adId] = { ...previous, ...message.metadata, ...message.analysis,
      aiScore: message.analysis.score, aiSummary: message.analysis.summary,
      // A review made before the first ChatGPT analysis starts a local card, but
      // must not mask the first AI result. Later manual corrections stay active.
      score: hasPreviousAiAnalysis ? previous.manualScore ?? message.analysis.score : message.analysis.score,
      summary: hasPreviousAiAnalysis ? previous.manualSummary ?? message.analysis.summary : message.analysis.summary,
      chatUrl: message.chatUrl || previous.chatUrl || chatUrls[message.adId] || null,
      adId: message.adId, savedAt: new Date().toISOString(), analysisRequestedAt: message.requestedAt,
      followup: { ...previous.followup, analysisPending: false } };
    if (!hasPreviousAiAnalysis) {
      delete analyses[message.adId].manualScore;
      delete analyses[message.adId].manualSummary;
    }
    if (message.chatUrl) chatUrls[message.adId] = message.chatUrl;
  } else if (message.type === 'VANCHECK_REVIEW') {
    const existingReview = Boolean(analyses[message.adId]);
    const next = existingReview
      ? { ...previous }
      : { adId: message.adId, ...(message.metadata || {}), savedAt: new Date().toISOString() };
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
        if (existingReview && !Object.hasOwn(next, 'aiScore') && !Object.hasOwn(next, 'manualScore')) next.aiScore = previous.score ?? null;
        next.manualScore = next.score = patch.score;
      }
      if (Object.hasOwn(patch, 'summary')) {
        if (typeof patch.summary !== 'string') throw new Error('Renseigne un résumé en une phrase.');
        const summary = patch.summary.replace(/\s+/g, ' ').trim();
        if (!summary || summary.length > 180) throw new Error('Le résumé doit contenir entre 1 et 180 caractères.');
        if (existingReview && !Object.hasOwn(next, 'aiSummary') && !Object.hasOwn(next, 'manualSummary')) next.aiSummary = previous.summary;
        next.manualSummary = next.summary = summary;
      }
    }
    next.personalUpdatedAt = new Date().toISOString();
    analyses[message.adId] = next;
  } else if (message.type === 'VANCHECK_CONTACT') {
    if (!analyses[message.adId]) return;
    const followup = previous.followup || {};
    // A declined conversation stays quiet even when Leboncoin receives a DOM
    // update for it.  The user can explicitly resume it from the conversation.
    analyses[message.adId] = { ...previous, contactStatus: followup.muted ? 'DISMISSED' : message.status, contactUpdatedAt: new Date().toISOString(),
      ...(typeof message.lastOutboundMessage === 'string' ? { lastOutboundMessage: message.lastOutboundMessage, lastOutboundAt: new Date().toISOString() } : {}),
      followup: { ...followup, conversationId: message.conversationId, lastObservedId: message.lastId } };
  } else if (message.type === 'VANCHECK_DISMISS_ANALYSIS') {
    if (!analyses[message.adId]) return;
    const followup = previous.followup || {};
    analyses[message.adId] = { ...previous, followup: { ...followup,
      dismissedIds: [...new Set([...(followup.dismissedIds || []), ...message.ids])]
    } };
  } else if (message.type === 'VANCHECK_MUTE_CONVERSATION') {
    if (!analyses[message.adId]) return;
    analyses[message.adId] = { ...previous, contactStatus: 'DISMISSED', contactUpdatedAt: new Date().toISOString(),
      followup: { ...previous.followup, muted: true } };
  } else if (message.type === 'VANCHECK_RESUME_CONVERSATION') {
    if (!analyses[message.adId]) return;
    const followup = { ...previous.followup };
    delete followup.muted;
    analyses[message.adId] = { ...previous, contactStatus: message.status, contactUpdatedAt: new Date().toISOString(), followup };
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
      (['VANCHECK_CONTACT', 'VANCHECK_REVIEW', 'VANCHECK_DISMISS_ANALYSIS', 'VANCHECK_MUTE_CONVERSATION', 'VANCHECK_RESUME_CONVERSATION'].includes(message.type) && origin === 'https://www.leboncoin.fr')) {
    work = writes.then(() => update(message));
    writes = work.catch(() => {});
  } else return;
  work.then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message }));
  return true;
});
