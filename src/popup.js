const $ = (selector) => document.querySelector(selector);
const LOCAL_API_BASE_URL = "http://localhost:5055/api/";
const elements = {
  apiEnvironmentButtons: [...document.querySelectorAll(".environment-button")],
  waitMs: $("#waitMs"),
  start: $("#start"),
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
  contentTabs: [...document.querySelectorAll(".content-tab")],
  listTitle: $("#listTitle"),
  runCount: $("#runCount")
};

let currentState = {};
let currentRecords = [];
let currentLogs = [];
let currentErrors = [];
let currentContentTab = "web-app-sync";
let currentListTab = "web-app-sync";
let selectedApiBaseUrl = LOCAL_API_BASE_URL;
const collapsedCoinSections = new Set();
init();
setInterval(renderCountdown, 250);

async function init() {
  const settings = await chrome.storage.local.get(["syncApiBaseUrl", "syncWaitMs", "syncListTab", "syncContentTab"]);
  setApiEnvironment(settings.syncApiBaseUrl || LOCAL_API_BASE_URL);
  elements.waitMs.value = String(settings.syncWaitMs || 5000);
  setContentTab(settings.syncContentTab || contentNameForList(settings.syncListTab) || "web-app-sync");
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.syncState || {}, snapshot.playerRecords || [], snapshot.syncLogs || [], snapshot.syncErrors || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  const operations = allSyncOperations();
  if (!operations.length) {
    showError("Bu sekmeye bağlı senkronizasyon işlemi bulunamadı.");
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

elements.contentTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setContentTab(tab.dataset.content);
    chrome.storage.local.set({
      syncOperations: selectedOperations(),
      syncContentTab: tab.dataset.content,
      syncListTab: currentListTab
    });
    render(currentState, currentRecords, currentLogs, currentErrors);
  });
});

function setListTab(listName, title) {
  currentListTab = listName || "web-app-sync";
  if (elements.listTitle) {
    elements.listTitle.textContent = title || (currentListTab === "coin-cards"
      ? "Futbin Latest Coin Cards"
      : currentListTab === "club-players"
        ? "Futbin All Players"
        : "Web App Sync");
  }
}

function setContentTab(contentName) {
  const selectedTab = elements.contentTabs.find((tab) => tab.dataset.content === contentName) ||
    elements.contentTabs.find((tab) => tab.dataset.content === "web-app-sync") ||
    elements.contentTabs[0];
  const selectedContent = selectedTab?.dataset.content || "web-app-sync";
  currentContentTab = selectedContent;
  setListTab(selectedTab?.dataset.list || "web-app-sync", selectedTab?.textContent?.trim());

  elements.contentTabs.forEach((tab) => {
    const isSelected = tab.dataset.content === selectedContent;
    tab.classList.toggle("view-active", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
  });
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

elements.records.addEventListener("click", (event) => {
  const toggle = event.target.closest(".coin-section-toggle");
  if (toggle) {
    const sectionName = toggle.dataset.section;
    const section = toggle.closest(".coin-cards-group");
    const willCollapse = !section.classList.contains("collapsed");
    section.classList.toggle("collapsed", willCollapse);
    toggle.setAttribute("aria-expanded", String(!willCollapse));
    if (willCollapse) collapsedCoinSections.add(sectionName);
    else collapsedCoinSections.delete(sectionName);
    return;
  }
  openSyncRow(event);
});
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
    syncOperations: selectedOperations(),
    syncContentTab: currentContentTab,
    syncListTab: currentListTab
  });
}

function selectedOperations() {
  return (selectedContentTab()?.dataset.operations || "")
    .split(",")
    .map((operation) => operation.trim())
    .filter(Boolean);
}

function allSyncOperations() {
  return [...new Set(elements.contentTabs.flatMap((tab) =>
    (tab.dataset.operations || "")
      .split(",")
      .map((operation) => operation.trim())
      .filter(Boolean)
  ))];
}

function selectedContentTab() {
  return elements.contentTabs.find((tab) => tab.dataset.content === currentContentTab);
}

