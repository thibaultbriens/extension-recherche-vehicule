const DEFAULT_CRITERIA = "";
const META = {
  "INTERESSANT": { label: "Intéressant", tone: "good" },
  "A VERIFIER": { label: "À vérifier", tone: "warn" },
  "A EVITER": { label: "À éviter", tone: "bad" }
};
const CONTACT_META = {
  WAITING_SELLER: "En attente de réponse",
  WAITING_ME: "À moi de répondre"
};

const $ = selector => document.querySelector(selector);
const escapeHtml = (value = "") => value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

async function load() {
  const { criteria = DEFAULT_CRITERIA, projectUrl = "", analyses = {}, chatUrls = {} } = await chrome.storage.local.get(["criteria", "projectUrl", "analyses", "chatUrls"]);
  $("#criteria").value = criteria;
  $("#project-url").value = projectUrl;
  const entries = Object.values(analyses).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  $("#count").textContent = `${entries.length} annonce${entries.length > 1 ? "s" : ""}`;
  $("#history").innerHTML = entries.length ? entries.map(item => {
    const meta = META[item.verdict] || META["A VERIFIER"];
    const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(item.savedAt));
    const chatUrl = item.chatUrl || chatUrls[item.adId] || '';
    const contact = CONTACT_META[item.contactStatus];
    return `<article class="item"><div class="item-top"><span class="dot ${meta.tone}"></span><a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.title || "Annonce")}</a></div><p>${typeof item.score === 'number' ? item.score.toLocaleString('fr-FR') + ' / 10 · ' : ''}${meta.label} · ${escapeHtml(item.summary)} · ${date}</p>${item.personalNote ? `<p><strong>Note personnelle :</strong> ${escapeHtml(item.personalNote)}</p>` : ''}${contact ? `<span class="contact ${item.contactStatus === 'WAITING_ME' ? 'reply' : 'waiting'}">${escapeHtml(contact)}</span>` : ''}<div class="item-links"><a href="${escapeHtml(item.url)}" target="_blank">Voir l’annonce</a>${chatUrl ? `<a href="${escapeHtml(chatUrl)}" target="_blank">Reprendre le chat ↗</a>` : ''}</div></article>`;
  }).join("") : `<div class="empty">Vos prochaines trouvailles apparaîtront ici.</div>`;
}

$("#save").addEventListener("click", async () => {
  const projectUrl = $("#project-url").value.trim();
  if (projectUrl && !/^https:\/\/chatgpt\.com\//i.test(projectUrl)) {
    $("#save-status").textContent = "Le lien doit commencer par chatgpt.com";
    return;
  }
  await chrome.storage.local.set({ criteria: $("#criteria").value.trim(), projectUrl });
  $("#save-status").textContent = "Critères enregistrés ✓";
  setTimeout(() => $("#save-status").textContent = "", 1800);
});

$("#export").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["criteria", "projectUrl", "analyses", "chatUrls"]);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vancheck-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

chrome.storage.onChanged.addListener(changes => { if (changes.analyses || changes.chatUrls) load(); });
load();
