const MAX_DEPTH = 12;
const MAX_NODES = 50000;
let seenObjects = new WeakSet();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.channel !== "FUTBIN_SYNC" || event.data?.type !== "RAW_JSON") return;
  processPayload(event.data.payload, event.data.source || "network");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_NOW") return;
  collectEmbeddedData();
  collectPlayerRows();
  setTimeout(collectPlayerRows, 1000);
  setTimeout(collectPlayerRows, 2500);
  sendResponse({ ok: true });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    collectEmbeddedData();
    collectPlayerRows();
  }, { once: true });
} else {
  collectEmbeddedData();
  collectPlayerRows();
}

let rowCollectionTimer;
const rowObserver = new MutationObserver((mutations) => {
  const hasPlayerRows = mutations.some(({ addedNodes }) => [...addedNodes].some((node) =>
    node.nodeType === Node.ELEMENT_NODE && (node.matches?.(".player-row") || node.querySelector?.(".player-row"))
  ));
  if (!hasPlayerRows) return;
  clearTimeout(rowCollectionTimer);
  rowCollectionTimer = setTimeout(collectPlayerRows, 250);
});
rowObserver.observe(document.documentElement, { childList: true, subtree: true });

function collectEmbeddedData() {
  document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach((script, index) => {
    try { processPayload(JSON.parse(script.textContent), `script:${script.id || index}`); } catch { /* noop */ }
  });
}

function collectPlayerRows() {
  const players = [...document.querySelectorAll(".player-row")].map(parsePlayerRow).filter((player) => player.id || player.name);
  publish(players, "dom:.player-row");
}

function parsePlayerRow(row) {
  const playerLink = row.querySelector("a.table-player-name, a.player-row-playercard");
  const href = playerLink?.getAttribute("href") || "";
  const playerImage = row.querySelector('.playercard-26 img[class*="base-img"], img[src*="/players/"]');
  const cardImage = row.querySelector('.playercard-26 img[class*="-bg"], img[src*="/cards/"]');
  const fullName = readText(row, ".table-player-name") || row.querySelector('[class*="playercard"]')?.getAttribute("title");
  const revision = readText(row, ".table-player-revision");
  const qualityName = qualityFromCardImage(cardImage?.currentSrc || cardImage?.src);
  const heightText = readText(row, ".table-height div:first-child");
  const bodyText = readText(row, ".table-height");
  const strongFootSrc = row.querySelector(".table-foot img")?.getAttribute("src") || "";

  return compactObject({
    id: numberFromMatch(href, /\/player\/(\d+)/),
    name: fullName,
    shortName: playerImage?.getAttribute("alt") || fullName,
    fullName,
    url: href ? new URL(href, location.origin).href : null,
    image: playerImage?.currentSrc || playerImage?.src || null,
    revision,
    quality: compactObject({ name: qualityName, image: cardImage?.currentSrc || cardImage?.src || null }),
    rarity: compactObject({ name: revision, image: cardImage?.currentSrc || cardImage?.src || null }),
    rating: numberFromText(readText(row, ".table-rating")),
    position: readText(row, ".table-pos-main"),
    prices: compactObject({
      playstation: priceFromText(readText(row, ".platform-ps-only .price")),
      pc: priceFromText(readText(row, ".platform-pc-only .price"))
    }),
    futbinRating: numberFromText(readText(row, ".futbin-rating-tag")),
    club: imageEntity(row, ".table-player-club", "club"),
    nation: imageEntity(row, ".table-player-nation", "nation"),
    league: imageEntity(row, ".table-player-league", "league"),
    strongFoot: strongFootSrc.match(/foot-(left|right)/i)?.[1]?.toUpperCase() || null,
    skillMoves: numberFromText(readText(row, ".table-skills")),
    weakFoot: numberFromText(readText(row, ".table-weak-foot")),
    stats: compactObject({
      pace: numberFromText(readText(row, ".table-pace")),
      shooting: numberFromText(readText(row, ".table-shooting")),
      passing: numberFromText(readText(row, ".table-passing")),
      dribbling: numberFromText(readText(row, ".table-dribbling")),
      defending: numberFromText(readText(row, ".table-defending")),
      physicality: numberFromText(readText(row, ".table-physicality"))
    }),
    popularity: numberFromText(readText(row, ".table-popularity")),
    inGameStats: numberFromText(readText(row, ".table-in-game-stats")),
    height: compactObject({
      text: heightText,
      cm: numberFromMatch(heightText, /(\d+)\s*cm/i),
      weightKg: numberFromMatch(bodyText, /\((\d+)\s*kg\)/i),
      bodyType: row.querySelector('.table-height a[href*="body_type"]')?.textContent?.trim() || null,
      accelerate: row.querySelector('.table-height a[href*="accelerate"]')?.textContent?.trim() || null
    })
  });
}

function readText(root, selector) {
  return root.querySelector(selector)?.textContent?.trim() || null;
}

function qualityFromCardImage(imageUrl) {
  if (!imageUrl) return null;
  const filename = decodeURIComponent(imageUrl).split("?")[0].split("/").pop() || "";
  const quality = filename.match(/_([a-z]+)\.(?:png|webp|jpg|jpeg)$/i)?.[1];
  return quality ? quality.charAt(0).toUpperCase() + quality.slice(1) : null;
}

function numberFromText(value) {
  if (!value) return null;
  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceFromText(value) {
  if (!value) return null;
  const match = value.trim().replace(/,/g, "").match(/([\d.]+)\s*([KM])?/i);
  if (!match) return null;
  const multiplier = match[2]?.toUpperCase() === "M" ? 1000000 : match[2]?.toUpperCase() === "K" ? 1000 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : null;
}

function numberFromMatch(value, pattern) {
  const parsed = Number(String(value || "").match(pattern)?.[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function imageEntity(row, selector, queryKey) {
  const anchor = row.querySelector(selector);
  if (!anchor) return null;
  const image = anchor.querySelector("img");
  const href = anchor.getAttribute("href") || "";
  return compactObject({
    id: numberFromMatch(href, new RegExp(`[?&]${queryKey}=(\\d+)`)),
    name: image?.getAttribute("title") || null,
    image: image?.currentSrc || image?.src || null
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""));
}

function processPayload(payload, source) {
  seenObjects = new WeakSet();
  const players = [];
  let visited = 0;

  function walk(value, depth) {
    if (depth > MAX_DEPTH || visited++ > MAX_NODES || value == null) return;
    if (typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (!Array.isArray(value) && looksLikePlayer(value)) players.push(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  }

  walk(payload, 0);
  publish(players.slice(0, 1000), source);
}

function looksLikePlayer(value) {
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  const hasIdentity = keys.some((key) => ["playerid", "player_id", "resource_id", "resourceid", "name", "playername"].includes(key));
  const signals = ["rating", "overall", "position", "nation", "league", "club", "price", "pace", "shooting"];
  return hasIdentity && signals.filter((key) => keys.some((candidate) => candidate.includes(key))).length >= 2;
}

function publish(players, source) {
  if (!players.length) return;
  console.groupCollapsed(`[Futbin Sync] ${players.length} oyuncu yakalandı (${source})`);
  console.log(JSON.stringify(players, null, 2));
  console.groupEnd();
  chrome.runtime.sendMessage({ type: "PLAYER_DATA", pageUrl: location.href, source, players }).catch(() => {});
}
