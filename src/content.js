let collectionInProgress = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_SYNC_PAGE") return;
  if (collectionInProgress) {
    sendResponse({ ok: true, duplicate: true });
    return;
  }
  collectionInProgress = true;
  collectAndPublish(message).finally(() => { collectionInProgress = false; });
  sendResponse({ ok: true });
});

async function collectAndPublish(message) {
  try {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (Number(navigation?.responseStatus) >= 400) {
      const result = await chrome.runtime.sendMessage({
        type: "SYNC_PAGE_FAILED",
        page: Number(message.page),
        pageUrl: location.href,
        error: `Futbin HTTP ${navigation.responseStatus}: ${location.href}`
      });
      scheduleAdvance(result);
      return;
    }
    await waitForPlayerRows(5000);
    if (Number(message.page) === 1) validateSelectedFilters(message.job);
    const rows = [...document.querySelectorAll("tr.player-row, .player-row")];
    const errors = [];
    const players = [];
    rows.forEach((row, index) => {
      try {
        players.push(parsePlayerRow(row));
      } catch (error) {
        errors.push({
          stage: "parse",
          message: error.message?.replace(/^\[CRITICAL\]\s*/, "") || `Oyuncu satırı okunamadı. Row: ${index + 1}`,
          player: { rowIndex: index + 1 }
        });
      }
    });
    const totalPages = Number(message.page) === 1 ? extractTotalPages() : undefined;
    const result = await chrome.runtime.sendMessage({
      type: "SYNC_PAGE_RESULT",
      page: Number(message.page),
      pageUrl: location.href,
      totalPages,
      players,
      errors
    });
    scheduleAdvance(result);
  } catch (error) {
    await chrome.runtime.sendMessage({
      type: "SYNC_PAGE_CRITICAL",
      page: Number(message.page),
      pageUrl: location.href,
      error: error.message?.includes("[CRITICAL]") ? error.message : `[CRITICAL] ${error.message || error}`
    }).catch(() => {});
  }
}

function scheduleAdvance(result) {
  if (result?.action !== "WAIT_AND_ADVANCE" || !result.nextUrl) return;
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "ADVANCE_SYNC", url: result.nextUrl }).catch(() => {});
  }, Math.max(0, Number(result.waitMs) || 0));
}

