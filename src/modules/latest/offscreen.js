chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "PARSE_FETCHED_FUTBIN_HTML") return;
  try { respond({ ok: true, ...parseFetchedPage(message) }); }
  catch (error) { respond({ ok: false, error: error.message || String(error) }); }
  return true;
});

function parseFetchedPage(message) {
  const parsed = new DOMParser().parseFromString(message.html, "text/html");
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  if (message.operation === "coin-card-latest") {
    const rows = [...document.querySelectorAll("table.players-table tr.player-row, tr.player-row")];
    const errors = [];
    const cards = [];
    rows.forEach((row, index) => {
      try { cards.push(parseLatestCoinCardRow(row)); }
      catch (error) { errors.push({ stage: "latest-parse", message: error.message, player: { rowIndex: index + 1 } }); }
    });
    return {
      page: Number(message.page) || 1, pageUrl: message.pageUrl,
      totalPages: Number(message.latestTotalPages) || 2,
      latestCoinCards: { sourceDate: normalize(rows[0]?.querySelector(".table-added-on")?.textContent) || null, cards },
      players: [], errors
    };
  }
  if (message.operation === "coin-cards") {
    return { page: 1, pageUrl: message.pageUrl, totalPages: 1, coinCard: parseCoinCardDetail(), players: [], errors: [] };
  }
  if (Number(message.page) === 1) validateSelectedFilters(message.job);
  const rows = [...document.querySelectorAll("tr.player-row, .player-row")];
  const errors = [];
  const players = [];
  rows.forEach((row, index) => {
    try { players.push(parsePlayerRow(row)); }
    catch (error) { errors.push({ stage: "parse", message: error.message?.replace(/^\[CRITICAL\]\s*/, "") || `Oyuncu satırı okunamadı. Row: ${index + 1}`, player: { rowIndex: index + 1 } }); }
  });
  return {
    page: Number(message.page), pageUrl: message.pageUrl,
    totalPages: Number(message.page) === 1 ? extractTotalPages() : undefined,
    players, errors
  };
}
