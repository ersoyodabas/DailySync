chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "SBC_PLAYERS_PARSE_FUTBIN_HTML") return false;
  try {
    respond({ ok: true, ...parseFutbinHtml(message) });
  } catch (error) {
    respond({ ok: false, error: error.message || String(error) });
  }
  return true;
});

function parseFutbinHtml(message) {
  const doc = new DOMParser().parseFromString(message.html || "", "text/html");
  switch (message.operation) {
    case "category-boxes":
      return parseCategoryBoxes(doc, message.sbcName);
    case "detail-boxes":
      return { records: parseDetailBoxes(doc) };
    case "squads":
      return { squads: parseSquads(doc) };
    case "squad-players":
      return { players: parseSquadPlayers(doc, message.html || "", message.squadPageUrl) };
    default:
      throw new Error(`Bilinmeyen SBC Players parse operation: ${message.operation}`);
  }
}

function parseCategoryBoxes(doc, sbcName = null) {
  const container = doc.querySelector("div.sbc-cards-parent");
  if (!container) throw new Error("SBC container not found in HTML");
  const boxes = [...container.children].map((box) => {
    const link = box.querySelector("a[href]");
    if (!link) return null;
    const nameElement = link.querySelector(".s-column .og-card-wrapper-top div div");
    const name = normalize(nameElement?.textContent) || "Unknown";
    const url = link.getAttribute("href") || "";
    if (!url) return null;
    return { name, url };
  }).filter(Boolean);
  if (!boxes.length) throw new Error("No valid SBC data extracted");
  const filteredBoxes = sbcName
    ? boxes.filter((box) => equalsIgnoreCase(box.name, sbcName) || containsIgnoreCase(box.name, sbcName))
    : boxes;
  return {
    boxes: filteredBoxes,
    maxPage: extractMaxPaginationPage(doc),
    totalBoxes: boxes.length
  };
}

function extractMaxPaginationPage(doc) {
  const hrefPages = [...doc.querySelectorAll("a[href]")]
    .map((element) => element.getAttribute("href") || "")
    .map((href) => href.match(/[?&]page=(\d+)/i)?.[1])
    .filter(Boolean);
  const textPages = [...doc.querySelectorAll("[class*='pagination'] a, [class*='pagination'] button, nav a, nav button")]
    .map((element) => normalize(element.textContent))
    .filter((text) => /^\d+$/.test(text));
  const pageNumbers = [...hrefPages, ...textPages]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 100);
  return pageNumbers.length ? Math.max(...pageNumbers) : 1;
}

function parseDetailBoxes(doc) {
  const primaryNodes = [...doc.querySelectorAll(".widthControl.mainPagePadding main .challenges-wrapper .column")];
  const fallbackNodes = [...doc.querySelectorAll(".challenges-wrapper [class*='column'], .challenges-wrapper [class*='sbc'], .challenges-wrapper [class*='card']")];
  const globalNodes = [...doc.querySelectorAll("a[href]")]
    .filter((link) => /completed challenges/i.test(normalize(link.textContent)) || /completed|solutions|squads/i.test(link.getAttribute("href") || ""))
    .map((link) => link.closest(".column, [class*='sbc'], [class*='card'], li, tr, div"))
    .filter(Boolean);
  const nodes = uniqueNodes([...primaryNodes, ...fallbackNodes, ...globalNodes]);
  const records = uniqueDetailRecords(nodes.map(parseDetailRecord).filter(Boolean));
  if (!records.length) {
    throw new Error(`No valid SBC detail records extracted. diagnostics=${JSON.stringify({
      title: normalize(doc.title),
      challengesWrapperCount: doc.querySelectorAll(".challenges-wrapper").length,
      primaryNodeCount: primaryNodes.length,
      fallbackNodeCount: fallbackNodes.length,
      globalNodeCount: globalNodes.length,
      completedLinkCount: [...doc.querySelectorAll("a[href]")].filter((link) => /completed challenges/i.test(normalize(link.textContent))).length,
      squadLinkCount: [...doc.querySelectorAll("a[href]")].filter((link) => /completed|solutions|squads/i.test(link.getAttribute("href") || "")).length,
      bodyText: normalize(doc.body?.textContent).slice(0, 220)
    })}`);
  }
  return records;
}

function uniqueNodes(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    return true;
  });
}

