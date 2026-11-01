importScripts("platforms/jd.js", "platforms/tmall.js", "platforms/taobao.js");

const ALARM_NAME = "jd-price-monitor";
const DEFAULT_INTERVAL_MINUTES = 30;
const TAB_TIMEOUT_MS = 25000;
const DEFAULT_SEARCH_PAGES = 3;
const MAX_SEARCH_PAGES = 20;
const SEARCH_PAGE_DELAY_MS = 700;
const TAB_MESSAGE_TIMEOUT_MS = 35000;
const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const LOG_PRUNE_ALARM_NAME = "runtime-log-prune";
const MAX_RUNTIME_LOG_ENTRIES = 3000;

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await checkAllMonitors();
  else if (alarm.name === LOG_PRUNE_ALARM_NAME) await pruneRuntimeLogs();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { notificationTargets } = await chrome.storage.local.get({ notificationTargets: {} });
  const url = notificationTargets[notificationId];
  if (!url) return;
  await chrome.tabs.create({ url, active: true });
  delete notificationTargets[notificationId];
  await chrome.storage.local.set({ notificationTargets });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_PRODUCT_SELECTION") {
    startProductSelection(message.keyword, message.platform || "jd", message.pageCount)
      .then((result) => {
        // 只返回结果和目标地址；商品选择页由 popup 在收到响应后打开，
        // 避免后台激活新标签页时提前关闭 popup 的消息通道。
        sendResponse({
          ok: true,
          result,
          selectionUrl: chrome.runtime.getURL("select.html")
        });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CREATE_MONITOR") {
    createMonitorFromSelection(
      message.productIds,
      message.includeKeywords,
      message.excludeKeywords,
      message.variantRule,
      message.thresholdRules
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CHECK_ONE") {
    checkMonitor(message.id)
      .then((result) => sendResponse({ ok: true, result }))
      .catch(async (error) => {
        const { monitors } = await chrome.storage.local.get({ monitors: [] });
        const monitor = monitors.find((item) => item.id === message.id);
        await appendRuntimeLog("monitor_check_failed", {
          monitorId: message.id,
          platform: monitor?.platform || "jd",
          keyword: monitor?.keyword || "",
          error: error.message
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "GET_STATUS") {
    chrome.storage.local.get({ monitors: [] }).then(({ monitors }) => {
      sendResponse({ ok: true, monitors });
    });
    return true;
  }

  if (message?.type === "EXPORT_RUNTIME_LOGS") {
    getRecentRuntimeLogs()
      .then((logs) => sendResponse({ ok: true, logs, retentionDays: 3 }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: DEFAULT_INTERVAL_MINUTES,
      periodInMinutes: DEFAULT_INTERVAL_MINUTES
    });
  }
  const pruneAlarm = await chrome.alarms.get(LOG_PRUNE_ALARM_NAME);
  if (!pruneAlarm) {
    await chrome.alarms.create(LOG_PRUNE_ALARM_NAME, {
      delayInMinutes: 12 * 60,
      periodInMinutes: 12 * 60
    });
  }
  await pruneRuntimeLogs();
}

async function getRecentRuntimeLogs() {
  const { runtimeLogs = [] } = await chrome.storage.local.get({ runtimeLogs: [] });
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const recent = runtimeLogs.filter((entry) => Number(entry.timestamp) >= cutoff);
  if (recent.length !== runtimeLogs.length) {
    await chrome.storage.local.set({ runtimeLogs: recent });
  }
  return recent;
}

async function pruneRuntimeLogs() {
  await getRecentRuntimeLogs();
}

async function appendRuntimeLog(event, details = {}) {
  try {
    const logs = await getRecentRuntimeLogs();
    logs.push({ timestamp: Date.now(), event, ...details });
    await chrome.storage.local.set({ runtimeLogs: logs.slice(-MAX_RUNTIME_LOG_ENTRIES) });
  } catch (error) {
    console.warn("Unable to persist runtime log", error);
  }
}

async function checkAllMonitors() {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  for (const monitor of monitors) {
    try {
      await checkMonitor(monitor.id);
    } catch (error) {
      await updateMonitor(monitor.id, {
        lastCheckedAt: Date.now(),
        lastError: error.message
      });
      await appendRuntimeLog("monitor_check_failed", {
        monitorId: monitor.id,
        platform: monitor.platform || "jd",
        keyword: monitor.keyword || "",
        error: error.message
      });
    }
  }
}

async function startProductSelection(keyword, platform = "jd", requestedPageCount = DEFAULT_SEARCH_PAGES) {
  const normalizedKeyword = String(keyword || "").trim();
  if (!normalizedKeyword) throw new Error("监控关键词不能为空");
  const adapter = getPlatformAdapter(platform);
  const pageCount = normalizeSearchPageCount(requestedPageCount);

  await setSearchStatus({
    state: "searching",
    platform: adapter.id,
    keyword: normalizedKeyword,
    page: 0,
    totalPages: pageCount,
    pageStats: []
  });
  try {
    const searchResult = await searchProducts(normalizedKeyword, adapter.id, pageCount, {
      detailedDiagnostics: adapter.id === "tmall"
    });
    const products = searchResult.products;
    if (!products.length) {
      throw new Error("未读取到商品结果，可能是页面未加载或触发了平台验证");
    }

    await chrome.storage.local.set({
      selectionDraft: {
        keyword: normalizedKeyword,
        platform: adapter.id,
        pageCount,
        products,
        pagesLoaded: searchResult.pagesLoaded,
        pageStats: searchResult.pageStats,
        createdAt: Date.now()
      }
    });
    await setSearchStatus({
      state: "done",
      platform: adapter.id,
      keyword: normalizedKeyword,
      page: searchResult.pagesLoaded,
      totalPages: pageCount,
      count: products.length,
      pageStats: searchResult.pageStats
    });
    await appendRuntimeLog("product_selection_completed", {
      platform: adapter.id,
      keyword: normalizedKeyword,
      pageCount,
      pagesLoaded: searchResult.pagesLoaded,
      productCount: products.length,
      pageStats: searchResult.pageStats
    });
    return {
      count: products.length,
      pagesLoaded: searchResult.pagesLoaded,
      pageStats: searchResult.pageStats
    };
  } catch (error) {
    await appendRuntimeLog("product_selection_failed", {
      platform: adapter.id,
      keyword: normalizedKeyword,
      pageCount,
      error: error.message
    });
    await setSearchStatus({
      state: "error",
      platform: adapter.id,
      keyword: normalizedKeyword,
      error: error.message
    });
    throw error;
  }
}

async function searchProducts(keyword, platform = "jd", requestedPageCount = DEFAULT_SEARCH_PAGES, options = {}) {
  const adapter = getPlatformAdapter(platform);
  const pageCount = normalizeSearchPageCount(requestedPageCount);

  const products = [];
  const seen = new Set();
  const pageStats = [];
  const firstPageUrl = adapter.buildSearchUrl(keyword, 1);
  let searchWindow = null;
  let tabId = null;
  let activePage = 0;
  let lastPageDiagnostics = null;
  await appendRuntimeLog("search_started", {
    platform: adapter.id,
    keyword,
    pageCount,
    searchUrl: firstPageUrl
  });
  let pagesLoaded = 0;
  try {
    searchWindow = await chrome.windows.create({
      url: firstPageUrl,
      focused: false,
      state: "minimized",
      type: "popup"
    });
    tabId = searchWindow.tabs?.[0]?.id;
    if (!tabId) throw new Error("无法创建后台搜索窗口");

    for (let page = 1; page <= pageCount; page += 1) {
      activePage = page;
      await setSearchStatus({
        state: "searching",
        platform: adapter.id,
        keyword,
        page,
        totalPages: pageCount,
        pagesLoaded,
        pageStats
      });
      if (page > 1) {
        if (adapter.pageNavigation === "url") {
          await chrome.tabs.update(tabId, { url: adapter.buildSearchUrl(keyword, page) });
          await waitForTabComplete(tabId);
        } else {
          const pageResponse = await sendTabMessage(tabId, {
            type: "GO_TO_SEARCH_PAGE",
            platform: adapter.id,
            page
          });
          if (!pageResponse?.ok) {
            throw new Error(pageResponse?.error || `未能切换到${adapter.name}第 ${page} 页`);
          }
        }
      } else {
        await waitForTabComplete(tabId);
      }

      const response = await sendTabMessage(tabId, {
        type: "READ_SEARCH_RESULTS",
        platform: adapter.id,
        expectedPage: page
      });
      lastPageDiagnostics = response?.pageDiagnostics || null;
      if (!Array.isArray(response?.products)) {
        await appendRuntimeLog("search_page_failed", {
          platform: adapter.id,
          keyword,
          page,
          pageCount,
          error: response?.error || "页面没有返回商品列表",
          pageDiagnostics: lastPageDiagnostics
        });
        throw new Error(response?.error || `未能读取${adapter.name}第 ${page} 页搜索结果`);
      }

      const pageProducts = response.products;
      pagesLoaded = page;
      let newProducts = 0;
      for (const product of pageProducts) {
        if (seen.has(String(product.id))) continue;
        seen.add(String(product.id));
        products.push(product);
        newProducts += 1;
      }

      // 京东偶尔会把分页请求重定向回第一页；继续请求其余页，但不要把重复结果误当成新商品。
      if (page > 1 && pageProducts.length && newProducts === 0) {
        console.warn(`${adapter.name}第 ${page} 页返回了重复结果，可能触发了分页重定向或验证`);
        await appendRuntimeLog("search_page_duplicate_results", {
          platform: adapter.id,
          keyword,
          page,
          pageCount,
          received: pageProducts.length
        });
      }
      pageStats.push({ page, received: pageProducts.length, newProducts });
      await appendRuntimeLog("search_page_completed", {
        platform: adapter.id,
        keyword,
        page,
        pageCount,
        received: pageProducts.length,
        newProducts,
        pageDiagnostics: lastPageDiagnostics,
        sampleProducts: pageProducts.slice(0, 5).map(({ id, title, price }) => ({ id, title, price })),
        ...(options.detailedDiagnostics && Array.isArray(response.priceDiagnostics)
          ? { priceDiagnostics: response.priceDiagnostics }
          : {})
      });
      await setSearchStatus({
        state: "searching",
        platform: adapter.id,
        keyword,
        page,
        totalPages: pageCount,
        pagesLoaded,
        pageStats
      });
      if (!pageProducts.length) break;
      if (page < pageCount) await sleep(SEARCH_PAGE_DELAY_MS);
    }
    products.sort((left, right) => left.price - right.price);
    await appendRuntimeLog("search_completed", {
      platform: adapter.id,
      keyword,
      pageCount,
      pagesLoaded,
      productCount: products.length,
      pageStats
    });
    return { products, pagesLoaded, pageStats };
  } catch (error) {
    let tabState = null;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabState = {
          url: tab.url ? `${new URL(tab.url).origin}${new URL(tab.url).pathname}` : "",
          title: String(tab.title || "").slice(0, 200),
          status: tab.status || ""
        };
      } catch {}
    }
    await appendRuntimeLog("search_failed", {
      platform: adapter.id,
      keyword,
      page: activePage,
      pageCount,
      error: error.message,
      tabState,
      pageDiagnostics: lastPageDiagnostics
    });
    throw error;
  } finally {
    if (searchWindow?.id) await chrome.windows.remove(searchWindow.id).catch(() => {});
  }
}

function normalizeSearchPageCount(value) {
  const pageCount = Number(value ?? DEFAULT_SEARCH_PAGES);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_SEARCH_PAGES) {
    throw new Error(`扫描页数需为 1 到 ${MAX_SEARCH_PAGES} 页`);
  }
  return pageCount;
}

function sendTabMessage(tabId, message) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("商品页面响应超时，请刷新扩展后重试")), TAB_MESSAGE_TIMEOUT_MS);
    })
  ]);
}

