const $ = (selector) => document.querySelector(selector);
const elements = {
  urls: $("#urls"), waitMs: $("#waitMs"), start: $("#start"), stop: $("#stop"), clear: $("#clear"),
  status: $("#status"), dot: $("#statusDot"), pageCount: $("#pageCount"), recordCount: $("#recordCount"),
  records: $("#records"), progress: $("#progressBar"), error: $("#error"),
  countdown: $("#countdown"), startLabel: $("#startLabel")
};
let currentState = {};
const collapsedLeagues = new Set();
const collapsedClubs = new Set();
const knownClubs = new Set();

const DEFAULT_URLS = Array.from({ length: 5 }, (_, index) =>
  `https://www.futbin.com/26/players?page=${index + 1}&club=1&league=2216%2C13`
).join("\n");

init();
setInterval(renderCountdown, 250);

async function init() {
  const savedInput = await chrome.storage.local.get(["popupUrls", "popupWaitMs"]);
  elements.urls.value = savedInput.popupUrls || DEFAULT_URLS;
  elements.waitMs.value = String(savedInput.popupWaitMs || 5000);
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.monitorState, snapshot.playerRecords || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  const urls = elements.urls.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const waitMs = Number(elements.waitMs.value);
  await chrome.storage.local.set({ popupUrls: elements.urls.value, popupWaitMs: waitMs });
  const response = await chrome.runtime.sendMessage({ type: "START_MONITOR", urls, waitMs });
  if (!response?.ok) showError(response?.error || "Tarama başlatılamadı.");
});

elements.stop.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_MONITOR" }));
elements.clear.addEventListener("click", () => {
  collapsedLeagues.clear();
  collapsedClubs.clear();
  knownClubs.clear();
  chrome.runtime.sendMessage({ type: "CLEAR_RECORDS" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  Promise.all([
    changes.monitorState ? changes.monitorState.newValue : chrome.storage.local.get("monitorState").then((x) => x.monitorState),
    changes.playerRecords ? changes.playerRecords.newValue : chrome.storage.local.get("playerRecords").then((x) => x.playerRecords || [])
  ]).then(([state, records]) => render(state, records));
});

elements.records.addEventListener("click", (event) => {
  const toggle = event.target.closest(".group-toggle");
  if (toggle) {
    const targetSet = toggle.dataset.groupType === "league" ? collapsedLeagues : collapsedClubs;
    if (targetSet.has(toggle.dataset.groupKey)) targetSet.delete(toggle.dataset.groupKey);
    else targetSet.add(toggle.dataset.groupKey);
    refreshGroupVisibility();
    return;
  }
  openPlayerRow(event.target.closest(".player-data-row"));
});

elements.records.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const row = event.target.closest(".player-data-row");
  if (!row) return;
  event.preventDefault();
  openPlayerRow(row);
});

function openPlayerRow(row) {
  if (!row?.dataset.playerUrl) return;
  chrome.tabs.create({ url: row.dataset.playerUrl, active: true });
}

function render(state = {}, records = []) {
  currentState = state;
  const total = state.queue?.length || 0;
  const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  elements.status.textContent = state.status || "Hazır";
  elements.pageCount.textContent = `${Math.min(current, total)} / ${total}`;
  elements.recordCount.textContent = records.length;
  elements.progress.style.width = total ? `${Math.min(100, current / total * 100)}%` : "0%";
  elements.dot.classList.toggle("running", Boolean(state.running));
  elements.start.disabled = Boolean(state.running);
  elements.start.classList.toggle("running", Boolean(state.running));
  elements.startLabel.textContent = state.running ? "Veriler okunuyor" : "Taramayı başlat";
  elements.stop.disabled = !state.running;
  renderCountdown();
  elements.records.innerHTML = records.length ? groupedRecordsHtml(records.slice(0, 500)) : '<div class="empty">Henüz oyuncu verisi yok.</div>';
  refreshGroupVisibility();
}

