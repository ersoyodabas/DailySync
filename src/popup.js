const $ = (selector) => document.querySelector(selector);
const elements = {
  apiEnvironment: $("#apiEnvironment"),
  waitMs: $("#waitMs"),
  start: $("#start"),
  resume: $("#resume"),
  stop: $("#stop"),
  clear: $("#clear"),
  status: $("#status"),
  dot: $("#statusDot"),
  progress: $("#progressBar"),
  countdown: $("#countdown"),
  clubCount: $("#clubCount"),
  pageCount: $("#pageCount"),
  recordCount: $("#recordCount"),
  savedCount: $("#savedCount"),
  skippedCount: $("#skippedCount"),
  logCount: $("#logCount"),
  errorLogs: $("#errorLogs"),
  logs: $("#logs"),
  currentClub: $("#currentClub"),
  records: $("#records"),
  error: $("#error")
};

let currentState = {};
init();
setInterval(renderCountdown, 250);

async function init() {
  const settings = await chrome.storage.local.get(["syncApiBaseUrl", "syncWaitMs"]);
  if (settings.syncApiBaseUrl) elements.apiEnvironment.value = settings.syncApiBaseUrl;
  elements.waitMs.value = String(settings.syncWaitMs || 5000);
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.syncState || {}, snapshot.playerRecords || [], snapshot.syncLogs || [], snapshot.syncErrors || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  if (currentState.queue?.length && !currentState.running && currentState.currentJobIndex >= 0) {
    const confirmed = confirm("Mevcut ilerleme silinip Backend'den yeni kulüp kuyruğu alınacak. Devam edilsin mi?");
    if (!confirmed) return;
  }
  await saveSettings();
  const response = await chrome.runtime.sendMessage({
    type: "START_SYNC",
    apiBaseUrl: elements.apiEnvironment.value,
    waitMs: Number(elements.waitMs.value)
  });
  if (!response?.ok) showError(response?.error || "Tarama başlatılamadı.");
});

elements.resume.addEventListener("click", async () => {
  showError();
  const response = await chrome.runtime.sendMessage({ type: "RESUME_SYNC" });
  if (!response?.ok) showError(response?.error || "Tarama devam ettirilemedi.");
});

elements.stop.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_SYNC" }));

elements.clear.addEventListener("click", async () => {
  if (!confirm("Tarama ilerlemesi ve gösterilen oyuncular temizlensin mi?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_SYNC", apiBaseUrl: elements.apiEnvironment.value });
});

elements.apiEnvironment.addEventListener("change", saveSettings);
elements.waitMs.addEventListener("change", saveSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.syncState && !changes.playerRecords && !changes.syncLogs && !changes.syncErrors)) return;
  Promise.all([
    changes.syncState ? changes.syncState.newValue : chrome.storage.local.get("syncState").then((x) => x.syncState),
    changes.playerRecords ? changes.playerRecords.newValue : chrome.storage.local.get("playerRecords").then((x) => x.playerRecords || []),
    changes.syncLogs ? changes.syncLogs.newValue : chrome.storage.local.get("syncLogs").then((x) => x.syncLogs || []),
    changes.syncErrors ? changes.syncErrors.newValue : chrome.storage.local.get("syncErrors").then((x) => x.syncErrors || [])
  ]).then(([state, records, logs, errors]) => render(state, records, logs, errors));
});

elements.logs.addEventListener("click", (event) => {
  const link = event.target.closest(".request-log-link");
  if (!link) return;
  event.preventDefault();
  const url = safeFutbinUrl(link.dataset.url);
  if (url) chrome.tabs.create({ url, active: true });
});

elements.records.addEventListener("click", (event) => openSyncRow(event));
elements.records.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  openSyncRow(event);
});

function openSyncRow(event) {
  const row = event.target.closest(".sync-player-group .sync-row[data-futbin-url]");
  if (!row) return;
  event.preventDefault();
  const url = safeFutbinUrl(row.dataset.futbinUrl);
  if (url) chrome.tabs.create({ url, active: true });
}