function getPlatformAdapter(platform) {
  const adapter = self.PriceAdapters?.[String(platform || "jd")];
  if (!adapter) throw new Error(`暂不支持${platform || "该平台"}`);
  if (adapter.supported === false) throw new Error(`${adapter.name}适配器正在开发中`);
  return adapter;
}

function adapterName(platform) {
  return self.PriceAdapters?.[String(platform || "jd")]?.name || "商品";
}

async function setSearchStatus(status) {
  await chrome.storage.local.set({ searchStatus: { ...status, updatedAt: Date.now() } });
}

async function createMonitorFromSelection(
  productIds,
  includeKeywords,
  excludeKeywords,
  variantRule,
  thresholdRules
) {
  const { selectionDraft } = await chrome.storage.local.get({ selectionDraft: null });
  if (!selectionDraft?.products?.length) throw new Error("商品选择已过期，请重新搜索");
  const normalizedThresholdRules = normalizeThresholdRules(thresholdRules);

  const ids = new Set((Array.isArray(productIds) ? productIds : []).map(String));
  const selectedProducts = selectionDraft.products.filter((product) => ids.has(String(product.id)));
  const matchRule = {
    includeKeywords: normalizeKeywords(includeKeywords),
    excludeKeywords: normalizeKeywords(excludeKeywords),
    ...normalizeVariantRule(variantRule)
  };
  if (!matchRule.includeKeywords.length) throw new Error("请至少填写一个必含关键词");

  const monitor = {
    id: crypto.randomUUID(),
    platform: selectionDraft.platform || "jd",
    pageCount: normalizeSearchPageCount(selectionDraft.pageCount),
    keyword: selectionDraft.keyword,
    threshold: normalizedThresholdRules.default,
    thresholdRules: normalizedThresholdRules,
    matchRule,
    exampleProducts: selectedProducts,
    matches: {},
    lowestPrice: null,
    eligibleCount: 0,
    lastCheckedAt: null,
    lastError: ""
  };
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  monitors.push(monitor);
  await chrome.storage.local.set({ monitors, selectionDraft: null });
  await appendRuntimeLog("monitor_created", {
    monitorId: monitor.id,
    platform: monitor.platform,
    keyword: monitor.keyword,
    pageCount: monitor.pageCount,
    matchRule: monitor.matchRule,
    thresholdRules: monitor.thresholdRules
  });
  try {
    const result = await checkMonitor(monitor.id);
    return { monitor: result };
  } catch (error) {
    await appendRuntimeLog("monitor_initial_check_failed", {
      monitorId: monitor.id,
      platform: monitor.platform,
      keyword: monitor.keyword,
      pageCount: monitor.pageCount,
      error: error.message
    });
    await updateMonitor(monitor.id, {
      lastCheckedAt: Date.now(),
      lastError: error.message
    });
    return { monitor: { ...monitor, lastCheckedAt: Date.now(), lastError: error.message } };
  }
}