function parseDetailRecord(sbcDiv) {
  const cardText = normalize(sbcDiv.textContent);
  const nameCandidates = [
    sbcDiv.querySelector(".og-card-wrapper-top .xxs-font.bold")?.textContent,
    sbcDiv.querySelector(".og-card-wrapper-top [class*='bold']")?.textContent,
    sbcDiv.querySelector("[class*='title']")?.textContent,
    sbcDiv.querySelector("[class*='sbc-name']")?.textContent,
    sbcDiv.querySelector("h1, h2, h3, h4")?.textContent,
    firstUsefulLine(cardText)
  ].map(normalize).filter(isUsefulDetailName);
  const completedChallengesLink = findCompletedChallengesLink(sbcDiv);
  const nestedSquadsLinkElement = completedChallengesLink
    || sbcDiv.querySelector(".sbc-box-bottom a.og-button.og-button-dark[href]")
    || sbcDiv.querySelector("a[href*='squad-building-challenges'][href*='squads']")
    || sbcDiv.querySelector("a[href*='completed']")
    || sbcDiv.querySelector("a[href*='solutions']")
    || sbcDiv.querySelector("a[href*='/squads']");
  const squadsLinkElement = nestedSquadsLinkElement || (sbcDiv.matches?.("a[href]") ? sbcDiv : null);
  const squadsLink = normalize(squadsLinkElement?.getAttribute?.("href"));
  if (!squadsLink) return null;
  const sbcName = nameCandidates[0] || normalize(squadsLink.split("/").filter(Boolean).slice(-2, -1)[0]) || "Unknown";
  const sbcDesc = extractDetailDescription(sbcDiv, cardText);
  const sbcReward = extractDetailReward(sbcDiv, cardText);
  const sbcPrice = normalize(sbcDiv.querySelector(".sbc-box-front .xxs-row.bold span")?.textContent)
    || normalize(sbcDiv.querySelector("[class*='price']")?.textContent)
    || "Unknown";
  return {
    sbc_name: sbcName,
    sbc_desc: sbcDesc,
    sbc_reward: sbcReward,
    sbc_price: sbcPrice,
    squads_link: squadsLink,
    completed_button_text: normalize(completedChallengesLink?.textContent)
  };
}

function findCompletedChallengesLink(root) {
  const links = [...root.querySelectorAll("a[href]")];
  return links.find((link) => normalize(link.textContent).toLowerCase().includes("completed challenges"))
    || links.find((link) => /completed|solutions|squads/i.test(link.getAttribute("href") || ""))
    || null;
}

function isUsefulDetailName(value) {
  const text = normalize(value);
  if (!text) return false;
  return !/^(info|reward|completed challenges|start challenge)$/i.test(text);
}

function firstUsefulLine(text) {
  return normalize(text)
    .split(/(?=Reward\b|Completed Challenges\b|Start Challenge\b|INFO\b)/i)[0]
    .replace(/\bINFO\b.*$/i, "")
    .trim();
}

function extractDetailDescription(root, cardText) {
  const explicit = [...root.querySelectorAll("p, [class*='desc'], [class*='description']")]
    .map((node) => normalize(node.textContent))
    .find((text) => /^exchange\b/i.test(text));
  if (explicit) return explicit;
  const match = normalize(cardText).match(/\bExchange\b.*?(?=(?:\s+[0-9.]+K|\s+Completed Challenges|\s+Start Challenge|$))/i);
  return normalize(match?.[0]);
}

function extractDetailReward(root, cardText) {
  const rewardNode = [...root.querySelectorAll("[class*='reward'], .sbc-reward")]
    .map((node) => normalize(node.textContent))
    .find((text) => text && !/^reward$/i.test(text));
  if (rewardNode) return rewardNode.replace(/^Reward\s*/i, "").trim();
  const match = normalize(cardText).match(/\bReward\b\s*(.*?)(?=\bExchange\b|\bCompleted Challenges\b|\bStart Challenge\b|$)/i);
  return normalize(match?.[1]);
}

function uniqueDetailRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.sbc_name}::${record.squads_link}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSquads(doc) {
  const tableBody = doc.querySelector("tbody.with-border.with-background.table-xs-rows");
  if (!tableBody) throw new Error("Squad table not found in HTML");
  const squads = [...tableBody.querySelectorAll(":scope > tr")].map((row) => {
    const cells = [...row.querySelectorAll(":scope > td")];
    if (cells.length < 6) return null;
    const link = row.querySelector("td.bold a[href]");
    const squadUrl = link?.getAttribute("href") || "";
    if (!squadUrl) return null;
    return {
      cross_price: normalize(cells[4]?.querySelector("div")?.textContent) || "Unknown",
      ps_price: normalize(cells[5]?.querySelector("div")?.textContent) || "Unknown",
      squad_url: squadUrl,
      formation: squadUrl
    };
  }).filter(Boolean);
  if (!squads.length) throw new Error("No valid squad data extracted");
  return squads;
}