async function saveSettings() {
  await chrome.storage.local.set({
    syncApiBaseUrl: elements.apiEnvironment.value,
    syncWaitMs: Number(elements.waitMs.value)
  });
}

function render(state = {}, records = [], logs = [], errors = []) {
  currentState = state;
  const totalClubs = state.queue?.length || 0;
  const currentClubNumber = state.currentJobIndex >= 0 ? state.currentJobIndex + 1 : 0;
  const currentJob = state.queue?.[state.currentJobIndex];
  const currentPlayers = Object.keys(state.currentPlayers || {}).length;

  elements.status.textContent = state.status || "Hazır";
  elements.dot.classList.toggle("running", Boolean(state.running));
  elements.progress.style.width = totalClubs ? `${Math.min(100, currentClubNumber / totalClubs * 100)}%` : "0%";
  elements.clubCount.textContent = `${Math.min(currentClubNumber, totalClubs)} / ${totalClubs}`;
  elements.pageCount.textContent = `${state.currentPage || 0} / ${state.totalPages || 0}`;
  elements.recordCount.textContent = currentPlayers;
  elements.savedCount.textContent = state.savedPlayers || 0;
  elements.skippedCount.textContent = state.skippedPlayers || 0;
  elements.currentClub.textContent = currentJob ? `${currentJob.league_name} / ${currentJob.club_name}` : "Kulüp bekleniyor";
  elements.start.disabled = Boolean(state.running);
  elements.resume.disabled = Boolean(state.running) || !canResume(state);
  elements.stop.disabled = !state.running;
  elements.apiEnvironment.disabled = Boolean(state.running);
  elements.waitMs.disabled = Boolean(state.running);
  showError(state.error || "");
  renderCountdown();
  renderRecords(records, errors, state);
  renderLogs(logs, errors);
}

function canResume(state) {
  return Boolean(!state.running && state.queue?.length && state.currentJobIndex >= 0 && state.currentJobIndex < state.queue.length && !String(state.status || "").startsWith("Tamamlandı"));
}

function renderCountdown() {
  if (!currentState.running) {
    elements.countdown.textContent = canResume(currentState) ? "Devam etmeye hazır" : "Bekliyor";
    return;
  }
  if (!currentState.nextRunAt) {
    elements.countdown.textContent = "İşleniyor…";
    return;
  }
  const remaining = Math.max(0, currentState.nextRunAt - Date.now());
  elements.countdown.textContent = remaining > 0 ? `${Math.ceil(remaining / 1000)} saniye` : "Şimdi…";
}

function renderRecords(records, errors = [], state = {}) {
  if (!records.length && !errors.length) {
    elements.records.innerHTML = '<div class="empty">Henüz oyuncu verisi yok.</div>';
    return;
  }

  const groups = new Map();
  const ensureGroup = (leagueName, clubName, clubId) => {
    const league = String(leagueName || "Lig").trim() || "Lig";
    const club = String(clubName || "Kulüp").trim() || "Kulüp";
    const key = `${league}\u0000${clubId || club}`;
    if (!groups.has(key)) groups.set(key, { league, club, clubId, normal: [], errors: [] });
    return groups.get(key);
  };

  records.slice(0, 500).forEach((record) => {
    ensureGroup(
      record?.job?.league_name || record?.leagueName,
      record?.job?.club_name || record?.clubName,
      record?.job?.club_id || record?.clubId
    ).normal.push(record);
  });
  errors.slice(0, 300).forEach((entry) => {
    ensureGroup(entry?.leagueName, entry?.clubName, entry?.clubId).errors.push(entry);
  });

  elements.records.innerHTML = [...groups.values()]
    .sort((left, right) => left.league.localeCompare(right.league, "tr") || left.club.localeCompare(right.club, "tr"))
    .map((group) => {
    const saveResult = group.clubId != null ? state.clubSaveResults?.[String(group.clubId)] : null;
    const saveText = saveResult ? ` · ${Number(saveResult.inserted) || 0} yeni · ${Number(saveResult.updated) || 0} güncellendi` : "";
    const countText = `${group.normal.length} okunan${group.errors.length ? ` · ${group.errors.length} hata` : ""}${saveText}`;
    const groupPlayer = group.normal.find((record) => record?.player?.urlImgLeague || record?.player?.urlImgClub)?.player || {};
    const rows = [
      `<div class="league-group sync-group-header"><span class="sync-group-entity">${groupEntityImage(groupPlayer.urlImgLeague, group.league)}<strong>${escapeHtml(group.league)}</strong></span><span class="group-separator">/</span><span class="sync-group-entity">${groupEntityImage(groupPlayer.urlImgClub, group.club)}<strong>${escapeHtml(group.club)}</strong></span><span class="group-count">${escapeHtml(countText)}</span></div>`,
      renderPlayerHeader(),
      ...group.errors.map(renderErrorRecord),
      ...group.normal.map(renderPlayerRecord)
    ];
    return `<div class="sync-player-group">${rows.join("")}</div>`;
  }).join("");
}