function groupedRecordsHtml(records) {
  const leagues = new Map();
  for (const record of records) {
    const player = record.player || {};
    const leagueName = entityName(player.league) || player.leagueName || player.league_name || "Bilinmeyen League";
    const clubName = entityName(player.club) || player.clubName || player.club_name || "Bilinmeyen Club";
    if (!leagues.has(leagueName)) leagues.set(leagueName, new Map());
    const clubs = leagues.get(leagueName);
    if (!clubs.has(clubName)) clubs.set(clubName, []);
    clubs.get(clubName).push(record);
  }

  return [...leagues.entries()]
    .sort(([left], [right]) => groupNameSort(left, right, "Bilinmeyen League"))
    .map(([leagueName, clubs]) => {
      const leagueKey = encodeURIComponent(String(leagueName));
      const leagueCount = [...clubs.values()].reduce((total, clubRecords) => total + clubRecords.length, 0);
      const clubRows = [...clubs.entries()]
        .sort(([left], [right]) => groupNameSort(left, right, "Bilinmeyen Club"))
        .map(([clubName, clubRecords]) => {
          const clubKey = `${leagueKey}/${encodeURIComponent(String(clubName))}`;
          if (!knownClubs.has(clubKey)) {
            knownClubs.add(clubKey);
            collapsedClubs.add(clubKey);
          }
          return `${clubGroupRow(clubName, clubRecords.length, leagueKey, clubKey)}${clubPlayerHeader(leagueKey, clubKey)}${clubRecords.map((record) => recordHtml(record, leagueKey, clubKey)).join("")}`;
        })
        .join("");
      return `${leagueGroupRow(leagueName, leagueCount, clubs.size, leagueKey)}${clubRows}`;
    })
    .join("");
}

function groupNameSort(left, right, unknownLabel) {
  if (left === unknownLabel) return 1;
  if (right === unknownLabel) return -1;
  return String(left).localeCompare(String(right), "tr");
}

function leagueGroupRow(name, playerCount, clubCount, leagueKey) {
  return `<div class="league-group" data-league-key="${escapeHtml(leagueKey)}"><button class="group-toggle" data-group-type="league" data-group-key="${escapeHtml(leagueKey)}" aria-expanded="true"><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg><span class="group-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 5.8 1.2 3.7h4.6l1.2-3.7M5.1 11h3.7l1.4 4.3-3 2.2M18.9 11h-3.7l-1.4 4.3 3 2.2M10.2 15.3h3.6"/></svg></span><strong>${escapeHtml(String(name))}</strong><span class="group-count">${clubCount} kulüp · ${playerCount} veri</span></button></div>`;
}

function clubGroupRow(name, playerCount, leagueKey, clubKey) {
  return `<div class="club-group" data-league-key="${escapeHtml(leagueKey)}" data-club-key="${escapeHtml(clubKey)}"><button class="group-toggle" data-group-type="club" data-group-key="${escapeHtml(clubKey)}" aria-expanded="false"><span class="group-branch"></span><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg><span class="group-icon club"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"/><path d="M9 12h6M12 9v6"/></svg></span><strong>${escapeHtml(String(name))}</strong><span class="group-count">${playerCount} veri</span></button></div>`;
}

function clubPlayerHeader(leagueKey, clubKey) {
  return `<div class="club-player-header" role="row" data-league-key="${escapeHtml(leagueKey)}" data-club-key="${escapeHtml(clubKey)}"><span>POS</span><span>Name</span><span>Q</span><span>R</span><span>OVR</span><span>League</span><span>Club</span><span>Nation</span><span>PS</span><span>PC</span></div>`;
}

