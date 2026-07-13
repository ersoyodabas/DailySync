import { FUTBIN_ENDPOINTS, createFutbinConfig } from "./config.js";
import { FutbinHttpClient } from "./httpClient.js";
import { createFutbinLogger } from "./logger.js";
import { parseFutbinSbcHtml } from "./offscreenClient.js";
import { futbinFailure, futbinSuccess } from "./response.js";

export class FutbinSbcService {
  constructor({ config = createFutbinConfig(), httpClient = null, logger = createFutbinLogger() } = {}) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient || new FutbinHttpClient(config, logger);
  }

  cancel(reason = "SBC Players sync stopped") {
    this.httpClient.cancelAll?.(reason);
  }

  async getSbcListAsync() {
    this.logger?.info?.("Fetching SBC list from Futbin...");
    return this.httpClient.get(FUTBIN_ENDPOINTS.sbcList, { sort: "release_date", order: "desc" });
  }

  async getCategorySbcBoxesAsync(categoryName, sbcName = null) {
    if (!String(categoryName || "").trim()) return futbinFailure("Category name cannot be empty", 400);
    const actualCategoryName = sbcName && /Upgrade/i.test(sbcName) ? "Upgrades" : categoryName;
    const endpoint = `/squad-building-challenges/${String(actualCategoryName).trim()}`;
    if (String(sbcName || "").trim()) return this.searchSbcWithPaginationAsync(endpoint, sbcName);
    const queryParameters = { view: "players", sync: "true" };
    const response = await this.httpClient.get(endpoint, queryParameters, false);
    if (!response.isSuccess) return response;
    try {
      const parsed = await parseFutbinSbcHtml("category-boxes", {
        html: response.rawContent,
        endpoint,
        categoryName
      });
      const rawContent = JSON.stringify(parsed.boxes || []);
      return futbinSuccess(rawContent, 200, rawContent, response.elapsedMilliseconds, response.requestUrl);
    } catch (error) {
      return futbinFailure(`HTML parsing error: ${error.message}`, 500, response.rawContent, response.elapsedMilliseconds, response.requestUrl, error);
    }
  }

  async searchSbcWithPaginationAsync(endpoint, sbcName) {
    let maxPages = 1;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.httpClient.get(endpoint, { page }, false);
      if (!response.isSuccess) continue;
      try {
        const parsed = await parseFutbinSbcHtml("category-boxes", {
          html: response.rawContent,
          endpoint,
          categoryName: endpoint.split("/").pop(),
          sbcName
        });
        maxPages = Math.max(page, Math.min(Number(parsed.maxPage) || 1, 25));
        this.logger?.info?.("[GetFullSbcDataAsync] Category pagination parsed", {
          endpoint,
          sbcName,
          page,
          maxPages,
          totalBoxes: parsed.totalBoxes,
          matchedBoxes: (parsed.boxes || []).length
        });
        const match = (parsed.boxes || [])[0] || null;
        if (match) {
          const rawContent = JSON.stringify([match]);
          return futbinSuccess(rawContent, 200, rawContent, response.elapsedMilliseconds, response.requestUrl);
        }
      } catch (error) {
        this.logger?.warning?.(`Error parsing SBC search page ${page}: ${error.message}`);
      }
    }
    return futbinFailure(`SBC '${sbcName}' not found`, 404);
  }

  async getSbcDetailPageBoxesAsync(detailPageUrl) {
    if (!String(detailPageUrl || "").trim()) return futbinFailure("Detail page URL cannot be empty", 400);
    const response = await this.httpClient.get(detailPageUrl, {}, false);
    if (!response.isSuccess) return response;
    try {
      const parsed = await parseFutbinSbcHtml("detail-boxes", { html: response.rawContent, detailPageUrl });
      const rawContent = JSON.stringify(parsed.records || []);
      return futbinSuccess(rawContent, 200, rawContent, response.elapsedMilliseconds, response.requestUrl);
    } catch (error) {
      return futbinFailure(`HTML parsing error: ${error.message}`, 500, response.rawContent, response.elapsedMilliseconds, response.requestUrl, error);
    }
  }

  async getSbcSquadsAsync(squadsPageUrl) {
    if (!String(squadsPageUrl || "").trim()) return futbinFailure("Squads page URL cannot be empty", 400);
    const response = await this.httpClient.get(squadsPageUrl, {}, false);
    if (!response.isSuccess) return response;
    try {
      const parsed = await parseFutbinSbcHtml("squads", { html: response.rawContent, squadsPageUrl });
      const rawContent = JSON.stringify(parsed.squads || []);
      return futbinSuccess(rawContent, 200, rawContent, response.elapsedMilliseconds, response.requestUrl);
    } catch (error) {
      return futbinFailure(`HTML parsing error: ${error.message}`, 500, response.rawContent, response.elapsedMilliseconds, response.requestUrl, error);
    }
  }

  async getSbcSquadPlayersAsync(squadPageUrl) {
    if (!String(squadPageUrl || "").trim()) return futbinFailure("Squad page URL cannot be empty", 400);
    this.logger?.info?.("[GetSbcSquadPlayersAsync] Futbin squad request başlıyor", { squadPageUrl });
    const response = await this.httpClient.get(squadPageUrl, {}, false);
    this.logger?.info?.("[GetSbcSquadPlayersAsync] Futbin squad response alındı", {
      squadPageUrl,
      isSuccess: response.isSuccess,
      statusCode: response.statusCode,
      elapsedMilliseconds: response.elapsedMilliseconds,
      contentLength: String(response.rawContent || "").length,
      errorMessage: response.errorMessage || null
    });
    if (!response.isSuccess) return response;
    try {
      this.logger?.info?.("[GetSbcSquadPlayersAsync] Squad player parser başlıyor", {
        squadPageUrl,
        htmlLength: String(response.rawContent || "").length
      });
      const parsed = await parseFutbinSbcHtml("squad-players", { html: response.rawContent, squadPageUrl });
      this.logger?.info?.("[GetSbcSquadPlayersAsync] Squad player parser tamamlandı", {
        squadPageUrl,
        playerCount: parsed.players?.length || 0
      });
      const rawContent = JSON.stringify({
        squad_page_url: squadPageUrl,
        player_count: parsed.players?.length || 0,
        players: parsed.players || []
      });
      return futbinSuccess(rawContent, 200, rawContent, response.elapsedMilliseconds, response.requestUrl);
    } catch (error) {
      this.logger?.error?.("[GetSbcSquadPlayersAsync] Squad player parser hata verdi", {
        squadPageUrl,
        error: error.message || String(error),
        htmlLength: String(response.rawContent || "").length
      });
      return futbinFailure(`Data parsing error: ${error.message}`, 500, response.rawContent, response.elapsedMilliseconds, response.requestUrl, error);
    }
  }

  async getFullSbcDataAsync(categoryName, sbcName, detailSbcName, sbcNameIndex = 0, matchContext = {}) {
    if (!String(categoryName || "").trim() || !String(sbcName || "").trim()) {
      return futbinFailure("categoryName and sbcName are required", 400);
    }

    const baseUrl = "https://futbin.com";
    this.logger?.info?.("[GetFullSbcDataAsync] Started", { categoryName, sbcName, detailSbcName, sbcNameIndex, matchContext });
    this.logger?.info?.("[GetFullSbcDataAsync] Step 1: category boxes", { categoryName, sbcName });
    const categoryResponse = await this.getCategorySbcBoxesAsync(categoryName, sbcName);
    if (!categoryResponse.isSuccess) return futbinFailure(categoryResponse.errorMessage, categoryResponse.statusCode);

    let sbcBoxes;
    try {
      sbcBoxes = JSON.parse(categoryResponse.rawContent || "[]");
    } catch (error) {
      return futbinFailure(`Failed to parse category data: ${error.message}`, 500);
    }

    const matchingSbc = sbcBoxes.find((box) => containsIgnoreCase(box?.name, sbcName));
    if (!matchingSbc) return futbinFailure(`SBC box not found for name: ${sbcName}`, 404);
    if (!matchingSbc.url) return futbinFailure("Detail page URL not found in SBC box", 404);

    this.logger?.info?.("[GetFullSbcDataAsync] Step 2: detail page boxes", { matchingSbc });
    const detailResponse = await this.getSbcDetailPageBoxesAsync(matchingSbc.url);
    if (!detailResponse.isSuccess) return futbinFailure(detailResponse.errorMessage, detailResponse.statusCode);

    let detailBoxes;
    try {
      detailBoxes = JSON.parse(detailResponse.rawContent || "[]");
    } catch (error) {
      return futbinFailure(`Failed to parse detail page data: ${error.message}`, 500);
    }

    const matchingDetailRecord = selectDetailRecord(detailBoxes, detailSbcName, sbcNameIndex, matchContext);
    if (!matchingDetailRecord) {
      return futbinFailure(`Detail SBC record not found for name: ${detailSbcName}`, 404);
    }

    if (!matchingDetailRecord.squads_link) return futbinFailure("Squads link not found in detail record", 404);
    this.logger?.info?.("[GetFullSbcDataAsync] Step 3: squads", { matchingDetailRecord });
    const squadsResponse = await this.getSbcSquadsAsync(matchingDetailRecord.squads_link);
    if (!squadsResponse.isSuccess) return futbinFailure(squadsResponse.errorMessage, squadsResponse.statusCode);

    let squadsData;
    try {
      squadsData = JSON.parse(squadsResponse.rawContent || "[]");
    } catch (error) {
      return futbinFailure(`Failed to parse squads data: ${error.message}`, 500);
    }

    const firstSquad = squadsData[0] || null;
    if (!firstSquad) return futbinFailure("No squad data available", 404);
    if (!firstSquad.squad_url) return futbinFailure("Squad URL not found in squad record", 404);

    this.logger?.info?.("[GetFullSbcDataAsync] Step 4: squad players", { firstSquad });
    const playersResponse = await this.getSbcSquadPlayersAsync(firstSquad.squad_url);
    if (!playersResponse.isSuccess) return futbinFailure(playersResponse.errorMessage, playersResponse.statusCode);

    let playersPayload;
    try {
      playersPayload = JSON.parse(playersResponse.rawContent || "{}");
    } catch (error) {
      return futbinFailure(`Failed to parse players data: ${error.message}`, 500);
    }

    const playersArray = Array.isArray(playersPayload) ? playersPayload : (playersPayload.players || []);
    const squadPlayers = playersArray.map((player, index) => {
      const futbinRarity = player.futbin_rarity || "";
      return {
        index: index + 1,
        name: player.name || "",
        fullName: player.full_name || "",
        playerId: toInt(player.raw?.player_id ?? player.playerId ?? player.player_id ?? player.statsCard?.playerId),
        resourceId: toInt(player.raw?.resource_id ?? player.resourceId ?? player.resource_id ?? player.statsCard?.resourceId),
        cardId: toInt(player.raw?.card_id ?? player.cardId ?? player.card_id ?? player.statsCard?.cardId),
        baseId: toInt(player.raw?.base_id ?? player.baseId ?? player.base_id ?? player.statsCard?.baseId),
        rating: toInt(player.rating),
        position: normalizeText(first(player.possible_positions) || player.position),
        slot: player.slot || "",
        quality: player.quality || "",
        rarity: extractRarityPrefixFromFutbinRarity(futbinRarity),
        league: player.league || null,
        club: player.club || null,
        nation: player.nation || null,
        pricePc: toInt(player.price_pc ?? player.price?.pc) || 0,
        priceConsole: toInt(player.price_console ?? player.price?.console ?? player.price?.ps) || 0,
        cardBgUrl: player.card_bg_url || player.images?.card_bg_url || player.images?.background || "",
        cardPlayerImgUrl: player.card_player_img_url || player.images?.card_player_img_url || player.images?.player || "",
        futbinRarity,
        raw: player
      };
    });
    if (!squadPlayers.length) {
      return futbinFailure("Squad page parsed but no players were mapped", 404, playersResponse.rawContent, playersResponse.elapsedMilliseconds, playersResponse.requestUrl);
    }

    const data = {
      squadUrl: absolutize(firstSquad.squad_url, baseUrl),
      squadPlayers
    };
    this.logger?.info?.("[GetFullSbcDataAsync] Completed", {
      squadUrl: data.squadUrl,
      playerCount: squadPlayers.length,
      players: squadPlayers,
      rawPlayers: playersArray
    });
    return futbinSuccess(data, 200, playersResponse.rawContent, playersResponse.elapsedMilliseconds, playersResponse.requestUrl);
  }

  async getLeagueAndClubPlayersHtmlAsync(clubId, leagueId, page = 1) {
    return this.httpClient.get("/players", {
      page,
      club: clubId,
      league: leagueId,
      sort: "Player_Rating",
      eUnt: "1",
      order: "asc"
    }, false);
  }
}