async function checkMonitor(id) {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  const monitor = monitors.find((item) => item.id === id);
  if (!monitor) throw new Error("监控任务不存在");

  const adapter = getPlatformAdapter(monitor.platform || "jd");
  if (!monitor.keyword?.trim()) throw new Error("监控关键词不能为空");

  const pageCount = normalizeSearchPageCount(monitor.pageCount);
  const responseProducts = (await searchProducts(monitor.keyword.trim(), monitor.platform || "jd", pageCount)).products;
  if (!responseProducts.length) {
    throw new Error("未读取到商品结果，可能是页面未加载或触发了平台验证");
  }

  const selectedProducts = Array.isArray(monitor.selectedProducts)
    ? monitor.selectedProducts
    : [];
  const matchRule = normalizeMatchRule(monitor.matchRule);
  const selectedIds = new Set(selectedProducts.map((product) => String(product.id)));
  const matchedProducts = matchRule
    ? responseProducts.filter((product) => matchesRule(product, matchRule))
    : selectedProducts.length
      ? responseProducts.filter((product) => selectedIds.has(String(product.id)))
      : responseProducts;

  if (!matchedProducts.length) {
    throw new Error(
      matchRule
        ? `当前搜索结果前 ${pageCount} 页没有符合匹配规则的商品`
        : selectedProducts.length
        ? `选中的商品不在当前搜索结果前 ${pageCount} 页，暂时无法确认价格`
        : "未读取到商品结果，可能是页面未加载或触发了平台验证"
    );
  }

  const products = matchedProducts
    .map((product) => ({
      ...product,
      comparisonPrice: getComparablePrice(product, matchRule),
      threshold: getThresholdForProduct(product, monitor)
    }))
    .filter((product) => Number.isFinite(product.comparisonPrice) && Number.isFinite(product.threshold));
  if (!products.length) {
    throw new Error("找到符合条件的商品，但无法解析其装量，暂时无法计算比较价格");
  }

  const previousMatches = monitor.matches || {};
  const nextMatches = { ...previousMatches };
  const newlyMatched = [];

  for (const product of products) {
    const isBelow = product.comparisonPrice < product.threshold;
    const previous = previousMatches[product.id] || {};
    nextMatches[product.id] = {
      title: product.title,
      price: product.price,
      comparisonPrice: product.comparisonPrice,
      threshold: product.threshold,
      attributes: product.attributes,
      url: product.url,
      wasBelowThreshold: isBelow,
      lastSeenAt: Date.now()
    };
    if (isBelow && previous.wasBelowThreshold !== true) {
      newlyMatched.push(product);
    }
  }

  const eligibleProducts = products
    .filter((product) => product.comparisonPrice < product.threshold)
    .sort((left, right) => left.comparisonPrice - right.comparisonPrice);
  const latestProducts = products.map((product) => ({
    id: product.id,
    url: product.url,
    title: product.title,
    price: product.price,
    comparisonPrice: product.comparisonPrice,
    threshold: product.threshold,
    attributes: product.attributes
  }));
  const patch = {
    lastCheckedAt: Date.now(),
    lastError: "",
    matches: nextMatches,
    latestProducts,
    lowestPrice: products.reduce(
      (lowest, product) => Math.min(lowest, product.comparisonPrice),
      Number.POSITIVE_INFINITY
    ),
    eligibleCount: eligibleProducts.length,
    title: monitor.keyword,
    platform: monitor.platform || "jd",
    matchedCount: matchedProducts.length,
    missingSelectedCount: matchRule ? 0 : selectedProducts.length - products.length
  };

  await updateMonitor(monitor.id, patch);
  if (newlyMatched.length) {
    await notifyMatches(monitor, newlyMatched.sort((left, right) => left.comparisonPrice - right.comparisonPrice));
  }

  await appendRuntimeLog("monitor_check_completed", {
    monitorId: monitor.id,
    platform: monitor.platform || "jd",
    keyword: monitor.keyword,
    pageCount,
    matchedCount: matchedProducts.length,
    eligibleCount: eligibleProducts.length,
    newlyLowPriceCount: newlyMatched.length
  });

  return { ...monitor, ...patch, notified: newlyMatched.length > 0 };
}

