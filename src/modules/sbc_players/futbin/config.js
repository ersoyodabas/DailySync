export const FUTBIN_ENDPOINTS = Object.freeze({
  baseUrl: "https://www.futbin.com",
  sbcList: "/squad-building-challenges/{categoryName}",
  sbcDetail: "/squad-building-challenges/{id}",
  sbcSearch: "/squad-building-challenges/?search={query}",
  playerSearch: "/api/players/search",
  playerDetail: "/api/players/{id}",
  playerPrice: "/api/players/{id}/price",
  playerStats: "/api/players/{id}/stats",
  playerStatistics: "/api/players/{id}/stats",
  playerPriceHistory: "/api/players/{id}/price-history",
  leagueList: "/api/leagues/list",
  leagueDetail: "/api/leagues/{id}",
  nationList: "/api/nations/list",
  nationDetail: "/api/nations/{id}",
  teamList: "/api/teams/list",
  teamDetail: "/api/teams/{id}",
  squadBuild: "/api/squad/build",
  squadValidate: "/api/squad/validate",
  squadEstimatePrice: "/api/squad/estimate-price",
  priceHistory: "/api/players/{id}/price-history",
  squadPrice: "/api/squad/price"
});

export function createFutbinConfig(overrides = {}) {
  return {
    baseUrl: "https://futbin.com",
    timeoutSeconds: 20,
    tabNavigationTimeoutMs: 60000,
    maxRetries: 3,
    retryDelayMs: 1000,
    requestCooldownMs: 5000,
    minDelayMs: 100,
    maxDelayMs: 250,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    acceptLanguage: "en-US,en;q=0.9",
    throwOnHttpError: true,
    cacheDurationMinutes: 30,
    enableLogging: true,
    proxies: [],
    ...overrides
  };
}