function parseSquadPlayers(doc, html, squadPageUrl) {
  const reactJsonData = extractReactJsonFromHtml(doc, html);
  const embeddedPlayers = collectEmbeddedSquadPlayers(doc, html);
  if (!reactJsonData && !embeddedPlayers.length) throw new Error("React JSON data not found in HTML");
  const squadData = getToken(reactJsonData, "data.squadData.squad")
    || getToken(reactJsonData, "squadData.squad")
    || findSquadArrayDeep(reactJsonData);
  if ((!Array.isArray(squadData) || !squadData.length) && embeddedPlayers.length) {
    return embeddedPlayers.slice(0, 11).map((player, index) => buildFutbinSquadPlayerObject(player, index + 1, extractEmbeddedSlot(player)));
  }
  if (!Array.isArray(squadData) || !squadData.length) throw new Error("No squad data found");
  const slotMap = buildSlotMap(reactJsonData);
  let currentSlot = null;
  let playerIndex = 1;
  const players = [];
  squadData.forEach((item) => {
    const rawValue = item?.value;
    const cardKey = String(rawValue || "").trim().toLowerCase();
    const mappedSlot = cardKey ? slotMap.get(cardKey) : null;
    if (!isSquadPlayerItem(item)) {
      if (mappedSlot) currentSlot = mappedSlot;
      return;
    }
    players.push(buildFutbinSquadPlayerObject(item, playerIndex, currentSlot));
    playerIndex += 1;
    currentSlot = null;
  });
  if (players.length) return players.slice(0, 11);
  if (embeddedPlayers.length) {
    return embeddedPlayers.slice(0, 11).map((player, index) => buildFutbinSquadPlayerObject(player, index + 1, extractEmbeddedSlot(player)));
  }
  throw new Error(`No valid player data extracted for page '${squadPageUrl || ""}'`);
}

