const $ = (selector) => document.querySelector(selector);
const LOCAL_API_BASE_URL = "http://localhost:5055/api/";
const elements = {
  apiEnvironmentButtons: [...document.querySelectorAll(".environment-button")],
  operationButtons: [...document.querySelectorAll(".operation-tab")],
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
  insertedCount: $("#insertedCount"),
  updatedCount: $("#updatedCount"),
  deletedCount: $("#deletedCount"),
  skippedCount: $("#skippedCount"),
  logCount: $("#logCount"),
  errorLogs: $("#errorLogs"),
  logs: $("#logs"),
  records: $("#records"),
  error: $("#error"),
  currentClub: $("#currentClub"),
  listTabs: [...document.querySelectorAll(".list-tab")],
  runCount: $("#runCount")
};

let currentState = {};
let currentRecords = [];
let currentLogs = [];
let currentErrors = [];
let currentListTab = "club-players";
let selectedApiBaseUrl = LOCAL_API_BASE_URL;
init();
setInterval(renderCountdown, 250);

async function init() {
  const settings = await chrome.storage.local.get(["syncApiBaseUrl", "syncWaitMs", "syncOperations", "syncListTab"]);
  setApiEnvironment(settings.syncApiBaseUrl || LOCAL_API_BASE_URL);
  setOperationSelection(Array.isArray(settings.syncOperations) ? settings.syncOperations : ["club-players"]);
  elements.waitMs.value = String(settings.syncWaitMs || 5000);
  if (settings.syncListTab) setListTab(settings.syncListTab);
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.syncState || {}, snapshot.playerRecords || [], snapshot.syncLogs || [], snapshot.syncErrors || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  const operations = elements.operationButtons
    .filter((button) => button.classList.contains("active"))
    .map((button) => button.dataset.operation);
  if (!operations.length) {
    showError("En az bir işlem seçmelisin.");
    return;
  }
  if (currentState.queue?.length && !currentState.running && currentState.currentJobIndex >= 0) {
    const confirmed = confirm("Mevcut ilerleme silinip Backend'den yeni kulüp kuyruğu alınacak. Devam edilsin mi?");
    if (!confirmed) return;
  }
  await saveSettings();
  const response = await chrome.runtime.sendMessage({
    type: "START_SYNC",
    apiBaseUrl: selectedApiBaseUrl,
    waitMs: Number(elements.waitMs.value),
    operations
  });
  if (!response?.ok) showError(response?.error || "Tarama başlatılamadı.");
  else {
    elements.start.style.display = "none";
    elements.stop.style.display = "";
    elements.stop.removeAttribute("hidden");
  }
});

elements.resume.addEventListener("click", async () => {
  showError();
  const response = await chrome.runtime.sendMessage({ type: "RESUME_SYNC" });
  if (!response?.ok) showError(response?.error || "Tarama devam ettirilemedi.");
});

elements.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_SYNC" });
  elements.start.style.display = "";
  elements.stop.style.display = "none";
});

elements.clear.addEventListener("click", async () => {
  if (!confirm("Tarama ilerlemesi ve gösterilen oyuncular temizlensin mi?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_SYNC", apiBaseUrl: selectedApiBaseUrl });
});

elements.apiEnvironmentButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    setApiEnvironment(button.dataset.apiBaseUrl);
    await saveSettings();
  });
});
elements.waitMs.addEventListener("change", saveSettings);

elements.operationButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const isActive = button.classList.toggle("active");
    button.setAttribute("aria-pressed", String(isActive));
    await saveOperationSelection();
  });
});

elements.listTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setListTab(tab.dataset.list);
    chrome.storage.local.set({ syncListTab: currentListTab });
    renderRecords(currentRecords, currentErrors, currentState);
  });
});

function setListTab(listName) {
  currentListTab = listName || "club-players";
  elements.listTabs.forEach((t) => t.classList.toggle("active", t.dataset.list === currentListTab));
}

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
    syncApiBaseUrl: selectedApiBaseUrl,
    syncWaitMs: Number(elements.waitMs.value),
    syncOperations: selectedOperations()
  });
}