export function createFutbinSbcService(options = {}) {
  return new FutbinSbcService(options);
}

function equalsIgnoreCase(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "accent" }) === 0
    || String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function containsIgnoreCase(a, b) {
  return String(a || "").toLowerCase().includes(String(b || "").toLowerCase());
}

function selectDetailRecord(detailBoxes, detailSbcName, sbcNameIndex = 0, matchContext = {}) {
  if (!Array.isArray(detailBoxes) || !detailBoxes.length) return null;
  const wantedName = normalizeComparable(detailSbcName || matchContext?.name);
  const index = Number(sbcNameIndex) || 0;
  const nameMatches = wantedName
    ? detailBoxes.filter((box) => normalizeComparable(box?.sbc_name).includes(wantedName) || wantedName.includes(normalizeComparable(box?.sbc_name)))
    : [];
  if (nameMatches.length) return nameMatches[index] || nameMatches[0];

  const scored = detailBoxes
    .map((box) => ({ box, score: detailRecordScore(box, detailSbcName, matchContext) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].box : (detailBoxes[index] || detailBoxes[0] || null);
}

function detailRecordScore(box, detailSbcName, matchContext = {}) {
  const recordName = normalizeComparable(box?.sbc_name);
  const recordDesc = normalizeComparable(box?.sbc_desc);
  const recordReward = normalizeComparable(box?.sbc_reward);
  const wantedName = normalizeComparable(detailSbcName || matchContext?.name);
  const wantedDesc = normalizeComparable(matchContext?.desc);
  const wantedReward = normalizeComparable(matchContext?.reward);
  let score = 0;
  if (wantedName && (recordName.includes(wantedName) || wantedName.includes(recordName))) score += 100;
  if (wantedDesc && recordDesc && (recordDesc.includes(wantedDesc) || wantedDesc.includes(recordDesc))) score += 45;
  if (wantedReward && recordReward && (recordReward.includes(wantedReward) || wantedReward.includes(recordReward))) score += 35;
  score += tokenOverlapScore(recordName, wantedName, 2);
  score += tokenOverlapScore(recordDesc, wantedDesc, 1);
  score += tokenOverlapScore(recordReward, wantedReward, 1);
  return score;
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlapScore(a, b, weight) {
  if (!a || !b) return 0;
  const bTokens = new Set(b.split(" ").filter((token) => token.length > 1));
  return a.split(" ").filter((token) => bTokens.has(token)).length * weight;
}

function absolutize(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value || "";
  }
}

function first(value) {
  return Array.isArray(value) ? value[0] : null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function toInt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isFinite(Number(value))) return Math.round(Number(value));
  const text = String(value).trim().toUpperCase();
  let multiplier = 1;
  let numeric = text;
  if (numeric.endsWith("K")) {
    multiplier = 1000;
    numeric = numeric.slice(0, -1);
  } else if (numeric.endsWith("M")) {
    multiplier = 1000000;
    numeric = numeric.slice(0, -1);
  }
  numeric = numeric.replace(/[^\d.,-]/g, "");
  if (!numeric) return null;
  if (numeric.includes(",") && numeric.includes(".")) numeric = numeric.replace(/,/g, "");
  else if (numeric.includes(",") && multiplier > 1) numeric = numeric.replace(",", ".");
  else numeric = numeric.replace(/,/g, "");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

function extractRarityPrefixFromFutbinRarity(futbinRarity) {
  const firstPart = String(futbinRarity || "").split("_").map((part) => part.trim()).filter(Boolean)[0];
  return firstPart || null;
}