function renderCountdown() {
  if (!currentState.running) {
    elements.countdown.textContent = "Bekliyor";
    elements.startLabel.textContent = "Taramayı başlat";
    return;
  }
  if (!currentState.nextRunAt) {
    elements.countdown.textContent = "Sayfa yükleniyor…";
    elements.startLabel.textContent = "Sayfa yükleniyor";
    return;
  }
  const remainingMs = Math.max(0, currentState.nextRunAt - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  elements.countdown.textContent = remainingMs > 0 ? `${seconds} saniye` : "Şimdi geçiliyor…";
  elements.startLabel.textContent = remainingMs > 0 ? `Veriler okunuyor · ${seconds} sn` : "Sonraki sayfaya geçiliyor";
}

function recordHtml(record, leagueKey, clubKey) {
  const player = record.player || {};
  const shortName = player.shortName || player.commonName || player.playerShortName || player.name || "—";
  const quality = entityDetails(player.quality, player.qualityName, player.cardImage);
  const rarity = entityDetails(player.rarity, player.rarityName || player.revision, player.cardImage || quality.image);
  const league = entityDetails(player.league, player.leagueName);
  const club = entityDetails(player.club, player.clubName);
  const nation = entityDetails(player.nation, player.nationName);
  const psPrice = player.prices?.playstation ?? player.prices?.ps ?? player.psPrice ?? player.pricePs ?? player.price;
  const pcPrice = player.prices?.pc ?? player.pcPrice ?? player.pricePc;
  const playerUrl = safeFutbinUrl(player.url || player.playerUrl || player.player_url, record.pageUrl);

  return `<article class="player-data-row${playerUrl ? " is-clickable" : ""}" role="${playerUrl ? "link" : "row"}" ${playerUrl ? 'tabindex="0"' : ""} data-player-url="${escapeHtml(playerUrl || "")}" data-league-key="${escapeHtml(leagueKey)}" data-club-key="${escapeHtml(clubKey)}">
    ${compactTextCell(player.position, "position-cell")}
    ${compactTextCell(shortName, "player-cell")}
    ${iconCell(quality, "Quality")}
    ${iconCell(rarity, "Rarity")}
    ${compactTextCell(player.rating ?? player.overall, "rating-cell")}
    ${iconCell(league, "League")}
    ${iconCell(club, "Club")}
    ${iconCell(nation, "Nation")}
    ${compactTextCell(formatPrice(psPrice), "price-cell")}
    ${compactTextCell(formatPrice(pcPrice), "price-cell")}
  </article>`;
}

function refreshGroupVisibility() {
  elements.records.querySelectorAll(".league-group").forEach((row) => {
    const collapsed = collapsedLeagues.has(row.dataset.leagueKey);
    row.classList.toggle("collapsed", collapsed);
    row.querySelector(".group-toggle")?.setAttribute("aria-expanded", String(!collapsed));
  });
  elements.records.querySelectorAll(".club-group").forEach((row) => {
    const leagueCollapsed = collapsedLeagues.has(row.dataset.leagueKey);
    const clubCollapsed = collapsedClubs.has(row.dataset.clubKey);
    row.hidden = leagueCollapsed;
    row.classList.toggle("collapsed", clubCollapsed);
    row.querySelector(".group-toggle")?.setAttribute("aria-expanded", String(!clubCollapsed));
  });
  elements.records.querySelectorAll(".player-data-row").forEach((row) => {
    row.hidden = collapsedLeagues.has(row.dataset.leagueKey) || collapsedClubs.has(row.dataset.clubKey);
  });
  elements.records.querySelectorAll(".club-player-header").forEach((row) => {
    row.hidden = collapsedLeagues.has(row.dataset.leagueKey) || collapsedClubs.has(row.dataset.clubKey);
  });
}

function entityName(value) {
  return value && typeof value === "object" ? value.name || value.id : value;
}

function entityDetails(value, fallbackName, fallbackImage) {
  if (value && typeof value === "object") {
    return { name: value.name || value.label || fallbackName || value.id || "—", image: value.image || value.img || value.icon || fallbackImage || null };
  }
  return { name: value || fallbackName || "—", image: fallbackImage || null };
}

function compactTextCell(value, className = "") {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return `<div class="grid-cell ${className}" title="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
}

function iconCell(entity, label) {
  const image = safeImageUrl(entity.image);
  const visual = image
    ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
    : `<span class="compact-placeholder">—</span>`;
  return `<div class="grid-cell icon-cell" title="${escapeHtml(label)}: ${escapeHtml(String(entity.name))}">${visual}</div>`;
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("tr-TR").format(Number(value)) : String(value);
}

function safeImageUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function safeFutbinUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl || "https://www.futbin.com/");
    return url.protocol === "https:" && /(^|\.)futbin\.com$/i.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message = "") {
  elements.error.hidden = !message;
  elements.error.textContent = message;
}