function contentNameForList(listName) {
  return elements.contentTabs.find((tab) => tab.dataset.list === listName)?.dataset.content;
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
  const viewState = stateForCurrentView(state);
  const nonSkippedErrors = errors.filter((entry) => !isSkippedErrorEntry(entry));
  const displayLogs = logs.filter(entryMatchesCurrentView);
  const displayErrors = nonSkippedErrors.filter(entryMatchesCurrentView);
  currentState = viewState;
  currentRecords = records;
  currentLogs = logs;
  currentErrors = nonSkippedErrors;
  const visibleQueue = queueForCurrentView(viewState.queue || []);
  const currentJob = viewState.queue?.[viewState.currentJobIndex];
  const activeJob = jobMatchesCurrentView(currentJob) ? currentJob : null;
  const completedVisibleJobs = visibleQueue
    .filter((job) => (viewState.queue || []).indexOf(job) < viewState.currentJobIndex)
    .length;
  const currentJobNumber = activeJob
    ? visibleQueue.findIndex((job) => job === activeJob) + 1
    : Math.min(completedVisibleJobs, visibleQueue.length);
  const totalJobs = visibleQueue.length;
  const currentPlayers = activeJob
    ? activeJob.operation === "coin-card-latest"
      ? viewState.currentLatest?.cards?.length || 0
      : Object.keys(viewState.currentPlayers || {}).length
    : 0;

  elements.status.textContent = !hasSyncContentView()
    ? "İçerik henüz hazır değil"
    : activeJob
      ? viewState.status || "Hazır"
      : viewState.running && totalJobs
        ? currentJobNumber >= totalJobs
          ? "Bu sekmedeki işler tamamlandı"
          : "Bu sekmedeki işler sırada bekliyor"
        : "Hazır";
  elements.dot.classList.toggle("running", Boolean(viewState.running && hasSyncContentView()));
  elements.progress.style.width = totalJobs ? `${Math.min(100, currentJobNumber / totalJobs * 100)}%` : "0%";
  elements.clubCount.textContent = `${Math.min(currentJobNumber, totalJobs)} / ${totalJobs}`;
  elements.pageCount.textContent = activeJob ? `${viewState.currentPage || 0} / ${viewState.totalPages || 0}` : "0 / 0";
  elements.recordCount.textContent = currentPlayers;
  if (elements.runCount) elements.runCount.textContent = viewState.runCount || 0;

  const saveTotals = Object.entries(viewState.clubSaveResults || {}).reduce((totals, [key, result]) => {
    if (!saveResultMatchesCurrentView(key)) return totals;

    return {
      inserted: totals.inserted + (Number(result?.inserted) || 0),
      updated: totals.updated + (Number(result?.updated) || 0),
      deleted: totals.deleted + (Number(result?.deleted) || 0)
    };
  }, { inserted: 0, updated: 0, deleted: 0 });
  if (elements.clubCount.nextElementSibling) {
    elements.clubCount.nextElementSibling.textContent = currentListTab === "coin-cards"
      ? "Cards"
      : currentListTab === "club-players"
        ? "Club"
        : "Content";
  }

  elements.insertedCount.textContent = saveTotals.inserted;
  elements.updatedCount.textContent = saveTotals.updated;
  elements.deletedCount.textContent = saveTotals.deleted;
  elements.skippedCount.textContent = skippedCountForCurrentView(viewState, activeJob);
  elements.currentClub.textContent = activeJob
    ? isCoinCardJob(activeJob)
      ? activeJob.label || "Coin Cards"
      : `${activeJob.league_name} / ${activeJob.club_name}`
    : viewState.running && totalJobs
      ? currentJobNumber >= totalJobs
        ? "Bu sekme tamamlandı"
        : "Sırada bekliyor"
      : "İş bekleniyor";
  if (state.running) {
    elements.start.style.display = "none";
    elements.stop.style.display = "";
    elements.stop.removeAttribute("hidden");
  } else {
    elements.start.style.display = "";
    elements.stop.style.display = "none";
  }
  elements.start.disabled = Boolean(state.running) || !allSyncOperations().length;
  elements.stop.disabled = !state.running;
  elements.apiEnvironmentButtons.forEach((button) => { button.disabled = Boolean(state.running); });
  elements.waitMs.disabled = Boolean(state.running);
  showError(viewState.error || "");
  renderCountdown();
  renderRecords(records, displayErrors, viewState);
  renderLogs(displayLogs, displayErrors);
}

function isSkippedErrorEntry(entry) {
  const message = String(entry?.message || "").toLocaleLowerCase("tr-TR");
  return message.includes("atlandı") || message.includes("atlandi");
}

function stateForCurrentView(state = {}) {
  if (currentListTab === "coin-cards") return state.runs?.["coin-cards"] || state;
  if (currentListTab === "club-players") return state.runs?.["club-players"] || state;
  return state;
}

function isCoinCardJob(job) {
  return String(job?.operation || "").startsWith("coin-card");
}

