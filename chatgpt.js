(() => {
  "use strict";
  let token = new URLSearchParams(location.hash.slice(1)).get("vancheck");
  let key;
  // L'éditeur riche transforme les sauts de ligne en paragraphes et peut
  // introduire des espaces insécables. Comparer le contenu, pas leur rendu.
  const normalizeText = text => text.normalize("NFC").replace(/[\u200B\uFEFF]/g, "").replace(/\s+/gu, " ").trim();
  const readText = el => normalizeText(el.value ?? el.innerText ?? el.textContent ?? "");
  const isVanCheckDraft = text => /^Référence VanCheck\s*:/i.test(text);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function conversationUrl() {
    try {
      const url = new URL(location.href);
      if (!/\/c\/[a-f0-9-]{20,}/i.test(url.pathname)) return '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  async function saveConversationUrl(adId, url) {
    if (!adId || !url) return;
    const { chatUrls = {}, analyses = {} } = await chrome.storage.local.get(['chatUrls', 'analyses']);
    chatUrls[adId] = url;
    if (analyses[adId]) analyses[adId] = { ...analyses[adId], chatUrl: url };
    await chrome.storage.local.set({ chatUrls, analyses });
  }

  function watchConversationUrl(adId) {
    if (!adId) return;
    let attempts = 0;
    const check = async () => {
      const url = conversationUrl();
      if (url) {
        clearInterval(timer);
        await saveConversationUrl(adId, url);
      } else if (++attempts >= 2400) {
        clearInterval(timer);
      }
    };
    const timer = setInterval(() => { check().catch(() => clearInterval(timer)); }, 500);
    check().catch(() => clearInterval(timer));
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea', '#mobile-composer-prompt',
      '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]',
      'textarea', 'input[placeholder*="chat" i]', 'input[placeholder*="message" i]',
      'input[placeholder*="discussion" i]', 'input[role="textbox"]'
    ];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find(el =>
        el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" &&
        !el.disabled && !el.readOnly && el.getAttribute("aria-hidden") !== "true");
      if (found) return found;
    }
    return null;
  }

  function insert(el, text) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
    }
  }

  async function run() {
    const transfers = await chrome.storage.local.get(null);
    if (!token || !/^[a-f0-9-]{36}$/i.test(token)) {
      const current = conversationUrl();
      const entry = Object.entries(transfers).filter(([k, value]) => k.startsWith('transfer:') && current && value.chatUrl === current && value.submittedAt && Date.now() - value.submittedAt < 24 * 60 * 60 * 1000).sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
      if (!entry) return;
      key = entry[0];
      token = key.slice('transfer:'.length);
    } else key = `transfer:${token}`;
    const transfer = transfers[key];
    if (!transfer?.text || (!transfer.submittedAt && Date.now() - transfer.createdAt > 10 * 60 * 1000)) return;
    watchAnalysis(transfer);
    if (transfer.submittedAt) return;
    watchConversationUrl(transfer.adId);
    const notice = document.createElement("div");
    notice.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#17352c;color:white;padding:14px;border-radius:12px;font:14px sans-serif;max-width:340px";
    notice.textContent = "VanCheck : préparation du prompt…";
    document.documentElement.append(notice);
    const expected = normalizeText(transfer.text);
    let existingDraft = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const editor = findComposer();
      if (editor && !readText(editor)) insert(editor, transfer.text);
      await pause(500);
      const current = findComposer();
      if (current && readText(current) === expected) {
        await pause(700);
        const stable = findComposer();
        if (stable && readText(stable) === expected) {
          notice.textContent = `VanCheck : prompt ${transfer.reference || ''} prêt à envoyer. L’analyse et le score seront ensuite enregistrés automatiquement sur l’annonce.`;
          const upload = await prepareAttachments(transfer, notice);
          await sendPreparedPrompt(transfer, notice, upload);
          return;
        }
      } else if (current && readText(current)) {
        // ChatGPT restaure parfois le dernier brouillon du projet après le
        // chargement. Un ancien prompt VanCheck peut être remplacé sans risque ;
        // tout autre brouillon utilisateur reste protégé.
        if (isVanCheckDraft(readText(current))) {
          insert(current, transfer.text);
          continue;
        }
        existingDraft = true;
        break;
      }
    }
    notice.textContent = existingDraft
      ? `VanCheck ${transfer.reference || ''} : le champ contient un autre texte. Le nouveau prompt n’a pas remplacé ce brouillon.`
      : `VanCheck ${transfer.reference || ''} : insertion impossible. Le nouveau prompt est disponible ci-dessous.`;
    const fallback = document.createElement("textarea");
    fallback.value = transfer.text;
    fallback.readOnly = true;
    fallback.style.cssText = "display:block;width:300px;height:100px;margin-top:10px;color:#17352c;background:white";
    fallback.addEventListener("click", () => fallback.select());
    notice.append(fallback);
    if (!existingDraft && transfer.attachments?.length) {
      const filesNotice = document.createElement('div');
      notice.append(filesNotice);
      await prepareAttachments(transfer, filesNotice);
    }
    if (existingDraft) {
      const replace = document.createElement('button');
      replace.textContent = 'Remplacer le brouillon par ce prompt';
      replace.style.cssText = 'display:block;margin-top:10px;padding:8px;color:#17352c;background:white';
      replace.addEventListener('click', async () => {
        const editor = findComposer();
        if (!editor) return;
        replace.disabled = true;
        insert(editor, transfer.text);
        await pause(700);
        const current = findComposer();
        if (current && readText(current) === expected) {
          notice.textContent = `VanCheck : prompt ${transfer.reference || ''} prêt à envoyer. L’analyse et le score seront ensuite enregistrés automatiquement sur l’annonce.`;
          const upload = await prepareAttachments(transfer, notice);
          await sendPreparedPrompt(transfer, notice, upload);
        } else {
          replace.disabled = false;
          replace.textContent = 'Remplacement non confirmé — copier le texte ci-dessus';
        }
      });
      notice.append(replace);
    }
  }
  const rpc = async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Opération interrompue.');
    return result.value;
  };

  async function prepareAttachments(transfer, notice) {
    // This receipt belongs to this upload attempt, never to a stored flag or a
    // previous draft. Setting input.files alone does not mean upload is complete.
    const upload = { files: [...(transfer.attachments || [])], dispatched: false, previous: new Set() };
    if (!upload.files.length) { upload.dispatched = true; return upload; }
    const files = upload.files.map(attachment => {
      const binary = atob(attachment.base64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new File([bytes], attachment.name, { type: attachment.type });
    });
    let input;
    notice.textContent = 'VanCheck : préparation des pièces jointes…';
    for (let attempt = 0; attempt < 60; attempt++) {
      input = document.querySelector('input#upload-files[type="file"]');
      if (input && !input.disabled) break;
      await pause(500);
    }
    const form = findComposer()?.closest('form');
    upload.previous = new Set(form?.querySelectorAll('*') || []);
    if (input && !input.disabled) {
      try {
        const data = new DataTransfer();
        files.forEach(file => data.items.add(file));
        input.files = data.files;
        if (input.files.length !== files.length || files.some((file, i) => input.files[i].name !== file.name || input.files[i].size !== file.size)) {
          throw new Error('Les fichiers n’ont pas été déposés dans le champ.');
        }
        input.dispatchEvent(new Event('change', { bubbles: true }));
        upload.dispatched = true;
        notice.textContent = `VanCheck : chargement de ${files.length} pièce(s) jointe(s)…`;
      } catch {
        upload.dispatched = false;
      }
    }
    if (!upload.dispatched) {
      notice.textContent = 'VanCheck : ajout automatique des fichiers indisponible. Télécharge les pièces ci-dessous, puis joins-les au prompt avant de l’envoyer.';
    }
    // Always provide the real bytes as a fallback, never signed attachment URLs.
    for (const file of files) {
      const link = document.createElement('a');
      const url = URL.createObjectURL(file);
      link.href = url;
      link.download = file.name;
      link.textContent = `Télécharger ${file.name}`;
      link.style.cssText = 'display:block;color:white;text-decoration:underline;margin-top:6px';
      notice.append(link);
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    }
    return upload;
  }

  const TEXT_ONLY = '#prompt-textarea, [contenteditable], textarea, input, [data-testid="collapsible-user-message-root"], .user-message-bubble-color, [data-message-author-role="user"] .whitespace-pre-wrap';

  function attachmentEvidence(container, file) {
    if (!container) return [];
    // Do not subtract the prompt from textContent: ProseMirror's paragraphs
    // concatenate there, whereas innerText contains newlines. Exclude its DOM.
    return [...container.querySelectorAll('*')].filter(node => {
      if (node.closest(TEXT_ONLY)) return false;
      const values = ['title', 'aria-label', 'alt'].map(attr => node.getAttribute(attr) || '');
      values.push([...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(' '));
      return values.some(value => {
        value = normalizeText(value);
        return !isVanCheckDraft(value) && value.length <= file.name.length + 100 && value.includes(file.name);
      });
    });
  }

  function imageAttachments(container, previous, sent) {
    const receipts = new Set();
    for (const img of container?.querySelectorAll('img') || []) {
      if (img.closest(TEXT_ONLY) || previous.has(img) || !img.complete || !img.naturalWidth) continue;
      if (sent) {
        // Within this one submitted user turn, count distinct image resources.
        receipts.add(img.currentSrc || img.src);
        continue;
      }
      // Some ChatGPT image tiles expose only "Uploaded image", not a filename.
      // Require a newly added attachment tile with its own removal control;
      // unrelated images/icons in the composer cannot satisfy this condition.
      for (let parent = img.parentElement; parent && parent !== container; parent = parent.parentElement) {
        const remove = [...parent.querySelectorAll('button')].filter(button =>
          /^(remove|supprimer|retirer)\b/i.test(button.getAttribute('aria-label') || button.textContent.trim()));
        if (remove.length === 1 && !previous.has(remove[0])) { receipts.add(remove[0]); break; }
      }
    }
    return receipts.size;
  }

  function filesVisible(container, files, previous = new Set(), sent = false) {
    const images = (files || []).filter(file => file.type.startsWith('image/'));
    const imageCount = images.length ? imageAttachments(container, previous, sent) : 0;
    return (files || []).every(file => attachmentEvidence(container, file).some(node => !previous.has(node)) ||
      (file.type.startsWith('image/') && imageCount >= images.length));
  }

  function uploadsBusy(form) {
    return Boolean(form.querySelector('[role="progressbar"], [aria-busy="true"], .animate-spin, [data-state="uploading"], [data-state="error"], [role="alert"]')) ||
      [...form.querySelectorAll('img')].some(img => !img.closest(TEXT_ONLY) && (!img.complete || !img.naturalWidth));
  }

  async function sendPreparedPrompt(transfer, notice, upload) {
    if (!upload?.dispatched) {
      notice.firstChild.textContent = 'VanCheck : envoi automatique non confirmé. Ajoute toutes les pièces jointes avant d’envoyer le prompt.';
      return;
    }
    const expected = normalizeText(transfer.text);
    let stableChecks = 0;
    notice.firstChild.textContent = 'VanCheck : vérification du prompt et du chargement des pièces avant envoi…';
    for (let attempt = 0; attempt < 240; attempt++) {
      if (transfer.submittedAt) return;
      const editor = findComposer();
      const form = editor?.closest('form');
      const send = form?.querySelector('[data-testid="send-button"]');
      if (editor && readText(editor) !== expected) break;
      const ready = send && !send.disabled && send.getAttribute('aria-disabled') !== 'true' &&
        filesVisible(form, upload.files, upload.previous) && !uploadsBusy(form);
      stableChecks = ready ? stableChecks + 1 : 0;
      // Let asynchronous upload state settle, then recheck all files together.
      if (ready && (!upload.files.length || stableChecks >= 5)) {
        send.click();
        notice.textContent = 'VanCheck : envoi demandé. L’analyse et le score seront enregistrés à la fin de la réponse.';
        return;
      }
      await pause(500);
    }
    notice.firstChild.textContent = 'VanCheck : envoi automatique non confirmé. Vérifie le prompt et les pièces jointes, puis envoie-les dans ChatGPT.';
  }

  function watchAnalysis(transfer) {
    let running = false;
    let lastAnswer = '';
    let stableCount = 0;
    let acknowledged = Boolean(transfer.submittedAt);
    let stopped = false;
    const startedAt = Date.now();
    const check = async () => {
      if (running || stopped) return;
      running = true;
      try {
        if (!chrome.runtime?.id || Date.now() - startedAt > 2 * 60 * 60 * 1000) { clearInterval(timer); return; }
        const messages = [...document.querySelectorAll('[data-message-author-role]')];
        const expected = normalizeText(transfer.text);
        const index = messages.findIndex(node => node.dataset.messageAuthorRole === 'user' && normalizeText(node.innerText || node.textContent).includes(expected));
        if (index < 0) return;
        const chatUrl = conversationUrl();
        if (!chatUrl) return;
        if (!acknowledged) {
          // A submitted turn, rather than an empty composer or an attempted click,
          // is the receipt. With files, verify their names in that same user turn.
          const turn = messages[index].closest('[data-turn="user"], article') || messages[index].parentElement;
          const filesPresent = filesVisible(turn, transfer.attachments, new Set(), true);
          if (!filesPresent) return;
          if (transfer.sellerMessageIds?.length) await rpc({ type: 'VANCHECK_ACK', adId: transfer.adId, ids: transfer.sellerMessageIds });
          transfer.submittedAt = Date.now();
          transfer.chatUrl = chatUrl;
          // Release stored bytes without changing the expected files while an
          // asynchronous preparation/send check may still be running.
          await chrome.storage.local.set({ [key]: { ...transfer, attachments: [] } });
          acknowledged = true;
        }
        const nextUser = messages.findIndex((node, i) => i > index && node.dataset.messageAuthorRole === 'user');
        const candidates = messages.slice(index + 1, nextUser < 0 ? undefined : nextUser).filter(node => node.dataset.messageAuthorRole === 'assistant');
        const answer = candidates.at(-1)?.innerText || candidates.at(-1)?.textContent || '';
        if (!/VANCHECK_ANALYSE_FIN\s*$/.test(answer.trim()) || document.querySelector('[data-testid="stop-button"]')) return;
        if (answer !== lastAnswer) { lastAnswer = answer; stableCount = 0; return; }
        if (++stableCount < 2) return;
        const analysis = VanCheckFollowup.parseResponse(answer);
        if (analysis.score === null) return;
        await rpc({ type: 'VANCHECK_ANALYSIS', adId: transfer.adId, analysis,
          metadata: transfer.metadata || {}, requestedAt: transfer.createdAt, chatUrl });
        await chrome.storage.local.remove(key);
        stopped = true;
        clearInterval(timer);
        const notice = document.createElement('div');
        notice.textContent = `VanCheck : avis et score ${analysis.score.toLocaleString('fr-FR')} / 10 enregistrés pour cette annonce.`;
        notice.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:14px;border-radius:12px;background:#17352c;color:white;font:14px system-ui';
        document.documentElement.append(notice);
        setTimeout(() => notice.remove(), 8000);
      } catch (error) { console.warn('VanCheck : synchronisation en attente.', error.message); }
      finally { running = false; }
    };
    const timer = setInterval(check, 1500);
  }

  run().catch(() => { /* Extension rechargée pendant le transfert. */ });
})();