function extractReactJsonFromHtml(doc, html) {
  const scripts = [
    ...doc.querySelectorAll("script[type='application/json'][data-react-data]"),
    ...doc.querySelectorAll("script#__NEXT_DATA__"),
    ...doc.querySelectorAll("script[type='application/json']")
  ];
  for (const script of uniqueNodes(scripts)) {
    const parsed = parseJsonScript(script.textContent);
    if (hasSquadPlayers(parsed)) return parsed;
  }
  const regex = /<script\b(?=[^>]*\btype\s*=\s*["']application\/json["'])(?=[^>]*\bdata-react-data(?:\s*=\s*["'][^"']*["'])?)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const parsed = parseJsonScript(match[1]);
    if (hasSquadPlayers(parsed)) return parsed;
  }
  const nextDataRegex = /<script\b(?=[^>]*\bid\s*=\s*["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i;
  const nextDataMatch = nextDataRegex.exec(html || "");
  const nextDataParsed = nextDataMatch ? parseJsonScript(nextDataMatch[1]) : null;
  if (hasSquadPlayers(nextDataParsed)) return nextDataParsed;

  for (const parsed of extractJsonObjectsFromScriptText(doc)) {
    if (hasSquadPlayers(parsed)) return parsed;
  }
  return null;
}

function hasSquadPlayers(value) {
  return !!value && (
    Array.isArray(getToken(value, "data.squadData.squad"))
    || Array.isArray(getToken(value, "squadData.squad"))
    || Array.isArray(findSquadArrayDeep(value))
  );
}

function extractJsonObjectsFromScriptText(doc) {
  const parsed = [];
  const scripts = [...doc.querySelectorAll("script:not([type]), script[type='text/javascript'], script[type='application/javascript']")];
  scripts.forEach((script) => {
    const text = script.textContent || "";
    const nextChunks = [...text.matchAll(/self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g)];
    nextChunks.forEach((match) => {
      const chunk = parseJsonScript(match[1]);
      const flattened = JSON.stringify(chunk || "");
      const embedded = extractBalancedJsonObjects(flattened);
      embedded.forEach((candidate) => {
        const obj = parseJsonScript(candidate);
        if (obj) parsed.push(obj);
      });
    });
    extractBalancedJsonObjects(text).forEach((candidate) => {
      const obj = parseJsonScript(candidate);
      if (obj) parsed.push(obj);
    });
  });
  return parsed;
}

function extractBalancedJsonObjects(text) {
  const result = [];
  const source = String(text || "");
  const seeds = ["squadData", "statsCard", "playerName", "playerRating"];
  seeds.forEach((seed) => {
    let fromIndex = 0;
    while (fromIndex < source.length) {
      const seedIndex = source.indexOf(seed, fromIndex);
      if (seedIndex < 0) break;
      const start = source.lastIndexOf("{", seedIndex);
      if (start >= 0) {
        const objectText = readBalanced(source, start, "{", "}");
        if (objectText) result.push(unescapeScriptJson(objectText));
      }
      fromIndex = seedIndex + seed.length;
    }
  });
  return [...new Set(result)].slice(0, 25);
}

function readBalanced(source, start, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return "";
}

function unescapeScriptJson(value) {
  return String(value || "")
    .replace(/\\"/g, "\"")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\\//g, "/");
}

function parseJsonScript(value) {
  try {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value || "";
    return JSON.parse(textarea.value);
  } catch {
    return null;
  }
}

function collectEmbeddedSquadPlayers(doc, html) {
  const roots = [];
  const scripts = [...doc.querySelectorAll("script")];
  scripts.forEach((script) => {
    const text = script.textContent || "";
    const parsedDirect = parseJsonScript(text);
    if (parsedDirect) roots.push(parsedDirect);
    extractJsonParsePayloads(text).forEach((payload) => {
      const parsed = parseJsonScript(payload) || parseJsonScript(unescapeScriptJson(payload));
      if (parsed) roots.push(parsed);
    });
    extractWindowStatePayloads(text).forEach((payload) => {
      const parsed = parseJsonLike(payload);
      if (parsed) roots.push(parsed);
    });
    extractBalancedJsonObjects(text).forEach((payload) => {
      const parsed = parseJsonLike(payload);
      if (parsed) roots.push(parsed);
    });
  });
  extractBalancedJsonObjects(html).forEach((payload) => {
    const parsed = parseJsonLike(payload);
    if (parsed) roots.push(parsed);
  });

  const candidates = [];
  roots.forEach((root) => collectPlayerObjectsDeep(root, candidates));
  const players = dedupePlayers(candidates)
    .sort((a, b) => playerCandidateScore(b) - playerCandidateScore(a))
    .slice(0, 11)
    .map(normalizeEmbeddedPlayerObject);
  return players;
}

function extractJsonParsePayloads(text) {
  const payloads = [];
  const regex = /JSON\.parse\(\s*(["'`])([\s\S]*?)\1\s*\)/g;
  let match;
  while ((match = regex.exec(text || ""))) {
    payloads.push(decodeJsString(match[2]));
  }
  return payloads;
}

function extractWindowStatePayloads(text) {
  const payloads = [];
  const regex = /(?:window\.)?(?:__INITIAL_STATE__|__NEXT_DATA__|__APOLLO_STATE__|__NUXT__|__REACT_QUERY_STATE__)\s*=\s*({[\s\S]*?})\s*;?/g;
  let match;
  while ((match = regex.exec(text || ""))) {
    payloads.push(match[1]);
  }
  return payloads;
}

function parseJsonLike(value) {
  const direct = parseJsonScript(value);
  if (direct) return direct;
  const normalized = String(value || "")
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, "$1\"$2\":")
    .replace(/'/g, "\"")
    .replace(/,\s*([}\]])/g, "$1");
  return parseJsonScript(normalized);
}

function decodeJsString(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/"/g, "\\\"")}"`);
  } catch {
    return String(value || "")
      .replace(/\\"/g, "\"")
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
}

function collectPlayerObjectsDeep(root, output, seen = new Set()) {
  if (!root || typeof root !== "object" || seen.has(root)) return;
  seen.add(root);
  if (isEmbeddedPlayerObject(root)) output.push(root);
  if (Array.isArray(root)) {
    root.forEach((item) => collectPlayerObjectsDeep(item, output, seen));
    return;
  }
  Object.keys(root).forEach((key) => collectPlayerObjectsDeep(root[key], output, seen));
}

function isEmbeddedPlayerObject(value) {
  if (!value || typeof value !== "object") return false;
  const name = getDeepString(value, [
    "playerName",
    "statsCard.cardname",
    "statsCard.cardName",
    "name",
    "commonName"
  ]);
  if (!name) return false;
  const id = getDeepInt(value, [
    "resourceId",
    "playerId",
    "assetId",
    "id",
    "statsCard.resourceId",
    "statsCard.playerId",
    "statsCard.assetId"
  ]);
  const rating = getDeepInt(value, ["playerRating", "rating", "statsCard.rating"]);
  const image = getEmbeddedImageUrl(value);
  return Boolean(id || rating || image);
}

function dedupePlayers(players) {
  const seen = new Set();
  return players.filter((player) => {
    const key = getDeepInt(player, ["resourceId", "playerId", "assetId", "id", "statsCard.resourceId", "statsCard.playerId", "statsCard.assetId"])
      || `${getDeepString(player, ["playerName", "statsCard.cardname", "statsCard.cardName", "name"])}::${getDeepInt(player, ["playerRating", "rating", "statsCard.rating"])}::${getEmbeddedImageUrl(player)}`;
    if (!key || seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function playerCandidateScore(player) {
  let score = 0;
  if (getDeepString(player, ["playerName", "statsCard.cardname", "statsCard.cardName"])) score += 20;
  if (getDeepInt(player, ["resourceId", "playerId", "assetId", "statsCard.resourceId", "statsCard.playerId"])) score += 20;
  if (getDeepInt(player, ["playerRating", "rating", "statsCard.rating"])) score += 15;
  if (extractEmbeddedSlot(player)) score += 15;
  if (getEmbeddedImageUrl(player)) score += 10;
  if (getDeepString(player, ["club.name", "statsCard.clubImage.name"])) score += 5;
  if (getDeepString(player, ["nation.name", "statsCard.nationImage.name"])) score += 5;
  if (getDeepString(player, ["league.name", "statsCard.leagueImage.name"])) score += 5;
  return score;
}

function normalizeEmbeddedPlayerObject(player) {
  const position = extractEmbeddedSlot(player);
  const playerImage = getDeepString(player, [
    "playerImage.url.image1x",
    "playerImage.fixed.url.image1x",
    "statsCard.playerImages.playerImage.fixed.url.image1x",
    "statsCard.playerImages.playerImage.url.image1x",
    "imageUrl"
  ]);
  const cardImage = getDeepString(player, [
    "cardImage.url.image1x",
    "cardImage.fixed.url.image1x",
    "statsCard.cardImage.fixed.url.image1x",
    "statsCard.cardImage.url.image1x"
  ]);
  const cardType = getDeepString(player, ["cardType", "statsCard.cardType", "quality", "rarity"]);
  return {
    ...player,
    playerName: getDeepString(player, ["playerName", "statsCard.cardname", "statsCard.cardName", "name", "commonName"]) || "",
    playerRating: getDeepInt(player, ["playerRating", "rating", "statsCard.rating"]) || 0,
    resourceId: getDeepInt(player, ["resourceId", "statsCard.resourceId", "playerId", "assetId", "id"]),
    playerId: getDeepInt(player, ["playerId", "statsCard.playerId", "resourceId", "assetId", "id"]),
    possiblePositions: position ? [position] : getArrayStrings(player, "possiblePositions"),
    cardType,
    statsCard: {
      ...(player.statsCard || {}),
      cardname: getDeepString(player, ["statsCard.cardname", "statsCard.cardName", "playerName", "name"]) || "",
      rating: getDeepInt(player, ["statsCard.rating", "playerRating", "rating"]) || 0,
      playerId: getDeepInt(player, ["statsCard.playerId", "playerId", "resourceId", "assetId", "id"]),
      resourceId: getDeepInt(player, ["statsCard.resourceId", "resourceId", "playerId", "assetId", "id"]),
      playerPositions: position ? [position] : getArrayStrings(player, "statsCard.playerPositions"),
      imageUrl: playerImage || cardImage || "",
      cardImage: {
        ...((player.statsCard || {}).cardImage || {}),
        fixed: { url: { image1x: cardImage || "" } },
        url: { image1x: cardImage || "" }
      },
      playerImages: {
        ...((player.statsCard || {}).playerImages || {}),
        playerImage: { fixed: { url: { image1x: playerImage || "" } }, url: { image1x: playerImage || "" } }
      }
    },
    price: player.price || player.prices || {},
    club: player.club || player.team || {},
    nation: player.nation || {},
    league: player.league || {}
  };
}

function extractEmbeddedSlot(player) {
  return normalizePositionCode(getDeepString(player, [
    "position.value",
    "position",
    "slot.value",
    "slot",
    "statsCard.position",
    "statsCard.position.value",
    "possiblePositions.0.value",
    "possiblePositions.0",
    "statsCard.playerPositions.0.value",
    "statsCard.playerPositions.0"
  ]));
}

function getEmbeddedImageUrl(player) {
  return getDeepString(player, [
    "imageUrl",
    "playerImage.url.image1x",
    "playerImage.url.image2x",
    "playerImage.fixed.url.image1x",
    "cardImage.url.image1x",
    "cardImage.fixed.url.image1x",
    "statsCard.imageUrl",
    "statsCard.playerImages.playerImage.fixed.url.image1x",
    "statsCard.playerImages.playerImage.url.image1x",
    "statsCard.cardImage.fixed.url.image1x",
    "statsCard.cardImage.url.image1x"
  ]);
}

function getDeepString(token, paths) {
  for (const path of paths) {
    const value = getToken(token, path);
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      const nested = getString({ value }, "value.value", "value.name", "value.label", "value.code");
      if (nested) return nested;
      continue;
    }
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function getDeepInt(token, paths) {
  for (const path of paths) {
    const value = getToken(token, path);
    if (value === null || value === undefined || value === "") continue;
    if (Number.isFinite(Number(value))) return Math.round(Number(value));
  }
  return null;
}

function isSquadPlayerItem(item) {
  return !!item && typeof item === "object" && (
    getToken(item, "playerName") !== undefined ||
    getToken(item, "statsCard") !== undefined ||
    getToken(item, "playerRating") !== undefined ||
    getToken(item, "resourceId") !== undefined ||
    getToken(item, "assetId") !== undefined
  );
}

function isValidSquadSlot(value) {
  const validSlots = new Set([
    "GK", "CB", "LCB", "RCB", "LB", "RB", "LWB", "RWB",
    "CDM", "LCDM", "RCDM", "CM", "LCM", "RCM",
    "CAM", "LCAM", "RCAM", "LM", "RM", "LW", "RW",
    "CF", "LCF", "RCF", "ST", "LS", "RS"
  ]);
  return validSlots.has(String(value || "").trim().toUpperCase());
}

function buildSlotMap(reactJsonData) {
  const map = new Map();
  const positions = getToken(reactJsonData, "sbcChallengeRequirementData.formation.positions")
    || getToken(reactJsonData, "data.sbcChallengeRequirementData.formation.positions")
    || getToken(reactJsonData, "formationData.formations.0.positions")
    || getToken(reactJsonData, "data.formationData.formations.0.positions")
    || findFormationPositionsDeep(reactJsonData);
  if (!Array.isArray(positions)) return map;
  for (let index = 0; index + 1 < positions.length; index += 2) {
    const cardKey = positions[index]?.value;
    const slot = positions[index + 1]?.value;
    if (cardKey && isValidSquadSlot(slot)) map.set(String(cardKey).trim().toLowerCase(), String(slot).trim().toUpperCase());
  }
  return map;
}

function findSquadArrayDeep(root) {
  let best = null;
  const seen = new Set();
  walkJson(root, (value) => {
    if (!Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    const playerCount = value.filter(isSquadPlayerItem).length;
    if (playerCount > 0 && (!best || playerCount > best.playerCount)) {
      best = { array: value, playerCount };
    }
  });
  return best?.array || null;
}

function findFormationPositionsDeep(root) {
  let best = null;
  walkJson(root, (value) => {
    if (!Array.isArray(value) || value.length < 2) return;
    let pairCount = 0;
    for (let index = 0; index + 1 < value.length; index += 2) {
      if (value[index]?.value && isValidSquadSlot(value[index + 1]?.value)) pairCount += 1;
    }
    if (pairCount > 0 && (!best || pairCount > best.pairCount)) {
      best = { array: value, pairCount };
    }
  });
  return best?.array || null;
}

function walkJson(value, visitor, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visitor, seen));
    return;
  }
  Object.keys(value).forEach((key) => walkJson(value[key], visitor, seen));
}

function buildFutbinSquadPlayerObject(playerData, index, slotFallback) {
  const statsCard = getToken(playerData, "statsCard");
  let possiblePositions = getArrayStrings(playerData, "statsCard.playerPositions");
  if (!possiblePositions.length) possiblePositions = getArrayStrings(playerData, "possiblePositions");
  possiblePositions = [...new Set(possiblePositions.map(normalizePositionCode).filter(Boolean))];
  const alternativePositions = possiblePositions.slice(1);
  const cardImage1x = getString(playerData, "statsCard.cardImage.fixed.url.image1x", "statsCard.cardImage.fixed.url.day.image1x", "statsCard.cardImage.url.image1x");
  const cardImage2x = getString(playerData, "statsCard.cardImage.fixed.url.image2x", "statsCard.cardImage.fixed.url.day.image2x", "statsCard.cardImage.url.image2x");
  const playerImage1x = getString(playerData, "statsCard.playerImages.playerImage.fixed.url.image1x", "statsCard.playerImages.playerImage.url.image1x", "statsCard.imageUrl");
  const playerImage2x = getString(playerData, "statsCard.playerImages.playerImage.fixed.url.image2x", "statsCard.playerImages.playerImage.url.image2x");
  const backgroundImage = getString(playerData, "statsCard.backgroundImgUrl", "statsCard.cardImage.fixed.background", "statsCard.cardImage.background");
  const { quality: rawQuality, rarity, futbinRarity } = inferQualityAndRarity(playerData);
  const quality = rarity && rarity !== "common" && rarity !== "rare" ? "special" : rawQuality;
  const rawPc = getString(playerData, "price.pc.price", "prices.pc.price");
  const rawPs = getString(playerData, "price.ps.price", "prices.ps.price");
  const rawXbox = getString(playerData, "price.xbox.price", "prices.xbox.price");
  const rawConsole = getString(playerData, "price.console.price", "prices.console.price") || rawPs || rawXbox;
  const pcPrice = parseFutbinPrice(rawPc) || 0;
  const consolePrice = parseFutbinPrice(rawConsole) || 0;
  const psPrice = parseFutbinPrice(rawPs) || consolePrice;
  const xboxPrice = parseFutbinPrice(rawXbox) || consolePrice;
  const slot = isValidSquadSlot(slotFallback) ? normalizePositionCode(slotFallback) : "";
  const isRare = getBool(playerData, "isRare", "statsCard.isRare") ?? rarity === "rare";
  const cardBgUrl = backgroundImage || "";
  const cardPlayerImgUrl = playerImage1x || getString(playerData, "statsCard.imageUrl") || "";
  return {
    index,
    name: getString(playerData, "playerName", "statsCard.cardname", "statsCard.cardName") || "",
    full_name: getString(playerData, "statsCard.title", "fullName", "full_name") || "",
    common_name: getString(playerData, "commonName", "common_name", "statsCard.commonName", "statsCard.cardname") || "",
    rating: getInt(playerData, "playerRating", "statsCard.rating", "rating") || 0,
    position: "",
    slot,
    possible_positions: possiblePositions,
    alternative_positions: alternativePositions,
    quality,
    rarity,
    rare_type: getInt(playerData, "rareType", "rare_type", "statsCard.rareType") || 0,
    is_rare: isRare,
    futbin_rarity: futbinRarity,
    groups: getArrayStrings(playerData, "groups"),
    price: { pc: pcPrice, console: consolePrice, ps: psPrice, xbox: xboxPrice, raw_pc: rawPc || "", raw_console: rawConsole || "" },
    images: {
      card: cardImage1x || "",
      card_2x: cardImage2x || "",
      player: playerImage1x || "",
      player_2x: playerImage2x || "",
      background: backgroundImage || "",
      card_bg_url: cardBgUrl,
      card_player_img_url: cardPlayerImgUrl
    },
    nation: extractImageObject(playerData, ["nation.id", "nationId", "statsCard.nationImage.id"], ["statsCard.nationImage.fixed.name", "statsCard.nationImage.name", "nation.name"], ["statsCard.nationImage.fixed.url.image1x", "statsCard.nationImage.url.image1x", "nation.image"], ["statsCard.nationImage.fixed.url.image2x", "statsCard.nationImage.url.image2x", "nation.image_2x"]),
    club: extractImageObject(playerData, ["club.id", "clubId", "statsCard.clubImage.id"], ["statsCard.clubImage.image.fixed.name", "statsCard.clubImage.name", "club.name"], ["statsCard.clubImage.image.fixed.url.day.image1x", "statsCard.clubImage.image.fixed.url.image1x", "club.image"], ["statsCard.clubImage.image.fixed.url.day.image2x", "statsCard.clubImage.image.fixed.url.image2x", "club.image_2x"]),
    league: extractImageObject(playerData, ["league.id", "leagueId", "statsCard.leagueImage.id"], ["statsCard.leagueImage.image.fixed.name", "statsCard.leagueImage.name", "league.name"], ["statsCard.leagueImage.image.fixed.url.day.image1x", "statsCard.leagueImage.image.fixed.url.image1x", "league.image"], ["statsCard.leagueImage.image.fixed.url.day.image2x", "statsCard.leagueImage.image.fixed.url.image2x", "league.image_2x"]),
    stats: {
      pac: getInt(statsCard, "pac.value", "pac") || 0,
      sho: getInt(statsCard, "sho.value", "sho") || 0,
      pas: getInt(statsCard, "pas.value", "pas") || 0,
      dri: getInt(statsCard, "dri.value", "dri") || 0,
      def: getInt(statsCard, "def.value", "def") || 0,
      phy: getInt(statsCard, "phy.value", "phy") || 0
    },
    chemistry: {
      style: getString(playerData, "chemistry.style", "chemistryStyle", "chemStyle") || "",
      points: getInt(playerData, "chemistry.points", "chemistryPoints", "chemistry")
    },
    raw: {
      player_id: getInt(playerData, "playerId", "player_id", "statsCard.playerId"),
      resource_id: getInt(playerData, "resourceId", "resource_id", "statsCard.resourceId"),
      base_id: getInt(playerData, "baseId", "base_id", "statsCard.baseId"),
      card_id: getInt(playerData, "cardId", "card_id", "statsCard.cardId"),
      url: getString(playerData, "url", "statsCard.url") || "",
      data_url: getString(playerData, "dataUrl", "data_url", "statsCard.dataUrl") || ""
    },
    price_pc: pcPrice,
    price_console: consolePrice,
    card_bg_url: cardBgUrl,
    card_player_img_url: cardPlayerImgUrl
  };
}

function getToken(token, path) {
  if (!token || !path) return undefined;
  return String(path).split(".").filter(Boolean).reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    if (typeof current === "object") return current[part];
    return undefined;
  }, token);
}

function getString(token, ...paths) {
  for (const path of paths) {
    const value = getToken(token, path);
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (String(text || "").trim()) return String(text).trim();
  }
  return null;
}

function getInt(token, ...paths) {
  for (const path of paths) {
    const value = getToken(token, path);
    if (value === null || value === undefined) continue;
    if (Number.isFinite(Number(value))) return Math.round(Number(value));
    const parsed = parseFutbinPrice(String(value));
    if (parsed !== null) return parsed;
  }
  return null;
}

function getBool(token, ...paths) {
  for (const path of paths) {
    const value = getToken(token, path);
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (text === "true" || text === "false") return text === "true";
    if (/^-?\d+$/.test(text)) return Number(text) !== 0;
  }
  return null;
}

function getArrayStrings(token, path) {
  const array = getToken(token, path);
  if (!Array.isArray(array)) return [];
  return [...new Set(array.map((item) => {
    if (typeof item === "string" || typeof item === "number") return String(item);
    return getString({ item }, "item.position", "item.value", "item.label", "item.name", "item.title", "item.code");
  }).map((value) => String(value || "").trim()).filter(Boolean))];
}

function parseFutbinPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value).trim().toUpperCase();
  if (text === "-" || text === "N/A") return null;
  let multiplier = 1;
  if (text.endsWith("K")) {
    multiplier = 1000;
    text = text.slice(0, -1);
  } else if (text.endsWith("M")) {
    multiplier = 1000000;
    text = text.slice(0, -1);
  }
  text = text.replace(/[^\d.,-]/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) text = text.replace(/,/g, "");
  else if (text.includes(",") && multiplier > 1) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function inferQualityAndRarity(playerData) {
  let quality = normalizeText(getString(playerData, "statsCard.quality", "quality")) || "";
  let rarity = normalizeText(getString(playerData, "statsCard.rarity", "rarity")) || "";
  const urls = [
    getString(playerData, "statsCard.cardImage.fixed.url.image1x"),
    getString(playerData, "statsCard.cardImage.fixed.url.image2x"),
    getString(playerData, "statsCard.imageUrl"),
    getString(playerData, "statsCard.backgroundImgUrl"),
    getString(playerData, "cardInfo.imageUrl")
  ].filter(Boolean);
  const futbinRarity = urls.map(extractFutbinRarityFromUrl).find(Boolean) || "";
  if (!quality) quality = inferQualityFromFutbinRarity(futbinRarity) || "";
  if (!rarity) rarity = inferRarityFromFutbinRarity(futbinRarity) || "";
  return { quality, rarity, futbinRarity };
}

function extractImageObject(token, idPaths, namePaths, imagePaths, image2xPaths) {
  return {
    id: getInt(token, ...idPaths),
    name: getString(token, ...namePaths) || "",
    image: getString(token, ...imagePaths) || "",
    image_2x: getString(token, ...image2xPaths) || ""
  };
}

function extractFutbinRarityFromUrl(url) {
  if (!url) return "";
  const decoded = decodeURIComponent(String(url));
  let match = decoded.match(/\/(?:cards\/[^/]+\/|cards\/|tiny\/|hd\/)([^/?#]+)\.png/i);
  if (!match) match = decoded.match(/([^/\\?#]+)\.png(?:[?#].*)?$/i);
  return match ? match[1].trim().toLowerCase() : "";
}

function inferQualityFromFutbinRarity(futbinRarity) {
  const value = String(futbinRarity || "").toLowerCase();
  if (!value) return null;
  if (value.includes("bronze")) return "bronze";
  if (value.includes("silver")) return "silver";
  if (value.includes("gold")) return "gold";
  return "special";
}

function inferRarityFromFutbinRarity(futbinRarity) {
  const value = String(futbinRarity || "").toLowerCase();
  if (!value) return null;
  if (value.includes("tots")) return "tots";
  if (value.includes("toty")) return "toty";
  if (value.includes("totw") || value.includes("_if") || value.startsWith("3_")) return "totw";
  if (value.includes("rare") || value.startsWith("1_")) return "rare";
  if (value.includes("common") || value.startsWith("0_")) return "common";
  if (value.includes("hero")) return "hero";
  if (value.includes("icon")) return "icon";
  return "special";
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePositionCode(value) {
  return String(value || "").trim().toUpperCase();
}

function equalsIgnoreCase(a, b) {
  return normalizeText(a) === normalizeText(b);
}

function containsIgnoreCase(a, b) {
  return normalizeText(a).includes(normalizeText(b));
}