function renderPlayerHeader() {
  return `<div class="club-player-header sync-header"><span>POS</span><span>NAME</span><span>QUALITY</span><span>RARITY</span><span>RATING</span><span>LEAGUE</span><span>CLUB</span><span>NATION</span><span class="price-header">Price${playstationIcon()}</span></div>`;
}

function groupEntityImage(imageUrl, name) {
  return imageUrl ? `<img class="sync-group-icon" src="${escapeHtml(imageUrl)}" alt="" title="${escapeHtml(name)}" loading="lazy">` : "";
}

function renderPlayerRecord(record) {
  const player = record.player || {};
  const futbinUrl = safeFutbinUrl(player.futbinPlayerLink);
  return `<article class="player-data-row sync-row${futbinUrl ? " is-clickable" : ""}"${syncRowLinkAttributes(futbinUrl)} title="${escapeHtml(player.name || "")}">
      ${cell(player.positionName, "position-cell")}
      ${cell(player.name, "player-cell")}
      ${imageCell(player.qualityImageUrl || player.urlImgCard, player.qualityCode, "quality-cell")}
      ${imageCell(player.urlImgCard, rarityTooltip(player), `rarity-cell${isCommonRarity(player) ? " is-common" : ""}`)}
      ${cell(player.rating, "rating-cell")}
      ${assetCell("", player.urlImgLeague, "league-cell")}
      ${assetCell("", player.urlImgClub, "club-cell")}
      ${assetCell("", player.urlImgNation, "nation-cell")}
      ${priceCell(player.priceConsole)}
    </article>`;
}

function renderErrorRecord(entry) {
  const context = [entry.stage, entry.page ? `Sayfa ${entry.page}` : ""].filter(Boolean).join(" · ");
  const label = context || "Hatalı kayıt";
  const message = entry.message || "Oyuncu verisi okunamadı.";
  const futbinUrl = safeFutbinUrl(entry.url);
  return `<article class="player-data-row sync-row has-error${futbinUrl ? " is-clickable" : ""}"${syncRowLinkAttributes(futbinUrl)} title="${escapeHtml(message)}">
      <div class="grid-cell warning-cell"><span class="warning-mark">!</span></div>
      ${cell(label, "player-cell error-label-cell")}
      <div class="grid-cell error-message-cell">${escapeHtml(message)}</div>
    </article>`;
}

function syncRowLinkAttributes(url) {
  return url ? ` role="link" tabindex="0" data-futbin-url="${escapeHtml(url)}"` : "";
}

