import "./config/api.js";
import "./modules/important/background.js";
import "./modules/latest/background.js";
import "./modules/sbc_players/background.js";
import "./modules/webapp/background.js";
import "./watchdog.js";

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("index.html");
  const existing = (await chrome.tabs.query({ url: `${url}*` }))[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
});
