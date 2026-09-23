(() => {
  'use strict';
  const F = VanCheckFollowup;
  const ROOT = 'vancheck-messaging';
  const MAX_TRANSFER_BYTES = 6 * 1024 * 1024;
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

  function proposedSellerMessage(saved, pending = []) {
    if (!saved || saved.contactStatus !== 'WAITING_ME' || pending.length || saved.followup?.analysisPending) return '';
    const message = VanCheckFormatting.message(saved.fullAnalysis || '').trim();
    return message && message !== saved.lastOutboundMessage ? message : '';
  }

  function pendingSellerMessages(messages, saved) {
    const ignored = new Set([...(saved?.followup?.sentIds || []), ...(saved?.followup?.dismissedIds || [])]);
    return messages.filter(message => message.direction === 'seller' && !ignored.has(message.id));
  }

  function linkedChatUrl(saved, chatUrls = {}) {
    return F.chatUrl(saved?.chatUrl || chatUrls?.[saved?.adId])?.href || '';
  }

  function visible(element) {
    return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }

  function replaceComposerValue(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('Le champ de message n’est pas modifiable. Aucun message envoyé.');
      setter.call(composer, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  async function sendProposedMessage(context, text, button, status) {
    if (!text || activeAd()?.conversationId !== context.conversationId) throw new Error('La conversation a changé. Aucun message envoyé.');
    button.disabled = true;
    try {
      const composer = [...context.region.querySelectorAll('textarea, [contenteditable="true"]')].find(visible)
        || [...document.querySelectorAll('textarea, [contenteditable="true"]')].find(element => visible(element) && /message/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''}`));
      if (!composer) throw new Error('Champ de message introuvable. Aucun message envoyé.');
      replaceComposerValue(composer, text);
      status.textContent = 'Préparation du message…';
      for (let attempt = 0; attempt < 25; attempt++) {
        if (activeAd()?.conversationId !== context.conversationId) throw new Error('La conversation a changé. Aucun message envoyé.');
        const current = normalize(composer.value ?? composer.innerText ?? composer.textContent);
        const send = [...(composer.closest('form')?.querySelectorAll('button') || []), ...document.querySelectorAll('button')]
          .find(element => visible(element) && /^envoyer(?: (?:mon|le) message)?$/i.test(normalize(element.textContent)));
        if (current === normalize(text) && send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') {
          const messages = await readMessages(context.region);
          await rpc({ type: 'VANCHECK_CONTACT', adId: context.adId, conversationId: context.conversationId,
            status: 'WAITING_SELLER', lastId: messages.at(-1)?.id, lastOutboundMessage: text });
          send.click();
          status.textContent = 'Message envoyé. En attente de la réponse du vendeur.';
          return;
        }
        await pause(200);
      }
      throw new Error('Le bouton d’envoi n’est pas devenu disponible. Aucun message envoyé.');
    } finally { button.disabled = false; }
  }

  async function fingerprint(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function attachmentIdentity(url) {
    try { const u = new URL(url); return u.origin.replace('http:', 'https:') + u.pathname; } catch { return url; }
  }

  function galleryImageAttachments(dialog) {
    const slides = [...dialog.querySelectorAll('[data-index]:not(.slick-cloned) img[src]')];
    const candidates = slides.length ? slides : [...dialog.querySelectorAll('img[src]')];
    const ordered = candidates.sort((left, right) => {
      const leftIndex = Number(left.closest('[data-index]')?.dataset.index);
      const rightIndex = Number(right.closest('[data-index]')?.dataset.index);
      return (Number.isFinite(leftIndex) ? leftIndex : 0) - (Number.isFinite(rightIndex) ? rightIndex : 0);
    });
    const identities = new Set();
    return ordered.flatMap(element => {
      const url = element.currentSrc || element.src;
      try { if (new URL(url).hostname !== 'attachments.messaging.bon-coin.net') return []; } catch { return []; }
      const identity = attachmentIdentity(url);
      if (identities.has(identity)) return [];
      identities.add(identity);
      return [{ url, identity, name: 'Photo du vendeur' }];
    });
  }

  function base64Blob(file) {
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: file.type });
  }

  async function compressImage(file, targetBytes) {
    const bitmap = await createImageBitmap(base64Blob(file));
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Compression des photos indisponible dans ce navigateur.');
      let scale = Math.min(1, Math.sqrt(targetBytes / file.size));
      let best;
      for (let attempt = 0; attempt < 8; attempt++) {
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const quality = Math.max(0.48, 0.86 - attempt * 0.06);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) throw new Error('Impossible de compresser une photo.');
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= targetBytes) break;
        scale *= Math.max(0.62, Math.sqrt(targetBytes / blob.size) * 0.94);
      }
      if (!best || best.size >= file.size) return file;
      const bytes = new Uint8Array(await best.arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      return { ...file, type: 'image/jpeg', size: best.size, base64: btoa(binary), name: file.name.replace(/\.[^.]+$/, '.jpg') };
    } finally { bitmap.close(); }
  }

  async function optimizeFiles(files, limit = MAX_TRANSFER_BYTES, compressor = compressImage) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= limit) return files;
    const images = files.filter(file => /^image\//.test(file.type));
    const fixedBytes = total - images.reduce((sum, file) => sum + file.size, 0);
    if (!images.length || fixedBytes >= limit) throw new Error('Les pièces dépassent 6 Mo au total et ne contiennent aucune photo compressible. Aucun message marqué comme transmis.');
    const imageBudget = Math.floor((limit - fixedBytes) * 0.96);
    const imageTotal = images.reduce((sum, file) => sum + file.size, 0);
    const optimized = [];
    for (const file of files) {
      if (!/^image\//.test(file.type)) { optimized.push(file); continue; }
      const target = Math.max(48 * 1024, Math.floor(imageBudget * file.size / imageTotal));
      const compressed = await compressor(file, target);
      if (file.attachment) file.attachment.name = compressed.name;
      optimized.push({ ...compressed, attachment: file.attachment });
    }
    if (optimized.reduce((sum, file) => sum + file.size, 0) > limit) {
      throw new Error('Les photos restent trop volumineuses après compression (6 Mo maximum). Aucun message marqué comme transmis.');
    }
    return optimized;
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
      const overflow = [...row.querySelectorAll('*')].map(element => normalize(element.textContent)).find(text => /^\+\s*\d+$/.test(text));
      const overflowCount = Number(overflow?.match(/\d+/)?.[0] || 0);
      const expectedImageCount = overflowCount ? Math.max(images.length, images.length - 1 + overflowCount) : images.length;
      const text = normalize(bubble?.textContent);
      const hash = await fingerprint(JSON.stringify([direction, text, attachments.map(a => a.identity)]));
      const occurrence = (occurrences.get(hash) || 0) + 1;
      occurrences.set(hash, occurrence);
      messages.push({ id: `${hash}:${occurrence}`, direction, text, attachments, expectedImageCount });
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
    document.querySelectorAll('[data-vancheck-score], [data-vancheck-analysis]').forEach(badge => {
      const owner = badge.closest('a[href*="/messages/id/"]') || badge.parentElement;
      if (!targets.has(owner)) badge.remove();
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
    for (const anchor of document.querySelectorAll('[aria-label="Liste des conversations"] a[href*="/messages/id/"]')) {
      const id = F.conversationId(anchor.href);
      const title = normalize(anchor.querySelector('p')?.textContent);
      const byId = Object.values(analyses).find(a => a.followup?.conversationId === id);
      const byTitle = Object.values(analyses).filter(a => normalize(a.title) === title);
      const saved = byId || (byTitle.length === 1 ? byTitle[0] : null);
      const lastId = saved?.followup?.lastObservedId;
      const dismissed = new Set(saved?.followup?.dismissedIds || []);
      // This marker tracks a reply that is still owed, not the progress of the
      // analysis. Sending the response to ChatGPT must not remove it.
      const needsReply = !saved?.followup?.muted && saved?.contactStatus === 'WAITING_ME' && lastId && !dismissed.has(lastId);
      let badge = anchor.querySelector('[data-vancheck-analysis]');
      if (!needsReply) { badge?.remove(); continue; }
      const titleElement = anchor.querySelector('p') || anchor;
      if (!badge) {
        badge = document.createElement('span');
        badge.dataset.vancheckAnalysis = '';
        badge.setAttribute('role', 'img');
        badge.style.cssText = 'display:inline-block;width:7px;height:7px;margin:0 6px 1px 1px;border-radius:50%;background:#f15a24;box-shadow:0 0 0 2px #fff;vertical-align:middle';
      }
      // Leboncoin ellipsizes long titles; keeping the marker first prevents it
      // from being clipped after an otherwise invisible title suffix.
      titleElement.prepend(badge);
      badge.setAttribute('aria-label', 'Réponse à envoyer au vendeur');
      badge.title = 'Réponse à envoyer au vendeur';
    }
  }

  async function prepareFiles(messages, conversationId) {
    const files = [];
    let total = 0;
    for (const message of messages) {
      let attachments = message.attachments;
      const image = attachments.find(attachment => attachment.element?.tagName === 'IMG');
      if (image) {
        if (document.querySelector('[role="dialog"]')) throw new Error('Ferme l’aperçu ouvert puis réessaie.');
        image.element.click();
        let gallery = [];
        try {
          for (let attempt = 0; attempt < 30; attempt++) {
            if (F.conversationId(location.href) !== conversationId) throw new Error('La conversation a changé.');
            const dialog = document.querySelector('[role="dialog"]');
            gallery = dialog ? galleryImageAttachments(dialog) : [];
            if (gallery.length >= (message.expectedImageCount || 1)) break;
            await pause(100);
          }
          if (gallery.length < (message.expectedImageCount || 1)) {
            throw new Error('Toutes les photos de la pièce jointe ne sont pas accessibles. Ouvre la galerie puis réessaie.');
          }
          attachments = [...attachments.filter(attachment => attachment.element?.tagName !== 'IMG'), ...gallery];
        } finally {
          document.querySelector('[role="dialog"] [data-spark-component="dialog-close-button"][aria-label="Fermer"], [role="dialog"] button[aria-label="Fermer"]')?.click();
          await pause(250);
        }
      }
      message.attachments = attachments;
      for (const attachment of attachments) {
        if (F.conversationId(location.href) !== conversationId) throw new Error('La conversation a changé. Réessaie depuis la bonne annonce.');
        const file = await rpc({ type: 'VANCHECK_ATTACHMENT', url: attachment.url });
        total += file.size;
        const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/webp': 'webp', 'application/pdf': 'pdf' })[file.type];
        attachment.name = `piece-${files.length + 1}.${extension}`;
        files.push({ ...file, name: attachment.name, attachment });
      }
    }
    const optimized = await optimizeFiles(files);
    return optimized.map(({ attachment, ...file }) => file);
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
      const { analyses = {}, chatUrls = {} } = await chrome.storage.local.get(['analyses', 'chatUrls']);
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
      const pending = pendingSellerMessages(messages, saved);
      let host = document.getElementById(ROOT);
      if (host?.dataset.conversationId !== context.conversationId) { host?.remove(); host = null; }
      if (!host) {
        host = document.createElement('div');
        host.id = ROOT;
        host.dataset.conversationId = context.conversationId;
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>:host{all:initial}section{position:fixed;bottom:22px;right:22px;z-index:2147483647;max-width:320px;padding:16px;border:1px solid #bdc9c1;border-radius:16px;background:#fffdf7;color:#17352c;box-shadow:0 12px 32px #17352c26;font:13px/1.45 system-ui}strong{display:block}button,.chat-link{margin-top:10px;padding:10px 14px;border:0;border-radius:10px;background:#17352c;color:white;font:700 13px system-ui;cursor:pointer}.chat-link{display:block;box-sizing:border-box;background:#e8f1eb;color:#17352c;text-align:center;text-decoration:none;box-shadow:inset 0 0 0 1px #8eaa98}.chat-link:hover{background:#dcebe1}button.send{background:#246b4b}button.dismiss,button.mute{margin-left:8px;background:transparent;color:#40574f;border:1px solid #bdc9c1}button.mute{color:#8c3d24;border-color:#e1b4a4}button.resume{background:#e8f1eb;color:#17352c;box-shadow:inset 0 0 0 1px #8eaa98}button:disabled{opacity:.5}p{margin:8px 0 0;font-size:12px}.proposal{padding:9px 10px;border-left:3px solid #246b4b;border-radius:4px;background:#f2f5f0;color:#40574f;white-space:pre-wrap}</style><section><strong></strong><a class="chat-link" target="_blank" rel="noopener noreferrer" hidden>Ouvrir le chat ChatGPT ↗</a><p class="proposal" hidden></p><button class="analyze" type="button">Analyser la réponse</button><button class="dismiss" type="button">Retirer le rappel</button><button class="mute" type="button">Ne plus suivre</button><button class="resume" type="button" hidden>Reprendre le suivi</button><button class="send" type="button" hidden>Envoyer le message proposé</button><p class="status" role="status" aria-live="polite"></p></section>`;
        shadow.querySelector('.analyze').addEventListener('click', event => { openFollowup(context, event.currentTarget, shadow.querySelector('.status')); });
        shadow.querySelector('.dismiss').addEventListener('click', async event => {
          const currentMessages = await readMessages(context.region);
          const latest = (await chrome.storage.local.get('analyses')).analyses?.[context.adId];
          const ids = pendingSellerMessages(currentMessages, latest).map(message => message.id);
          if (!ids.length) return;
          event.currentTarget.disabled = true;
          try {
            await rpc({ type: 'VANCHECK_DISMISS_ANALYSIS', adId: context.adId, ids });
            shadow.querySelector('.status').textContent = 'Rappel retiré pour cette réponse.';
          } catch (error) { shadow.querySelector('.status').textContent = error.message; }
          finally { event.currentTarget.disabled = false; }
        });
        shadow.querySelector('.mute').addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          try {
            await rpc({ type: 'VANCHECK_MUTE_CONVERSATION', adId: context.adId });
            shadow.querySelector('.status').textContent = 'Suivi arrêté : le point orange ne réapparaîtra plus.';
          } catch (error) { shadow.querySelector('.status').textContent = error.message; }
          finally { event.currentTarget.disabled = false; }
        });
        shadow.querySelector('.resume').addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          try {
            const currentMessages = await readMessages(context.region);
            await rpc({ type: 'VANCHECK_RESUME_CONVERSATION', adId: context.adId,
              status: F.contactStatus(currentMessages) });
            shadow.querySelector('.status').textContent = 'Suivi repris.';
          } catch (error) { shadow.querySelector('.status').textContent = error.message; }
          finally { event.currentTarget.disabled = false; }
        });
        shadow.querySelector('.send').addEventListener('click', async event => {
          const button = event.currentTarget;
          const latest = (await chrome.storage.local.get('analyses')).analyses?.[context.adId];
          const currentMessages = await readMessages(context.region);
          const text = proposedSellerMessage(latest, F.newSellerMessages(currentMessages, latest?.followup?.sentIds));
          try { await sendProposedMessage(context, text, button, shadow.querySelector('.status')); }
          catch (error) { shadow.querySelector('.status').textContent = error.message; }
        });
        document.documentElement.append(host);
      }
      const muted = Boolean(saved.followup?.muted);
      const label = muted ? 'Conversation non suivie' : status === 'WAITING_SELLER' ? 'En attente de réponse' : 'Le vendeur a répondu';
      const title = `${label}${pending.length ? ` · ${pending.length} élément${pending.length > 1 ? 's' : ''} à analyser` : ''}`;
      const strong = host.shadowRoot.querySelector('strong');
      if (strong.textContent !== title) strong.textContent = title;
      const chatLink = host.shadowRoot.querySelector('.chat-link');
      const chat = linkedChatUrl(saved, chatUrls);
      chatLink.hidden = !chat;
      if (chatLink.href !== chat) chatLink.href = chat;
      const button = host.shadowRoot.querySelector('.analyze');
      button.hidden = muted || !pending.length;
      if (!transferring) button.disabled = false;
      host.shadowRoot.querySelector('.dismiss').hidden = muted || !pending.length;
      host.shadowRoot.querySelector('.mute').hidden = muted;
      host.shadowRoot.querySelector('.resume').hidden = !muted;
      const proposal = muted ? '' : proposedSellerMessage(saved, pending);
      const proposalText = host.shadowRoot.querySelector('.proposal');
      proposalText.hidden = !proposal;
      proposalText.textContent = proposal;
      host.shadowRoot.querySelector('.send').hidden = !proposal;
    } catch (error) { console.warn('VanCheck : suivi indisponible.', error.message); }
    finally { busy = false; }
  }
  if (typeof module !== 'undefined') { module.exports = { readMessages, activeAd, scoreBadges, prepareFiles, proposedSellerMessage, pendingSellerMessages, linkedChatUrl, galleryImageAttachments, optimizeFiles }; return; }
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
