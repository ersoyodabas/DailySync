(function () {
  const actions = window.FutbinSyncActions = window.FutbinSyncActions || {};

  actions["coin-cards"] = {
    defaultTitle: "Futbin Latest Coin Cards",
    statLabel: "Cards",
    hasSyncContent: true,
    stateForView: (state) => state.runs?.["coin-cards"] || state,
    jobMatches: (job, { isCoinCardJob }) => isCoinCardJob(job),
    entryMatches: (entry, { isCoinCardEntry }) => isCoinCardEntry(entry),
    saveResultMatches: (key) => String(key).startsWith("coin-card:"),
    currentPlayers(state, activeJob) {
      if (!activeJob) return 0;
      return activeJob.operation === "coin-card-latest"
        ? state.currentLatest?.cards?.length || 0
        : Object.keys(state.currentPlayers || {}).length;
    },
    skippedCount(state, activeJob) {
      const savedSkipped = Object.entries(state.clubSaveResults || {})
        .filter(([key]) => this.saveResultMatches(key))
        .reduce((total, [, result]) => total + (Number(result?.skipped) || 0), 0);
      return savedSkipped + (activeJob ? Number(state.currentSkipped) || 0 : 0);
    },
    currentJobLabel({ activeJob, viewState, currentJobNumber, totalJobs }) {
      if (activeJob) return activeJob.label || "Coin Cards";
      if (!viewState.running || !totalJobs) return "İş bekleniyor";
      return currentJobNumber >= totalJobs ? "Bu sekme tamamlandı" : "Sırada bekliyor";
    },
    handleRecordClick(event, { collapsedCoinSections }) {
      const toggle = event.target.closest(".coin-section-toggle");
      if (!toggle) return false;
      const sectionName = toggle.dataset.section;
      const section = toggle.closest(".coin-cards-group");
      const willCollapse = !section.classList.contains("collapsed");
      section.classList.toggle("collapsed", willCollapse);
      toggle.setAttribute("aria-expanded", String(!willCollapse));
      if (willCollapse) collapsedCoinSections.add(sectionName);
      else collapsedCoinSections.delete(sectionName);
      return true;
    },
    renderRecords({ records, errors, state, elements, helpers, collapsedCoinSections }) {
      const coinRecords = records.filter((record) => this.entryMatches(record, helpers));
      const coinErrors = errors.filter((entry) => this.entryMatches(entry, helpers));
      elements.records.innerHTML = helpers.renderCycleGroups(coinRecords, coinErrors, state, (cycleRecords, cycleErrors) =>
        renderCoinCardSections(cycleRecords, cycleErrors, true, helpers, collapsedCoinSections));
    }
  };

  function renderCoinCardSections(records, errors = [], showEmpty = true, helpers, collapsedCoinSections) {
    if (!showEmpty && !records.length && !errors.length) return "";

    const inserted = records.filter((r) => r.saveStatus === "inserted");
    const updated = records.filter((r) => r.saveStatus !== "inserted");

    const makeSection = (sectionName, label, sectionRecords, sectionErrors = [], extraClass = "") => {
      const countText = `${sectionRecords.length} kart`;
      const isCollapsed = collapsedCoinSections.has(sectionName);
      const rows = sectionRecords.length || sectionErrors.length
        ? `${sectionRecords.length ? renderCoinCardHeader(helpers) : ""}${sectionErrors.map((entry) => helpers.renderErrorRecord(entry)).join("")}${sectionRecords.map((record) => renderCoinCardRecord(record, helpers)).join("")}`
        : '<div class="coin-section-empty">Henüz kayıt yok.</div>';
      return `<div class="sync-player-group coin-cards-group ${extraClass}${isCollapsed ? " collapsed" : ""}">
      <div class="league-group sync-group-header coin-section-header">
        <button class="group-toggle coin-section-toggle" type="button" data-section="${helpers.escapeHtml(sectionName)}" aria-expanded="${String(!isCollapsed)}">
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
          <span class="sync-group-entity"><strong>${helpers.escapeHtml(label)}</strong></span>
          <span class="group-count">${helpers.escapeHtml(countText)}</span>
        </button>
      </div>
      <div class="coin-section-body">${rows}</div>
    </div>`;
    };

    return makeSection("inserted", "Yeni Kartlar", inserted, [], "section-inserted") +
      makeSection("updated", "Güncellenen Kartlar", updated, errors.slice(0, 300), "section-updated");
  }

  function renderCoinCardHeader(helpers) {
    return `<div class="club-player-header sync-header coin-card-header">
    <span>KART</span>
    <span>OYUNCU</span>
    <span class="price-header">${helpers.consolePlatformIcon()}CONSOLE</span>
    <span class="price-header">${helpers.pcPlatformIcon()}PC</span>
    <span class="date-header">İŞLEM TARİHİ</span>
  </div>`;
  }

  function renderCoinCardRecord(record, helpers) {
    const player = record.player || {};
    const fullPlayerName = String(player.name || "—");
    const shortPlayerName = Array.from(fullPlayerName).slice(0, 15).join("");
    const futbinUrl = helpers.safeFutbinUrl(player.futbinPlayerLink);
    const playerImg = player.urlImgPlayer
      ? `<img class="cc-player-img" src="${helpers.escapeHtml(player.urlImgPlayer)}" alt="" loading="lazy">`
      : `<span class="compact-placeholder">—</span>`;
    const cardCell = `<div class="grid-cell cc-card-cell">
    <div class="cc-card-wrap" ${player.urlImgCard ? `style="background-image:url('${helpers.escapeHtml(player.urlImgCard)}')"` : ""}>
      ${playerImg}
    </div>
  </div>`;
    const nation = player.urlImgNation
      ? `<img class="cc-nation-img" src="${helpers.escapeHtml(player.urlImgNation)}" alt="" loading="lazy">`
      : "";
    const playerDetails = `<div class="grid-cell cc-player-details" title="${helpers.escapeHtml(fullPlayerName)}">
    <strong>${helpers.escapeHtml(shortPlayerName)}</strong>
    <span class="cc-player-meta"><b>${helpers.escapeHtml(player.rating ?? "—")}</b>${nation}</span>
  </div>`;
    return `<article class="player-data-row sync-row coin-card-row${futbinUrl ? " is-clickable" : ""}"${helpers.syncRowLinkAttributes(futbinUrl)} title="${helpers.escapeHtml(player.name || "")}">
      ${cardCell}
      ${playerDetails}
      ${helpers.priceRangeCell(player.priceConsole, player.minPriceConsole, player.maxPriceConsole)}
      ${helpers.priceRangeCell(player.pricePc, player.minPricePc, player.maxPricePc)}
      ${helpers.processedDateCell(record.processedAt)}
    </article>`;
  }
})();
