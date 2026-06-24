(function () {
  const actions = window.FutbinSyncActions = window.FutbinSyncActions || {};

  actions["club-players"] = {
    defaultTitle: "Futbin All Players",
    statLabel: "Club",
    hasSyncContent: true,
    stateForView: (state) => state.runs?.["club-players"] || state,
    jobMatches: (job, { isCoinCardJob }) => Boolean(job) && !isCoinCardJob(job),
    entryMatches: (entry, { isCoinCardEntry }) => !isCoinCardEntry(entry),
    saveResultMatches: (key) => !String(key).startsWith("coin-card:"),
    currentPlayers(state, activeJob) {
      return activeJob ? Object.keys(state.currentPlayers || {}).length : 0;
    },
    skippedCount(state, activeJob) {
      const savedSkipped = Object.entries(state.clubSaveResults || {})
        .filter(([key]) => this.saveResultMatches(key))
        .reduce((total, [, result]) => total + (Number(result?.skipped) || 0), 0);
      return savedSkipped + (activeJob ? Number(state.currentSkipped) || 0 : 0);
    },
    currentJobLabel({ activeJob, viewState, currentJobNumber, totalJobs }) {
      if (activeJob) return `${activeJob.league_name} / ${activeJob.club_name}`;
      if (!viewState.running || !totalJobs) return "İş bekleniyor";
      return currentJobNumber >= totalJobs ? "Bu sekme tamamlandı" : "Sırada bekliyor";
    },
    handleRecordClick(event, { collapsedLeagueGroups, collapsedClubGroups }) {
      const leagueToggle = event.target.closest(".all-players-league-toggle");
      if (leagueToggle) {
        const groupKey = leagueToggle.dataset.groupKey;
        const group = leagueToggle.closest(".all-players-league-group");
        const willCollapse = !group.classList.contains("collapsed");
        group.classList.toggle("collapsed", willCollapse);
        leagueToggle.setAttribute("aria-expanded", String(!willCollapse));
        if (willCollapse) collapsedLeagueGroups.add(groupKey);
        else collapsedLeagueGroups.delete(groupKey);
        return true;
      }

      const clubToggle = event.target.closest(".all-players-club-toggle");
      if (clubToggle) {
        const groupKey = clubToggle.dataset.groupKey;
        const group = clubToggle.closest(".all-players-club-group");
        const willCollapse = !group.classList.contains("collapsed");
        group.classList.toggle("collapsed", willCollapse);
        clubToggle.setAttribute("aria-expanded", String(!willCollapse));
        if (willCollapse) collapsedClubGroups.add(groupKey);
        else collapsedClubGroups.delete(groupKey);
        return true;
      }

      return false;
    },
    renderRecords({ records, errors, state, elements, helpers, collapsedLeagueGroups, collapsedClubGroups }) {
      const clubRecords = records.filter((record) => this.entryMatches(record, helpers));
      const clubErrors = errors.filter((entry) => this.entryMatches(entry, helpers));
      elements.records.innerHTML = helpers.renderCycleGroups(clubRecords, clubErrors, state, (cycleRecords, cycleErrors) =>
        renderClubPlayerGroups(cycleRecords, cycleErrors, state, helpers, collapsedLeagueGroups, collapsedClubGroups)) ||
        '<div class="empty">Bu sekmede henüz oyuncu verisi yok.</div>';
    }
  };

  function renderClubPlayerGroups(records, errors = [], state = {}, helpers, collapsedLeagueGroups, collapsedClubGroups) {
    if (!records.length && !errors.length) return "";

    const leagueGroups = new Map();
    const ensureLeagueGroup = (leagueName, sourceEntry = {}) => {
      const league = String(leagueName || "Lig").trim() || "Lig";
      const key = `${helpers.cycleKeyForEntry(sourceEntry)}:league:${league}`;
      if (!leagueGroups.has(key)) {
        leagueGroups.set(key, { key, league, clubs: new Map(), normal: [], errors: [], player: {} });
      }
      return leagueGroups.get(key);
    };
    const ensureClubGroup = (leagueName, clubName, clubId, sourceEntry = {}) => {
      const leagueGroup = ensureLeagueGroup(leagueName, sourceEntry);
      const club = String(clubName || "Kulüp").trim() || "Kulüp";
      const key = `${leagueGroup.league}\u0000${clubId || club}`;
      if (!leagueGroup.clubs.has(key)) {
        leagueGroup.clubs.set(key, {
          key: `${leagueGroup.key}:club:${clubId || club}`,
          league: leagueGroup.league,
          club,
          clubId,
          normal: [],
          errors: [],
          player: {}
        });
      }
      return leagueGroup.clubs.get(key);
    };

    records.slice(0, 500).forEach((record) => {
      const group = ensureClubGroup(
        record?.leagueName || record?.job?.league_name,
        record?.clubName || record?.job?.club_name,
        record?.job?.club_id || record?.clubId,
        record
      );
      group.normal.push(record);
      const player = record?.player || {};
      if (!group.player.urlImgLeague && player.urlImgLeague) group.player.urlImgLeague = player.urlImgLeague;
      if (!group.player.urlImgClub && player.urlImgClub) group.player.urlImgClub = player.urlImgClub;
      const leagueGroup = ensureLeagueGroup(group.league, record);
      leagueGroup.normal.push(record);
      if (!leagueGroup.player.urlImgLeague && player.urlImgLeague) leagueGroup.player.urlImgLeague = player.urlImgLeague;
    });
    errors.slice(0, 300).forEach((entry) => {
      const group = ensureClubGroup(entry?.leagueName, entry?.clubName, entry?.clubId, entry);
      group.errors.push(entry);
      ensureLeagueGroup(group.league, entry).errors.push(entry);
    });

    return [...leagueGroups.values()]
      .sort((left, right) => left.league.localeCompare(right.league, "tr"))
      .map((leagueGroup) => {
        const clubs = [...leagueGroup.clubs.values()]
          .sort((left, right) => left.club.localeCompare(right.club, "tr"));
        const leagueStats = aggregateClubStats(clubs, state);
        const clubRows = clubs.map((clubGroup) => {
          const clubStats = clubGroupStats(clubGroup, state);
          const isClubCollapsed = collapsedClubGroups.has(clubGroup.key);
          const rows = [
            `<div class="club-group sync-group-header all-players-club-header">
            <button class="group-toggle all-players-club-toggle" type="button" data-group-key="${helpers.escapeHtml(clubGroup.key)}" aria-expanded="${String(!isClubCollapsed)}">
              <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
              <span class="sync-group-entity">${groupEntityImage(clubGroup.player.urlImgClub, clubGroup.club, helpers)}<strong>${helpers.escapeHtml(clubGroup.club)}</strong></span>
              <span class="group-count">${helpers.escapeHtml(groupStatsText(clubStats))}</span>
            </button>
          </div>`,
            `<div class="all-players-club-body">${renderPlayerHeader(helpers)}${clubGroup.errors.map((entry) => helpers.renderErrorRecord(entry)).join("")}${clubGroup.normal.map((record) => renderPlayerRecord(record, helpers)).join("")}</div>`
          ];
          return `<div class="sync-player-group all-players-club-group${isClubCollapsed ? " collapsed" : ""}">${rows.join("")}</div>`;
        }).join("");
        const isLeagueCollapsed = collapsedLeagueGroups.has(leagueGroup.key);

        return `<div class="sync-player-group all-players-league-group${isLeagueCollapsed ? " collapsed" : ""}">
        <div class="league-group sync-group-header all-players-league-header">
          <button class="group-toggle all-players-league-toggle" type="button" data-group-key="${helpers.escapeHtml(leagueGroup.key)}" aria-expanded="${String(!isLeagueCollapsed)}">
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
            <span class="sync-group-entity">${groupEntityImage(leagueGroup.player.urlImgLeague, leagueGroup.league, helpers)}<strong>${helpers.escapeHtml(leagueGroup.league)}</strong></span>
            <span class="group-count">${helpers.escapeHtml(groupStatsText({ ...leagueStats, clubs: clubs.length }))}</span>
          </button>
        </div>
        <div class="all-players-league-body">${clubRows}</div>
      </div>`;
      }).join("");
  }

  function aggregateClubStats(clubs = [], state = {}) {
    return clubs.reduce((stats, club) => {
      const clubStats = clubGroupStats(club, state);
      return {
        records: stats.records + clubStats.records,
        errors: stats.errors + clubStats.errors,
        inserted: stats.inserted + clubStats.inserted,
        updated: stats.updated + clubStats.updated,
        deleted: stats.deleted + clubStats.deleted
      };
    }, { records: 0, errors: 0, inserted: 0, updated: 0, deleted: 0 });
  }

  function clubGroupStats(group = {}, state = {}) {
    const saveStatusStats = (group.normal || []).reduce((stats, record) => {
      if (record?.saveStatus === "inserted") stats.inserted++;
      else if (record?.saveStatus === "updated") stats.updated++;
      return stats;
    }, { inserted: 0, updated: 0 });
    const saveResult = currentRunSaveResultForClub(group, state);

    return {
      records: group.normal?.length || 0,
      errors: group.errors?.length || 0,
      inserted: saveResult ? Number(saveResult.inserted) || 0 : saveStatusStats.inserted,
      updated: saveResult ? Number(saveResult.updated) || 0 : saveStatusStats.updated,
      deleted: saveResult ? Number(saveResult.deleted) || 0 : 0
    };
  }

  function currentRunSaveResultForClub(group = {}, state = {}) {
    if (group.clubId == null || !state?.runStartedAt) return null;
    const groupRunStartedAt = (group.normal || []).find((record) => record?.runStartedAt)?.runStartedAt;
    if (Number(groupRunStartedAt) !== Number(state.runStartedAt)) return null;
    return state.clubSaveResults?.[String(group.clubId)] || null;
  }

  function groupStatsText(stats = {}) {
    const parts = [];
    if (stats.clubs != null) parts.push(`${Number(stats.clubs) || 0} kulüp`);
    parts.push(`${Number(stats.records) || 0} okunan`);
    if (Number(stats.inserted)) parts.push(`${Number(stats.inserted)} yeni`);
    if (Number(stats.updated)) parts.push(`${Number(stats.updated)} güncellendi`);
    if (Number(stats.deleted)) parts.push(`${Number(stats.deleted)} silindi`);
    if (Number(stats.errors)) parts.push(`${Number(stats.errors)} hata`);
    return parts.join(" · ");
  }

  function renderPlayerHeader(helpers) {
    return `<div class="club-player-header sync-header"><span>POS</span><span>NAME</span><span>QUALITY</span><span>RARITY</span><span>RATING</span><span>LEAGUE</span><span>CLUB</span><span>NATION</span><span class="price-header">Price${helpers.playstationIcon()}</span></div>`;
  }

  function groupEntityImage(imageUrl, name, helpers) {
    return imageUrl ? `<img class="sync-group-icon" src="${helpers.escapeHtml(imageUrl)}" alt="" title="${helpers.escapeHtml(name)}" loading="lazy">` : "";
  }

  function renderPlayerRecord(record, helpers) {
    const player = record.player || {};
    const futbinUrl = helpers.safeFutbinUrl(player.futbinPlayerLink);
    return `<article class="player-data-row sync-row${futbinUrl ? " is-clickable" : ""}"${helpers.syncRowLinkAttributes(futbinUrl)} title="${helpers.escapeHtml(player.name || "")}">
      ${helpers.cell(player.positionName, "position-cell")}
      ${helpers.cell(player.name, "player-cell")}
      ${helpers.imageCell(player.qualityImageUrl || player.urlImgCard, player.qualityCode, "quality-cell")}
      ${helpers.imageCell(player.urlImgCard, rarityTooltip(player), `rarity-cell${isCommonRarity(player) ? " is-common" : ""}`)}
      ${helpers.cell(player.rating, "rating-cell")}
      ${helpers.assetCell("", player.urlImgLeague, "league-cell")}
      ${helpers.assetCell("", player.urlImgClub, "club-cell")}
      ${helpers.assetCell("", player.urlImgNation, "nation-cell")}
      ${helpers.priceCell(player.priceConsole)}
    </article>`;
  }

  function rarityTooltip(player) {
    const id = player.rarityFutbinId ?? "—";
    const name = player.rarityCardName || player.rarityName || player.rarityCode || "—";
    return `ID: ${id} · Name: ${name}`;
  }

  function isCommonRarity(player) {
    return Number(player.rarityFutbinId) === 0 || String(player.rarityCode || "").toLowerCase() === "common";
  }
})();