function isCoinCardEntry(entry) {
  return Boolean(
    isCoinCardJob(entry?.job) ||
    String(entry?.url || "").includes("coin-card") ||
    String(entry?.leagueName || "").toLocaleLowerCase("tr-TR") === "coin cards"
  );
}

function hasSyncContentView() {
  return currentListTab === "coin-cards" || currentListTab === "club-players";
}

function jobMatchesCurrentView(job) {
  if (!job || !hasSyncContentView()) return false;
  const isCoinCard = isCoinCardJob(job);
  return currentListTab === "coin-cards" ? isCoinCard : !isCoinCard;
}

function entryMatchesCurrentView(entry) {
  if (!hasSyncContentView()) return false;
  const isCoinCard = isCoinCardEntry(entry);
  return currentListTab === "coin-cards" ? isCoinCard : !isCoinCard;
}

function queueForCurrentView(queue) {
  return (queue || []).filter(jobMatchesCurrentView);
}

function saveResultMatchesCurrentView(key) {
  if (!hasSyncContentView()) return false;
  const isCoinCard = String(key).startsWith("coin-card:");
  return currentListTab === "coin-cards" ? isCoinCard : !isCoinCard;
}

function skippedCountForCurrentView(state, activeJob) {
  const savedSkipped = Object.entries(state.clubSaveResults || {})
    .filter(([key]) => saveResultMatchesCurrentView(key))
    .reduce((total, [, result]) => total + (Number(result?.skipped) || 0), 0);
  return savedSkipped + (activeJob ? Number(state.currentSkipped) || 0 : 0);
}

function canResume(state) {
  return Boolean(!state.running && state.queue?.length && state.currentJobIndex >= 0 && state.currentJobIndex < state.queue.length && !String(state.status || "").startsWith("Tamamlandı"));
}

function renderCountdown() {
  if (!hasSyncContentView()) {
    elements.countdown.textContent = "İçerik yok";
    return;
  }
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
  if (!hasSyncContentView()) {
    elements.records.innerHTML = '<div class="empty">Web App Sync içeriği henüz hazır değil.</div>';
    return;
  }

  const coinRecords = records.filter(isCoinCardEntry);
  const clubRecords = records.filter((record) => !isCoinCardEntry(record));
  const coinErrors = errors.filter(isCoinCardEntry);
  const clubErrors = errors.filter((entry) => !isCoinCardEntry(entry));

  if (currentListTab === "coin-cards") {
    elements.records.innerHTML = renderCoinCardSections(coinRecords, coinErrors, true);
    return;
  }

  elements.records.innerHTML = renderClubPlayerGroups(clubRecords, clubErrors, state) ||
    '<div class="empty">Bu sekmede henüz oyuncu verisi yok.</div>';
}

function renderCoinCardSections(records, errors = [], showEmpty = true) {
  if (!showEmpty && !records.length && !errors.length) return "";

  const inserted = records.filter((r) => r.saveStatus === "inserted");
  const updated = records.filter((r) => r.saveStatus !== "inserted");

  const makeSection = (sectionName, label, records, errors = [], extraClass = "") => {
    const countText = `${records.length} kart`;
    const isCollapsed = collapsedCoinSections.has(sectionName);
    const rows = records.length || errors.length
      ? `${records.length ? renderCoinCardHeader() : ""}${errors.map(renderErrorRecord).join("")}${records.map(renderCoinCardRecord).join("")}`
      : '<div class="coin-section-empty">Henüz kayıt yok.</div>';
    return `<div class="sync-player-group coin-cards-group ${extraClass}${isCollapsed ? " collapsed" : ""}">
      <div class="league-group sync-group-header coin-section-header">
        <button class="group-toggle coin-section-toggle" type="button" data-section="${escapeHtml(sectionName)}" aria-expanded="${String(!isCollapsed)}">
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
          <span class="sync-group-entity"><strong>${escapeHtml(label)}</strong></span>
          <span class="group-count">${escapeHtml(countText)}</span>
        </button>
      </div>
      <div class="coin-section-body">${rows}</div>
    </div>`;
  };

  return makeSection("inserted", "Yeni Kartlar", inserted, [], "section-inserted") +
    makeSection("updated", "Güncellenen Kartlar", updated, errors.slice(0, 300), "section-updated");
}