async function notifyMatches(monitor, products) {
  const notificationId = `price-${monitor.id}-${Date.now()}`;
  const visibleProducts = products.slice(0, 3);
  const message = visibleProducts
    .map((product) => `${product.title.slice(0, 32)} ¥${product.price.toFixed(2)}（比较价 ¥${product.comparisonPrice.toFixed(2)}，目标 ¥${product.threshold.toFixed(2)}）`)
    .join("\n");
  const notificationTargets = await chrome.storage.local.get({ notificationTargets: {} });
  notificationTargets.notificationTargets[notificationId] = visibleProducts[0].url;
  await chrome.storage.local.set(notificationTargets);

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon128.png",
    title: `${adapterName(monitor.platform)}低价提醒：${monitor.keyword}`,
    message: `${message}\n点击打开匹配的低价商品`
  });
  await appendRuntimeLog("low_price_notification_sent", {
    monitorId: monitor.id,
    platform: monitor.platform || "jd",
    keyword: monitor.keyword,
    productIds: visibleProducts.map((product) => product.id),
    count: products.length
  });
}

async function updateMonitor(id, patch) {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  const next = monitors.map((monitor) =>
    monitor.id === id ? { ...monitor, ...patch } : monitor
  );
  await chrome.storage.local.set({ monitors: next });
}