function renderLogs(logs, errors = []) {
  elements.logCount.textContent = `${logs.length} kayıt`;
  renderErrorLogs(errors);
  if (!logs.length) {
    elements.logs.innerHTML = '<div class="logs-empty">Henüz request gönderilmedi.</div>';
    return;
  }
  elements.logs.innerHTML = logs.map((entry) => {
    const time = new Date(entry.requestedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const label = `${entry.leagueName || "Lig"} → ${entry.clubName || "Kulüp"} · Sayfa ${entry.page || "—"}`;
    return `<a class="request-log-link" href="#" data-url="${escapeHtml(entry.url || "")}" title="${escapeHtml(entry.url || "")}">
      <span class="request-log-time">${escapeHtml(time)}</span>
      <span class="request-log-body"><b>${escapeHtml(label)}</b><small>${escapeHtml(entry.url || "")}</small></span>
    </a>`;
  }).join("");
}

function renderErrorLogs(errors = []) {
  if (!errors.length) {
    elements.errorLogs.hidden = true;
    elements.errorLogs.innerHTML = "";
    return;
  }
  elements.errorLogs.hidden = false;
  elements.errorLogs.innerHTML = `
    <div class="error-logs-head"><span>ERRORS</span><small>${errors.length} hata</small></div>
    <div class="error-logs-list">
      ${errors.map((entry) => {
        const time = new Date(entry.occurredAt || entry.requestedAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const context = [entry.leagueName, entry.clubName, entry.page ? `Sayfa ${entry.page}` : "", entry.stage].filter(Boolean).join(" · ");
        return `<div class="error-log-item" title="${escapeHtml(entry.message || "")}">
          <span class="error-log-time">${escapeHtml(time)}</span>
          <span class="error-log-body"><b>${escapeHtml(context || "Player error")}</b><small>${escapeHtml(entry.message || "")}</small></span>
        </div>`;
      }).join("")}
    </div>`;
}

function safeFutbinUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)futbin\.com$/i.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function cell(value, className = "") {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return `<div class="grid-cell ${className}" title="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
}

function assetCell(value, imageUrl, className = "") {
  const text = value === null || value === undefined || value === "" ? "" : String(value);
  const image = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : '<span class="compact-placeholder">—</span>';
  return `<div class="grid-cell icon-cell ${className}" title="${escapeHtml(text || "—")}">${image}${text ? `<small>${escapeHtml(text)}</small>` : ""}</div>`;
}

function imageCell(imageUrl, description, className = "") {
  const title = description === null || description === undefined || description === "" ? "—" : String(description);
  const image = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : '<span class="compact-placeholder">—</span>';
  return `<div class="grid-cell icon-cell ${className}" title="${escapeHtml(title)}">${image}</div>`;
}

function rarityTooltip(player) {
  const id = player.rarityFutbinId ?? "—";
  const name = player.rarityCardName || player.rarityName || player.rarityCode || "—";
  return `ID: ${id} · Name: ${name}`;
}

function isCommonRarity(player) {
  return Number(player.rarityFutbinId) === 0 || String(player.rarityCode || "").toLowerCase() === "common";
}

function priceCell(value) {
  const text = formatPrice(value);
  return `<div class="grid-cell price-cell" title="${escapeHtml(text)}"><span>${escapeHtml(text)}</span>${coinIcon()}</div>`;
}

function formatPrice(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("tr-TR").format(Number(value)) : "—";
}

function coinIcon() {
  return '<svg class="coin-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/></svg>';
}

function playstationIcon() {
  return '<svg class="playstation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.1 3.5v13.2l3.1 1V6.8c0-.8.4-1.3 1-1 .8.2 1.2.9 1.2 1.7v4.3c2.1 1 3.7 0 3.7-2.6 0-2.7-1-3.9-3.8-4.9-1.9-.7-3.7-.9-5.2-.8Z"/><path d="M12.8 16.6v2.1l5.8-2.1c.7-.3.8-.7.2-.9-.7-.2-1.9-.2-2.7.1l-3.3.8Zm-1.7-.6-2.3.8c-.7.2-.8.6-.2.8.6.2 1.7.2 2.5-.1v2l-.5.2c-2.5.9-5.2.5-6.3-.4-1-.9-.2-2 2.2-2.9l4.6-1.6V16Z"/></svg>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message = "") {
  elements.error.hidden = !message;
  elements.error.textContent = message;
}
