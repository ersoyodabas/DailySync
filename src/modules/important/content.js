chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "GET_FUTBIN_PAGE_HTML") return;
  respond({ html: document.documentElement.outerHTML, url: location.href });
});