async function saveOperationSelection() {
  await chrome.storage.local.set({ syncOperations: selectedOperations() });
}

function selectedOperations() {
  return elements.operationButtons
    .filter((button) => button.classList.contains("active"))
    .map((button) => button.dataset.operation);
}

function setOperationSelection(operations) {
  const selected = new Set(operations);
  elements.operationButtons.forEach((button) => {
    const isActive = selected.has(button.dataset.operation);
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function setApiEnvironment(apiBaseUrl) {
  selectedApiBaseUrl = apiBaseUrl || LOCAL_API_BASE_URL;
  elements.apiEnvironmentButtons.forEach((button) => {
    const isActive = button.dataset.apiBaseUrl === selectedApiBaseUrl;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function render(state = {}, records = [], logs = [], errors = []) {
  currentState = state;
  currentRecords = records;
  currentLogs = logs;
  currentErrors = errors;
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
  if (elements.runCount) elements.runCount.textContent = state.runCount || 0;
  const isCoinCardsJob = currentJob?.operation === "coin-cards" || currentJob?.operation === "coin-card-latest";

  const saveTotals = Object.entries(state.clubSaveResults || {}).reduce((totals, [key, result]) => {
    const isResultForCoinCards = String(key).startsWith("coin-card:");
    if (isCoinCardsJob ? !isResultForCoinCards : isResultForCoinCards) return totals;

    return {
      inserted: totals.inserted + (Number(result?.inserted) || 0),
      updated: totals.updated + (Number(result?.updated) || 0),
      deleted: totals.deleted + (Number(result?.deleted) || 0)
    };
  }, { inserted: 0, updated: 0, deleted: 0 });
  if (elements.clubCount.nextElementSibling) {
    elements.clubCount.nextElementSibling.textContent = isCoinCardsJob ? "Cards" : "Club";
  }

  elements.insertedCount.textContent = saveTotals.inserted;
  elements.updatedCount.textContent = saveTotals.updated;
  elements.deletedCount.textContent = saveTotals.deleted;
  elements.skippedCount.textContent = state.skippedPlayers || 0;
  elements.currentClub.textContent = currentJob
    ? currentJob.operation === "coin-cards" || currentJob.operation === "coin-card-latest"
      ? currentJob.label || "Coin Cards"
      : `${currentJob.league_name} / ${currentJob.club_name}`
    : "İş bekleniyor";
  if (state.running) {
    elements.start.style.display = "none";
    elements.stop.style.display = "";
    elements.stop.removeAttribute("hidden");
  } else {
    elements.start.style.display = "";
    elements.stop.style.display = "none";
  }
  elements.start.disabled = Boolean(state.running);
  elements.resume.disabled = Boolean(state.running) || !canResume(state);
  elements.stop.disabled = !state.running;
  elements.apiEnvironmentButtons.forEach((button) => { button.disabled = Boolean(state.running); });
  elements.operationButtons.forEach((button) => { button.disabled = Boolean(state.running); });
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
  if (remaining <= 0) {
    elements.countdown.textContent = "Şimdi…";
  } else {
    const totalSeconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      elements.countdown.textContent = `${hours}s ${minutes}d ${seconds}s`;
    } else if (minutes > 0) {
      elements.countdown.textContent = `${minutes}dk ${seconds}sn`;
    } else {
      elements.countdown.textContent = `${seconds} saniye`;
    }
  }
}

function renderRecords(records, errors = [], state = {}) {
  const isCoinCardsTab = currentListTab === "coin-cards";

  const filteredRecords = records.filter((r) => {
    const isCoinCardJob = r.job?.operation?.startsWith("coin-card");
    return isCoinCardsTab ? isCoinCardJob : !isCoinCardJob;
  });

  const filteredErrors = errors.filter((e) => {
    const isCoinCardJob = e.job?.operation?.startsWith("coin-card") || e.url?.includes("coin-card");
    return isCoinCardsTab ? isCoinCardJob : !isCoinCardJob;
  });

  if (!filteredRecords.length && !filteredErrors.length) {
    elements.records.innerHTML = '<div class="empty">Bu sekmede henüz oyuncu verisi yok.</div>';
    return;
  }

  const firstJob = filteredRecords[0]?.job || filteredErrors[0]?.job;
  const isCoinCards = firstJob?.operation?.startsWith("coin-card");

  if (isCoinCards || isCoinCardsTab) {
    const inserted = filteredRecords.filter((r) => r.saveStatus === "inserted");
    const updated = filteredRecords.filter((r) => r.saveStatus === "updated");
    const pending = filteredRecords.filter((r) => !r.saveStatus || r.saveStatus === "unchanged");

    const makeSection = (label, records, extraClass = "") => {
      if (!records.length) return "";
      const countText = `${records.length} kart`;
      return `<div class="sync-player-group coin-cards-group ${extraClass}">
        <div class="league-group sync-group-header coin-section-header"><span class="sync-group-entity"><strong>${escapeHtml(label)}</strong></span><span class="group-count">${escapeHtml(countText)}</span></div>
        ${renderCoinCardHeader()}
        ${records.map(renderCoinCardRecord).join("")}
      </div>`;
    };

    const errorsHtml = filteredErrors.length
      ? `<div class="sync-player-group coin-cards-group coin-section-errors">
          <div class="league-group sync-group-header"><span class="sync-group-entity"><strong>Hatalar</strong></span><span class="group-count">${filteredErrors.length} hata</span></div>
          ${filteredErrors.slice(0, 300).map(renderErrorRecord).join("")}
        </div>`
      : "";

    const pendingLabel = pending.length && !inserted.length && !updated.length
      ? `Okunan Kartlar (${filteredRecords.length})`
      : "Bekleyenler / Kaydedilmedi";

    elements.records.innerHTML =
      errorsHtml +
      makeSection("✦ Yeni Kartlar", inserted, "section-inserted") +
      makeSection("↑ Güncellenen Kartlar", updated, "section-updated") +
      makeSection(pendingLabel, pending, "section-pending") ||
      '<div class="empty">Bu sekmede henüz oyuncu verisi yok.</div>';
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

  filteredRecords.slice(0, 500).forEach((record) => {
    ensureGroup(
      record?.leagueName || record?.job?.league_name,
      record?.clubName || record?.job?.club_name,
      record?.job?.club_id || record?.clubId
    ).normal.push(record);
  });
  filteredErrors.slice(0, 300).forEach((entry) => {
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

function renderCoinCardHeader() {
  return `<div class="club-player-header sync-header coin-card-header"><span>KART</span><span>OYUNCU</span><span>PUAN</span><span>ÜLKE</span><span class="price-header">Fiyat${playstationIcon()}</span></div>`;
}

function renderCoinCardRecord(record) {
  const player = record.player || {};
  const futbinUrl = safeFutbinUrl(player.futbinPlayerLink);
  const cardBg = player.urlImgCard ? `style="background-image:url('${escapeHtml(player.urlImgCard)}')"; ` : "";
  const playerImg = player.urlImgPlayer
    ? `<img class="cc-player-img" src="${escapeHtml(player.urlImgPlayer)}" alt="" loading="lazy">`
    : `<span class="compact-placeholder">—</span>`;
  const posLabel = player.positionName ? `<span class="cc-pos-label">${escapeHtml(player.positionName)}</span>` : "";
  const ratingLabel = player.rating != null ? `<span class="cc-rating-label">${escapeHtml(String(player.rating))}</span>` : "";
  const cardCell = `<div class="grid-cell cc-card-cell">
    <div class="cc-card-wrap" ${player.urlImgCard ? `style="background-image:url('${escapeHtml(player.urlImgCard)}')"` : ""}>
      ${playerImg}
      ${posLabel}
      ${ratingLabel}
    </div>
  </div>`;
  return `<article class="player-data-row sync-row coin-card-row${futbinUrl ? " is-clickable" : ""}"${syncRowLinkAttributes(futbinUrl)} title="${escapeHtml(player.name || "")}">
      ${cardCell}
      ${cell(player.name, "player-cell")}
      ${cell(player.rating, "rating-cell")}
      ${assetCell("", player.urlImgNation, "nation-cell")}
      ${priceCell(player.priceConsole)}
    </article>`;
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