function renderClubPlayerGroups(records, errors = [], state = {}) {
  if (!records.length && !errors.length) return "";

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
      record?.leagueName || record?.job?.league_name,
      record?.clubName || record?.job?.club_name,
      record?.job?.club_id || record?.clubId
    ).normal.push(record);
  });
  errors.slice(0, 300).forEach((entry) => {
    ensureGroup(entry?.leagueName, entry?.clubName, entry?.clubId).errors.push(entry);
  });

  return [...groups.values()]
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
  return `<div class="club-player-header sync-header coin-card-header">
    <span>KART</span>
    <span>OYUNCU</span>
    <span class="price-header">${consolePlatformIcon()}CONSOLE</span>
    <span class="price-header">${pcPlatformIcon()}PC</span>
    <span class="date-header">İŞLEM TARİHİ</span>
  </div>`;
}

function renderCoinCardRecord(record) {
  const player = record.player || {};
  const fullPlayerName = String(player.name || "—");
  const shortPlayerName = Array.from(fullPlayerName).slice(0, 15).join("");
  const futbinUrl = safeFutbinUrl(player.futbinPlayerLink);
  const playerImg = player.urlImgPlayer
    ? `<img class="cc-player-img" src="${escapeHtml(player.urlImgPlayer)}" alt="" loading="lazy">`
    : `<span class="compact-placeholder">—</span>`;
  const cardCell = `<div class="grid-cell cc-card-cell">
    <div class="cc-card-wrap" ${player.urlImgCard ? `style="background-image:url('${escapeHtml(player.urlImgCard)}')"` : ""}>
      ${playerImg}
    </div>
  </div>`;
  const nation = player.urlImgNation
    ? `<img class="cc-nation-img" src="${escapeHtml(player.urlImgNation)}" alt="" loading="lazy">`
    : "";
  const playerDetails = `<div class="grid-cell cc-player-details" title="${escapeHtml(fullPlayerName)}">
    <strong>${escapeHtml(shortPlayerName)}</strong>
    <span class="cc-player-meta"><b>${escapeHtml(player.rating ?? "—")}</b>${nation}</span>
  </div>`;
  return `<article class="player-data-row sync-row coin-card-row${futbinUrl ? " is-clickable" : ""}"${syncRowLinkAttributes(futbinUrl)} title="${escapeHtml(player.name || "")}">
      ${cardCell}
      ${playerDetails}
      ${priceCell(player.priceConsole)}
      ${priceCell(player.pricePc)}
      ${processedDateCell(record.processedAt)}
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
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  const roundedThousands = Math.round(number / 1_000);
  if (roundedThousands >= 1_000) {
    const millions = Math.floor(roundedThousands / 1_000);
    const thousands = roundedThousands % 1_000;
    return thousands ? `${millions}M ${thousands}K` : `${millions}M`;
  }
  if (roundedThousands >= 1) return `${roundedThousands}K`;
  return new Intl.NumberFormat("tr-TR").format(number);
}

function processedDateCell(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '<div class="grid-cell processed-date-cell"><span>—</span></div>';
  }
  const dateText = new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
  const timeText = new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
  return `<div class="grid-cell processed-date-cell" title="${escapeHtml(`${dateText} ${timeText}`)}">
    <span>${escapeHtml(dateText)}</span><b>${escapeHtml(timeText)}</b>
  </div>`;
}

function coinIcon() {
  return '<svg class="coin-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/></svg>';
}

function playstationIcon() {
  return '<svg class="playstation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.1 3.5v13.2l3.1 1V6.8c0-.8.4-1.3 1-1 .8.2 1.2.9 1.2 1.7v4.3c2.1 1 3.7 0 3.7-2.6 0-2.7-1-3.9-3.8-4.9-1.9-.7-3.7-.9-5.2-.8Z"/><path d="M12.8 16.6v2.1l5.8-2.1c.7-.3.8-.7.2-.9-.7-.2-1.9-.2-2.7.1l-3.3.8Zm-1.7-.6-2.3.8c-.7.2-.8.6-.2.8.6.2 1.7.2 2.5-.1v2l-.5.2c-2.5.9-5.2.5-6.3-.4-1-.9-.2-2 2.2-2.9l4.6-1.6V16Z"/></svg>';
}

function consolePlatformIcon() {
  return '<svg class="platform-header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10a4 4 0 0 1 3.8 5.2l-1.2 3.6a2 2 0 0 1-3.2.9L14.5 16h-5l-1.9 1.7a2 2 0 0 1-3.2-.9l-1.2-3.6A4 4 0 0 1 7 8Z"/><path d="M8 11v4M6 13h4M16 12h.01M18 14h.01"/></svg>';
}

function pcPlatformIcon() {
  return '<svg class="platform-header-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message = "") {
  elements.error.hidden = !message;
  elements.error.textContent = message;
}