function normalizeKeywords(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,，、;；]+/);
  return [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function normalizeMatchRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const normalized = {
    includeKeywords: normalizeKeywords(rule.includeKeywords),
    excludeKeywords: normalizeKeywords(rule.excludeKeywords),
    ...normalizeVariantRule(rule)
  };
  return normalized.includeKeywords.length
    || normalized.dosageForms?.length
    || normalized.strengths?.length
    || normalized.unitSpecs?.length
    || normalized.packCounts?.length
    ? normalized
    : null;
}

function matchesRule(product, rule) {
  const title = String(product.title || "").toLowerCase().replace(/\s+/g, "");
  const attributes = product.attributes || {};
  const keywordMatch = rule.includeKeywords.every((keyword) => title.includes(keyword.replace(/\s+/g, "")));
  const excluded = rule.excludeKeywords.some((keyword) => title.includes(keyword.replace(/\s+/g, "")));
  const dosageMatch = !rule.dosageForms?.length
    || rule.dosageForms.includes(String(attributes.dosageForm || "").toLowerCase());
  const strengthMatch = !rule.strengths?.length
    || rule.strengths.includes(String(attributes.strength || "").toLowerCase().replace(/\s+/g, ""));
  const unitSpecMatch = !rule.unitSpecs?.length
    || rule.unitSpecs.includes(String(attributes.unitSpec || "").toLowerCase().replace(/\s+/g, ""));
  const packMatch = !rule.packCounts?.length
    || rule.packCounts.includes(Number(attributes.packCount));
  return keywordMatch && !excluded && dosageMatch && strengthMatch && unitSpecMatch && packMatch;
}

