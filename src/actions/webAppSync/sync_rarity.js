(function () {
  const modules = window.FutbinSyncWebAppModules = window.FutbinSyncWebAppModules || {};

  modules.syncRarity = async function syncRarity(lang = "en") {
    const {
      futClick,
      isElementVisible,
      normalize,
      sleep,	
      waitForVisibleElement,
      webAppLog
    } = window.FutbinSyncWebAppCore;
    const withApiLoader = createApiLoaderWrapper();

    const settingsButton = document.querySelector('button.ut-tab-bar-item.icon-settings:not(.sbc-tab-logout-btn)')
      || document.querySelector('.ut-tab-bar-item.icon-settings:not(.sbc-tab-logout-btn)')
      || document.querySelector('.icon-settings');
    if (settingsButton) {
      const text = normalize(settingsButton.innerText || settingsButton.textContent).toLowerCase();
      if (text === 'ayarlar') {
        lang = 'tr';
      } else if (text === 'settings') {
        lang = 'en';
      }
    }

    await webAppLog("RARITY", "Rarity Sync başladı.", { language: lang });
    await webAppLog("RARITY", "Veritabanındaki mevcut rarity kayıtları yükleniyor.");

    const listMessage = await withApiLoader(
      "Rarity listesi API'den yükleniyor...",
      () => chrome.runtime.sendMessage({ type: "WEB_APP_RARITY_LIST" }),
      { method: "GET", endpoint: "rarity" }
    );
    if (!listMessage?.ok || !listMessage.response?.result) {
      throw new Error(`[CRITICAL] DB rarity listesi alınamadı: ${listMessage?.error || listMessage?.response?.message || "Bilinmeyen hata"}`);
    }

    const dbRarities = Array.isArray(listMessage.response.data) ? listMessage.response.data : [];
    const dbRarityNames = new Set();
    let localizedCount = 0;
    for (const rarity of dbRarities) {
      const localizedName = rarity?.name && typeof rarity.name === "object" ? rarity.name[lang] : null;
      if (!localizedName || !String(localizedName).trim()) continue;
      dbRarityNames.add(String(localizedName).trim().toLowerCase());
      localizedCount += 1;
    }
    await webAppLog("RARITY", `Veritabanından ${dbRarities.length} rarity kaydı yüklendi.`, {
      totalCount: dbRarities.length,
      localizedCount,
      lang
    });

    const clubMenuButton = await waitForVisibleElement("button.ut-tab-bar-item.icon-club", 10000);
    if (!clubMenuButton) throw new Error("[CRITICAL] Kulüp menüsü butonu bulunamadı.");
    await webAppLog("RARITY", "Club menüsü açılıyor.");
    await futClick(clubMenuButton);
    await sleep(800);

    const playerTile = await waitForVisibleElement(".players-tile", 10000);
    if (!playerTile) throw new Error("[CRITICAL] Oyuncular tile bulunamadı.");
    await webAppLog("RARITY", "Players ekranı açılıyor.");
    await futClick(playerTile);
    await sleep(800);

    const filterButton = await waitForVisibleElement(".btn-standard", 10000);
    if (!filterButton) throw new Error("[CRITICAL] Oyuncu filtreleme butonu bulunamadı.");
    await webAppLog("RARITY", "Oyuncu filtreleri açılıyor.", {
      text: normalize(filterButton.textContent)
    });
    await futClick(filterButton);
    await sleep(600);

    const rarityLabels = lang === "tr"
      ? ["rarity", "nadirlik", "enderlik"]
      : ["rarity"];
    const rarityFilter = [...document.querySelectorAll("div.inline-list-select.ut-search-filter-control")]
      .filter(isElementVisible)
      .find((control) => {
        const label = normalize(control.querySelector("span")?.innerText || control.querySelector("span")?.textContent)
          .toLocaleLowerCase("tr-TR");
        return rarityLabels.some((rarityLabel) => label.includes(rarityLabel));
      });
    if (!rarityFilter) throw new Error("[CRITICAL] Rarity filtresi bulunamadı.");

    const inlineContainer = rarityFilter.querySelector(".inline-container");
    if (!inlineContainer) throw new Error("[CRITICAL] Rarity inline-container bulunamadı.");
    await webAppLog("RARITY", "Rarity filtresi açılıyor.");
    await futClick(inlineContainer);
    await sleep(800);

    const rarityItems = [...rarityFilter.querySelectorAll(".inline-container ul li")]
      .filter(isElementVisible);
    await webAppLog("RARITY", `Rarity taraması başladı. ${rarityItems.length} seçenek bulundu.`, {
      optionCount: rarityItems.length
    });

    const rarities = [];
    let skippedExisting = 0;
    let skippedPlaceholder = 0;
    for (const rarityItem of rarityItems) {
      const rarityName = normalize(rarityItem.innerText || rarityItem.textContent);
      if (!rarityName) continue;
      const lowerRarityName = rarityName.toLocaleLowerCase("tr-TR");
      const placeholderLabels = lang === "tr"
        ? ["any", "herhangi", "farketmez", "fark etmez"]
        : ["any"];
      if (placeholderLabels.includes(lowerRarityName)) {
        skippedPlaceholder += 1;
        await webAppLog("RARITY", "Placeholder rarity seçeneği atlandı.", { name: rarityName });
        continue;
      }
      if (dbRarityNames.has(rarityName.toLowerCase())) {
        skippedExisting += 1;
        await webAppLog("RARITY", `DB'de ${lang.toUpperCase()} adı mevcut rarity atlandı.`, { name: rarityName, lang });
        continue;
      }

      let iconUrl = rarityItem.querySelector("img")?.src || null;
      if (!iconUrl) {
        const backgroundImage = rarityItem.style?.backgroundImage || "";
        const match = backgroundImage.match(/url\((?:"|')?(.*?)(?:"|')?\)/);
        if (match?.[1]) iconUrl = match[1];
      }

      let futbinId = null;
      if (iconUrl) {
        const match = iconUrl.match(/cards_bg_e_\d+_(\d+)_0\.png/i);
        if (match?.[1]) futbinId = Number(match[1]);
      }

      rarities.push({
        name: { [lang]: rarityName },
        code: lang === "en" ? rarityName.toLowerCase() : null,
        icon_url: iconUrl,
        futbin_id: futbinId
      });
      await webAppLog("RARITY_FOUND", `Yeni rarity bulundu: ${rarityName}`, {
        name: rarityName,
        hasIcon: Boolean(iconUrl),
        futbinId
      });
    }

    const dedupedRarities = [];
    const seenNames = new Set();
    for (const rarity of rarities) {
      const lowerName = normalize(rarity.name?.[lang]).toLowerCase();
      if (!lowerName || seenNames.has(lowerName)) {
        if (lowerName) await webAppLog("RARITY", "Duplike rarity atlandı.", { name: rarity.name?.[lang] });
        continue;
      }
      seenNames.add(lowerName);
      dedupedRarities.push(rarity);
    }
    await webAppLog("RARITY_SCAN", dedupedRarities.length > 0
      ? `Rarity taraması tamamlandı. ${dedupedRarities.length} yeni rarity bulundu.`
      : "Rarity taraması tamamlandı. Yeni rarity bulunamadı.", {
      readCount: rarityItems.length,
      candidateCount: rarities.length,
      dedupedCount: dedupedRarities.length,
      skippedExisting,
      skippedPlaceholder
    });

    let saveResponse = { result: true, data: null, message: "Yeni rarity bulunamadı." };
    if (dedupedRarities.length) {
      await webAppLog("RARITY_SAVE", `${dedupedRarities.length} yeni rarity API'ye gönderiliyor.`, {
        count: dedupedRarities.length
      });
      const saveMessage = await withApiLoader(
        "Yeni rarity kayıtları API'ye gönderiliyor...",
        () => chrome.runtime.sendMessage({
          type: "WEB_APP_RARITY_BULK_SYNC",
          lang,
          rarities: dedupedRarities
        }),
        { method: "POST", endpoint: "rarity/bulk-sync" }
      );
      if (!saveMessage?.ok || !saveMessage.response?.result) {
        throw new Error(`[CRITICAL] Rarity kayıt hatası: ${saveMessage?.error || saveMessage?.response?.message || "Bilinmeyen hata"}`);
      }
      saveResponse = saveMessage.response;
      await webAppLog("RARITY_SAVE", `${dedupedRarities.length} yeni rarity başarıyla kaydedildi.`, {
        count: dedupedRarities.length,
        message: saveResponse.message || null
      });
    } else {
      await webAppLog("RARITY_COMPLETE", "Yeni rarity yok. Kayıt isteği gönderilmeden işlem tamamlandı.");
    }

    const result = {
      lang,
      dbCount: dbRarities.length,
      dbLocalizedCount: localizedCount,
      optionCount: rarityItems.length,
      skippedExisting,
      skippedPlaceholder,
      savedCount: dedupedRarities.length,
      rarities: dedupedRarities,
      apiMessage: saveResponse.message || null,
      completedAt: Date.now()
    };
    await webAppLog("RARITY_COMPLETE", result.savedCount > 0
      ? `Rarity işlemi tamamlandı. Taranan: ${result.optionCount}, yeni bulunan: ${result.savedCount}, mevcut olduğu için atlanan: ${result.skippedExisting}.`
      : `Rarity işlemi tamamlandı. Taranan: ${result.optionCount}, yeni rarity yok, mevcut olduğu için atlanan: ${result.skippedExisting}.`, result);
    return result;
  };

  function createApiLoaderWrapper() {
    return async function withApiLoader(message, task, details) {
      const loader = window.FutbinSyncWebAppApiLoader;
      if (loader?.wrap) return loader.wrap(message, task, details);
      return task();
    };
  }
})();
