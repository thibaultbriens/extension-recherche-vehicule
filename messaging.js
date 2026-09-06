(() => {
  'use strict';
  const F = VanCheckFollowup;
  const ROOT = 'vancheck-messaging';
  let busy = false;
  let scheduled;
  let transferring = false;
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const rpc = async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'VanCheck : opération interrompue.');
    return result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function fingerprint(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function attachmentIdentity(url) {
    try { const u = new URL(url); return u.origin.replace('http:', 'https:') + u.pathname; } catch { return url; }
  }

  async function readMessages(region) {
    const messages = [];
    const occurrences = new Map();
    // Only direct message rows: nested lists and system cards are not messages.
    for (const row of region.querySelectorAll(':scope > ol > li')) {
      const bubble = row.querySelector('[data-qa-id="message-bubble"]');
      const images = [...row.querySelectorAll('img[alt="image en pièce jointe"]')];
      const files = [...row.querySelectorAll('a[href]')].filter(a => {
        try { return new URL(a.href).hostname === 'attachments.messaging.bon-coin.net'; } catch { return false; }
      });
      if (!bubble && !images.length && !files.length) continue;
      const content = bubble || images[0] || files[0];
      const alignment = content.closest('.justify-start, .justify-end');
      const direction = alignment?.classList.contains('justify-start') ? 'seller' : alignment?.classList.contains('justify-end') ? 'buyer' : null;
      if (!direction || row.querySelector('[aria-label*="échec" i], [aria-label*="en cours" i]')) continue;
      const attachments = [];
      const identities = new Set();
      for (const element of [...images, ...files]) {
        const url = element.href || element.currentSrc || element.src;
        const identity = attachmentIdentity(url);
        if (identities.has(identity)) continue;
        identities.add(identity);
        attachments.push({ url, identity, name: element.tagName === 'IMG' ? 'Photo du vendeur' : normalize(element.textContent) || 'Document du vendeur', element });
      }
      const text = normalize(bubble?.textContent);
      const hash = await fingerprint(JSON.stringify([direction, text, attachments.map(a => a.identity)]));
      const occurrence = (occurrences.get(hash) || 0) + 1;
      occurrences.set(hash, occurrence);
      messages.push({ id: `${hash}:${occurrence}`, direction, text, attachments });
    }
    return messages;
  }

  function activeAd() {
    const conversationId = F.conversationId(location.href);
    if (!conversationId) return null;
    const region = document.querySelector('[aria-label="Conversation"]');
    const info = [...document.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label').startsWith('Informations à propos de l'));
    const anchor = info?.querySelector('a[href*="/ad/"]');
    const adId = anchor?.href.match(/\/(\d{7,})(?:[/?#]|$)/)?.[1];
    const selected = [...document.querySelectorAll('[aria-label="Liste des conversations"] a[href]')].find(a => F.conversationId(a.href) === conversationId);
    const title = normalize(selected?.querySelector('p')?.textContent);
    // During SPA navigation the old details can remain mounted briefly.
    if (!region || !adId || !title || !normalize(anchor.textContent).startsWith(title)) return null;
    return { adId, conversationId, region, title, url: anchor.href };
  }

  function scoreBadges(analyses) {
    const targets = new Map();
    for (const anchor of document.querySelectorAll('a[href*="/ad/"]')) {
      const id = anchor.href.match(/\/(\d{7,})(?:[/?#]|$)/)?.[1];
      const saved = analyses[id];
      if (saved) targets.set(anchor.closest('article') || anchor.parentElement, saved);
    }
    for (const anchor of document.querySelectorAll('[aria-label="Liste des conversations"] a[href*="/messages/id/"]')) {
      const id = F.conversationId(anchor.href);
      const title = normalize(anchor.querySelector('p')?.textContent);
      const byId = Object.values(analyses).find(a => a.followup?.conversationId === id);
      const byTitle = Object.values(analyses).filter(a => normalize(a.title) === title);
      const saved = byId || (byTitle.length === 1 ? byTitle[0] : null);
      if (saved) targets.set(anchor, saved);
    }
    document.querySelectorAll('[data-vancheck-score]').forEach(badge => {
      if (!targets.has(badge.parentElement)) badge.remove();
    });
    for (const [target, saved] of targets) {
      if (!target) continue;
      let badge = target.querySelector(':scope > [data-vancheck-score]');
      const text = typeof saved.score === 'number' ? `${saved.score.toLocaleString('fr-FR')} / 10` : 'Non notée';
      if (!badge) {
        badge = document.createElement('span');
        badge.dataset.vancheckScore = '';
        badge.style.cssText = 'display:inline-block;margin:6px 8px;padding:3px 8px;border:1px solid #bdc9c1;border-radius:999px;background:#f2f5f0;color:#17352c;font:700 12px/1.4 system-ui;white-space:nowrap';
        target.append(badge);
      }
      if (badge.textContent !== text) badge.textContent = text;
      const title = `${saved.manualScore != null || saved.manualSummary != null ? 'Avis personnel' : 'Avis ChatGPT'} · ${saved.summary || 'Score à demander lors de la prochaine analyse'}`;
      if (badge.title !== title) badge.title = title;
    }
  }

  async function prepareFiles(messages, conversationId) {
    const files = [];
    let total = 0;
    for (const message of messages) for (const attachment of message.attachments) {
      if (F.conversationId(location.href) !== conversationId) throw new Error('La conversation a changé. Réessaie depuis la bonne annonce.');
      // The conversation thumbnail is resized. Open its native preview to use
      // the original URL supplied by Leboncoin, without altering signed tokens.
      if (attachment.element?.tagName === 'IMG') {
        if (document.querySelector('[role="dialog"]')) throw new Error('Ferme l’aperçu ouvert puis réessaie.');
        attachment.element.click();
        let preview;
        try {
          for (let attempt = 0; attempt < 30; attempt++) {
            if (F.conversationId(location.href) !== conversationId) throw new Error('La conversation a changé.');
            preview = [...document.querySelectorAll('[role="dialog"] img')].find(img => attachmentIdentity(img.src) === attachment.identity);
            if (preview) break;
            await pause(100);
          }
          if (!preview) throw new Error('Photo complète inaccessible. Ouvre la pièce jointe puis réessaie.');
          attachment.url = preview.currentSrc || preview.src;
        } finally {
          document.querySelector('[role="dialog"] [data-spark-component="dialog-close-button"][aria-label="Fermer"]')?.click();
          await pause(250);
        }
      }
      const file = await rpc({ type: 'VANCHECK_ATTACHMENT', url: attachment.url });
      total += file.size;
      if (total > 6 * 1024 * 1024) throw new Error('Les pièces dépassent 6 Mo au total. Aucun message marqué comme transmis.');
      const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/webp': 'webp', 'application/pdf': 'pdf' })[file.type];
      attachment.name = `piece-${files.length + 1}.${extension}`;
      files.push({ ...file, name: attachment.name });
    }
    return files;
  }

  async function openFollowup(context, button, status) {
    if (transferring) return;
    transferring = true;
    button.disabled = true;
    // Reserve a tab during the click so async downloads do not trigger popup blocking.
    const destination = window.open('about:blank', '_blank');
    if (destination) destination.opener = null;
    try {
      if (!destination) throw new Error('Autorise l’ouverture du nouvel onglet puis réessaie.');
      const latest = await chrome.storage.local.get(['analyses', 'chatUrls']);
      const saved = latest.analyses?.[context.adId];
      const chat = F.chatUrl(saved?.chatUrl || latest.chatUrls?.[context.adId]);
      if (!chat) throw new Error('Lie d’abord la discussion ChatGPT depuis la fiche de cette annonce.');
      const current = activeAd();
      if (current?.conversationId !== context.conversationId) throw new Error('La conversation a changé.');
      const messages = F.newSellerMessages(await readMessages(current.region), saved?.followup?.sentIds);
      if (!messages.length) throw new Error('Toutes les réponses visibles ont déjà été transmises.');
      status.textContent = 'Préparation des réponses et des pièces jointes…';
      const attachments = await prepareFiles(messages, context.conversationId);
      const token = crypto.randomUUID();
      const reference = `0.4.5 / ${token.slice(0, 8)}`;
      const createdAt = Date.now();
      const all = await chrome.storage.local.get(null);
      const expired = Object.keys(all).filter(k => k.startsWith('transfer:') && createdAt - (all[k].submittedAt || all[k].createdAt) > (all[k].submittedAt ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000));
      if (expired.length) await chrome.storage.local.remove(expired);
      await chrome.storage.local.set({ [`transfer:${token}`]: { adId: context.adId, reference, createdAt,
        text: F.buildFollowupPrompt(context.adId, reference, messages), attachments,
        sellerMessageIds: messages.map(m => m.id), metadata: { title: saved.title || context.title, url: saved.url || context.url } } });
      chat.hash = `vancheck=${token}`;
      destination.location.href = chat.href;
      status.textContent = 'ChatGPT ouvert : préparation et envoi des réponses en cours. Le suivi sera confirmé après l’envoi effectif.';
    } catch (error) {
      destination?.close();
      status.textContent = error.message;
    } finally { transferring = false; button.disabled = false; }
  }

  async function refresh() {
    if (busy || !chrome.runtime?.id) return;
    busy = true;
    try {
      const { analyses = {} } = await chrome.storage.local.get('analyses');
      scoreBadges(analyses);
      const context = activeAd();
      if (!context || !analyses[context.adId]) { document.getElementById(ROOT)?.remove(); return; }
      const saved = analyses[context.adId];
      const messages = await readMessages(context.region);
      if (activeAd()?.conversationId !== context.conversationId) return;
      const last = messages.at(-1);
      const list = context.region.querySelector(':scope > ol');
      const atLatest = list && list.scrollHeight - list.clientHeight - list.scrollTop < 80;
      const status = atLatest ? F.contactStatus(messages) : saved.contactStatus;
      if (atLatest && last && (saved.followup?.lastObservedId !== last.id || saved.followup?.conversationId !== context.conversationId)) {
        await rpc({ type: 'VANCHECK_CONTACT', adId: context.adId, conversationId: context.conversationId, status, lastId: last.id });
      }
      const pending = F.newSellerMessages(messages, saved.followup?.sentIds);
      let host = document.getElementById(ROOT);
      if (host?.dataset.conversationId !== context.conversationId) { host?.remove(); host = null; }
      if (!host) {
        host = document.createElement('div');
        host.id = ROOT;
        host.dataset.conversationId = context.conversationId;
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>:host{all:initial}section{position:fixed;bottom:22px;right:22px;z-index:2147483647;max-width:320px;padding:16px;border:1px solid #bdc9c1;border-radius:16px;background:#fffdf7;color:#17352c;box-shadow:0 12px 32px #17352c26;font:13px/1.45 system-ui}strong{display:block}button{margin-top:10px;padding:10px 14px;border:0;border-radius:10px;background:#17352c;color:white;font:700 13px system-ui;cursor:pointer}button:disabled{opacity:.5}p{margin:8px 0 0;font-size:12px}</style><section><strong></strong><button type="button">Analyser la réponse</button><p role="status" aria-live="polite"></p></section>`;
        shadow.querySelector('button').addEventListener('click', event => { openFollowup(context, event.currentTarget, shadow.querySelector('p')); });
        document.documentElement.append(host);
      }
      const label = status === 'WAITING_SELLER' ? 'En attente de réponse' : 'Le vendeur a répondu';
      const title = `${label}${pending.length ? ` · ${pending.length} élément${pending.length > 1 ? 's' : ''} à analyser` : ''}`;
      const strong = host.shadowRoot.querySelector('strong');
      if (strong.textContent !== title) strong.textContent = title;
      const button = host.shadowRoot.querySelector('button');
      button.hidden = !pending.length;
      if (!transferring) button.disabled = false;
    } catch (error) { console.warn('VanCheck : suivi indisponible.', error.message); }
    finally { busy = false; }
  }
  if (typeof module !== 'undefined') { module.exports = { readMessages, activeAd, scoreBadges, prepareFiles }; return; }
  function schedule() { clearTimeout(scheduled); scheduled = setTimeout(refresh, 450); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  chrome.storage.onChanged.addListener(changes => { if (changes.analyses || changes.chatUrls) schedule(); });
  // SPA changes without a DOM mutation, and extension reload cleanup.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); clearTimeout(scheduled); observer.disconnect(); document.getElementById(ROOT)?.remove(); return; }
    refresh();
  }, 3000);
  refresh();
})();