function normalizeVariantRule(rule) {
  const value = rule && typeof rule === "object" ? rule : {};
  const packCounts = Array.isArray(value.packCounts)
    ? [...new Set(value.packCounts.map(Number).filter((count) => Number.isInteger(count) && count > 0))]
    : null;
  const priceBasis = ["total", "perBox", "perUnit"].includes(value.priceBasis)
    ? value.priceBasis
    : "total";
  return {
    dosageForms: normalizeKeywords(value.dosageForms || (value.dosageForm ? [value.dosageForm] : [])),
    strengths: normalizeKeywords(value.strengths || (value.strength ? [value.strength] : []))
      .map((item) => item.replace(/\s+/g, "")),
    unitSpecs: normalizeKeywords(value.unitSpecs || (value.unitSpec ? [value.unitSpec] : []))
      .map((item) => item.replace(/\s+/g, "")),
    packCounts: packCounts?.length ? packCounts.sort((left, right) => left - right) : null,
    priceBasis
  };
}

function normalizeThresholdRules(value) {
  const input = value && typeof value === "object" ? value : {};
  const defaultValue = Number(input.default);
  const normalized = {
    default: Number.isFinite(defaultValue) && defaultValue > 0 ? defaultValue : null,
    byVariant: {}
  };
  const variantEntries = input.byVariant || input.byPack || {};
  if (variantEntries && typeof variantEntries === "object") {
    for (const [variant, threshold] of Object.entries(variantEntries)) {
      const amount = Number(threshold);
      if (Number.isFinite(amount) && amount > 0) {
        normalized.byVariant[String(variant)] = amount;
      }
    }
  }
  if (!normalized.default && !Object.keys(normalized.byVariant).length) {
    throw new Error("请输入有效的目标价格");
  }
  if (Object.keys(normalized.byVariant).length && !normalized.default) {
    normalized.default = null;
  }
  return normalized;
}

function getThresholdForProduct(product, monitor) {
  const rules = monitor.thresholdRules || {
    default: Number(monitor.threshold),
    byVariant: {}
  };
  if (rules.byVariant && Object.keys(rules.byVariant).length) {
    return Number(rules.byVariant[getVariantKey(product)]) || null;
  }
  if (rules.byPack && Object.keys(rules.byPack).length) {
    return Number(rules.byPack[String(product.attributes?.packCount)]) || null;
  }
  return Number(rules.default) || null;
}

function getVariantKey(product) {
  const attributes = product.attributes || {};
  return [attributes.strength, attributes.unitSpec, attributes.packCount]
    .map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, ""))
    .join("|") || "default";
}

function getComparablePrice(product, rule) {
  if (rule?.priceBasis === "perBox") {
    const packCount = getEffectiveBoxCount(product);
    return packCount > 0
      ? product.price / packCount
      : null;
  }
  if (rule?.priceBasis === "perUnit") {
    const packCount = getEffectiveBoxCount(product);
    const unitsPerPack = product.attributes?.unitsPerPack;
    return packCount > 0 && unitsPerPack > 0
      ? product.price / (packCount * unitsPerPack)
      : null;
  }
  return product.price;
}

function getEffectiveBoxCount(product) {
  const packCount = Number(product.attributes?.packCount);
  if (packCount > 0) return packCount;
  return Number(product.attributes?.unitsPerPack) > 0 ? 1 : null;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => finish(new Error("页面加载超时")), TAB_TIMEOUT_MS);

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(() => finish(new Error("无法读取浏览器标签页状态")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