function waitForPlayerRows(timeoutMs) {
  if (document.querySelector("tr.player-row, .player-row")) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (document.querySelector("tr.player-row, .player-row") || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function validateSelectedFilters(job) {
  const filterNodes = [...document.querySelectorAll(".selected-filters-wrapper a")];
  if (!filterNodes.length) {
    throw new Error(`[CRITICAL] Seçili filtreler bulunamadı. League: '${job.league_name}', Club: '${job.club_name}'`);
  }
  const filterTexts = filterNodes.map((node) => normalize(node.textContent));
  const leagueExists = filterTexts.some((text) => sameText(text, job.league_name));
  const clubExists = filterTexts.some((text) => sameText(text, job.club_name));
  if (!leagueExists || !clubExists) {
    throw new Error(`[CRITICAL] Futbin filtreleri uyuşmuyor. Beklenen League: '${job.league_name}', Club: '${job.club_name}'. Gelen: ${filterTexts.join(", ")}`);
  }
}

function extractTotalPages() {
  const wrapper = document.querySelector(".pagination-buttons-wrapper");
  if (!wrapper) return 1;
  const pages = [...wrapper.querySelectorAll("a, span")]
    .map((node) => Number(normalize(node.textContent)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return pages.length ? Math.max(...pages) : 1;
}

function parsePlayerRow(row) {
  const linkNode = row.querySelector("a.player-row-playercard");
  const href = linkNode?.getAttribute("href") || "";
  if (!href) throw new Error("[CRITICAL] Player link node (href) bulunamadı!");
  const playerLink = new URL(href, "https://www.futbin.com").href;
  const idMatch = playerLink.match(/\/player\/(\d+)/);
  if (!idMatch) throw new Error(`[CRITICAL] Futbin ID ayrıştırılamadı! URL: ${playerLink}`);

  const name = readText(row, "a.table-player-name");
  if (!name) throw new Error(`[CRITICAL] Oyuncu ismi okunamadı! ID: ${idMatch[1]}`);

  const rating = integerFromText(readText(row, ".table-rating .rating-square") || readText(row, ".table-rating"));
  if (!rating) throw new Error(`[CRITICAL] Rating okunamadı! Oyuncu: ${name} (${idMatch[1]})`);

  const fallbackPriceNode = row.querySelector(".table-price .price");
  const consolePriceNode = row.querySelector(".platform-ps-only .price") || fallbackPriceNode;
  const pcPriceNode = row.querySelector(".platform-pc-only .price") || fallbackPriceNode;
  if (!consolePriceNode || !pcPriceNode) throw new Error(`[CRITICAL] Fiyat düğümü bulunamadı! Oyuncu: ${name}`);

  const nationImage = row.querySelector("img.nation, .table-player-nation img");
  const nationName = normalize(nationImage?.getAttribute("title") || nationImage?.getAttribute("alt"));
  if (!nationName) throw new Error(`[CRITICAL] Ulus ismi okunamadı! Oyuncu: ${name}`);

  const positionName = readText(row, ".table-pos .table-pos-main span") || readText(row, ".table-pos-main");
  if (!positionName) throw new Error(`[CRITICAL] Pozisyon ismi okunamadı! Oyuncu: ${name}`);

  const cardImage = row.querySelector("img.playercard-s-26-bg, img[class*='playercard'][class*='bg'], img[src*='/cards/']");
  const cardImageUrl = cardImage?.currentSrc || cardImage?.src || "";
  if (!cardImageUrl) throw new Error(`[CRITICAL] Kart görseli bulunamadı! Oyuncu: ${name}`);

  const playerImage = row.querySelector(".table-name img.playercard-s-base-img, img[class*='base-img'], img[src*='/players/']");
  const playerImageUrl = firstSrcSetUrl(playerImage?.getAttribute("srcset")) || playerImage?.currentSrc || playerImage?.src || null;
  const leagueImage = row.querySelector(".table-player-league img");
  const clubImage = row.querySelector(".table-player-club img");

  return {
    futbinPlayerId: Number(idMatch[1]),
    futbinPlayerLink: playerLink,
    name,
    rating,
    priceConsole: parseFutbinPrice(consolePriceNode.textContent),
    pricePc: parseFutbinPrice(pcPriceNode.textContent),
    nationName,
    nationImageUrl: nationImage?.currentSrc || nationImage?.src || null,
    leagueImageUrl: leagueImage?.currentSrc || leagueImage?.src || null,
    clubImageUrl: clubImage?.currentSrc || clubImage?.src || null,
    positionName,
    alternativePositions: readText(row, ".xs-font.text-faded.bold") || null,
    cardImageUrl,
    playerImageUrl
  };
}

function readText(root, selector) {
  return normalize(root.querySelector(selector)?.textContent);
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function sameText(left, right) {
  return normalize(left).localeCompare(normalize(right), undefined, { sensitivity: "accent" }) === 0;
}

function integerFromText(value) {
  const parsed = Number(String(value || "").replace(/[^\d-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFutbinPrice(value) {
  let text = normalize(value).toUpperCase();
  let multiplier = 1;
  if (text.endsWith("K")) { multiplier = 1000; text = text.slice(0, -1); }
  else if (text.endsWith("M")) { multiplier = 1000000; text = text.slice(0, -1); }
  const clean = [...text].filter((char) => /[\d.,]/.test(char)).join("").replace(",", ".");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : 0;
}

function firstSrcSetUrl(srcset) {
  const first = String(srcset || "").split(",").map((value) => value.trim()).filter(Boolean)[0];
  return first ? first.split(/\s+/)[0] : null;
}
