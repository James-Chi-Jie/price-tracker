importScripts("platforms/jd.js");

const ALARM_NAME = "jd-price-monitor";
const DEFAULT_INTERVAL_MINUTES = 30;
const TAB_TIMEOUT_MS = 25000;

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await checkAllMonitors();
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
    startProductSelection(message.keyword)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CREATE_MONITOR") {
    createMonitorFromSelection(
      message.productIds,
      message.includeKeywords,
      message.excludeKeywords,
      message.variantRule,
      message.threshold
    )
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CHECK_ONE") {
    checkMonitor(message.id)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    chrome.storage.local.get({ monitors: [] }).then(({ monitors }) => {
      sendResponse({ ok: true, monitors });
    });
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
    }
  }
}

async function startProductSelection(keyword) {
  const normalizedKeyword = String(keyword || "").trim();
  if (!normalizedKeyword) throw new Error("监控关键词不能为空");

  const products = await searchProducts(normalizedKeyword);
  if (!products.length) {
    throw new Error("未读取到商品结果，可能是页面未加载或触发了平台验证");
  }

  await chrome.storage.local.set({
    selectionDraft: {
      keyword: normalizedKeyword,
      products,
      createdAt: Date.now()
    }
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("select.html"), active: true });
  return { count: products.length };
}

async function searchProducts(keyword) {
  const adapter = self.PriceAdapters?.jd;
  if (!adapter) throw new Error("暂不支持京东");

  const tab = await chrome.tabs.create({
    url: adapter.buildSearchUrl(keyword),
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    await sleep(1500);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "READ_SEARCH_RESULTS",
      platform: adapter.id
    });
    if (!Array.isArray(response?.products)) {
      throw new Error(response?.error || "未能读取京东搜索结果");
    }
    return response.products;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function createMonitorFromSelection(
  productIds,
  includeKeywords,
  excludeKeywords,
  variantRule,
  threshold
) {
  const { selectionDraft } = await chrome.storage.local.get({ selectionDraft: null });
  if (!selectionDraft?.products?.length) throw new Error("商品选择已过期，请重新搜索");
  const normalizedThreshold = Number(threshold);
  if (!Number.isFinite(normalizedThreshold) || normalizedThreshold <= 0) {
    throw new Error("请输入有效的目标价格");
  }

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
    platform: "jd",
    keyword: selectionDraft.keyword,
    threshold: normalizedThreshold,
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
  try {
    const result = await checkMonitor(monitor.id);
    return { monitor: result };
  } catch (error) {
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

  const adapter = self.PriceAdapters?.[monitor.platform || "jd"];
  if (!adapter) throw new Error("暂不支持该平台");
  if (!monitor.keyword?.trim()) throw new Error("监控关键词不能为空");

  const responseProducts = await searchProducts(monitor.keyword.trim());
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
        ? "当前搜索结果第一页没有符合匹配规则的商品"
        : selectedProducts.length
        ? "选中的商品不在当前搜索结果第一页，暂时无法确认价格"
        : "未读取到商品结果，可能是页面未加载或触发了平台验证"
    );
  }

  const products = matchedProducts
    .map((product) => ({
      ...product,
      comparisonPrice: getComparablePrice(product, matchRule)
    }))
    .filter((product) => Number.isFinite(product.comparisonPrice));
  if (!products.length) {
    throw new Error("找到符合条件的商品，但无法解析其装量，暂时无法计算比较价格");
  }

  const previousMatches = monitor.matches || {};
  const nextMatches = { ...previousMatches };
  const newlyMatched = [];

  for (const product of products) {
    const isBelow = product.comparisonPrice < Number(monitor.threshold);
    const previous = previousMatches[product.id] || {};
    nextMatches[product.id] = {
      title: product.title,
      price: product.price,
      comparisonPrice: product.comparisonPrice,
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
    .filter((product) => product.comparisonPrice < Number(monitor.threshold))
    .sort((left, right) => left.comparisonPrice - right.comparisonPrice);
  const latestProducts = products.map((product) => ({
    id: product.id,
    url: product.url,
    title: product.title,
    price: product.price,
    comparisonPrice: product.comparisonPrice,
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
    matchedCount: matchedProducts.length,
    missingSelectedCount: matchRule ? 0 : selectedProducts.length - products.length
  };

  await updateMonitor(monitor.id, patch);
  if (newlyMatched.length) {
    await notifyMatches(monitor, newlyMatched.sort((left, right) => left.comparisonPrice - right.comparisonPrice));
  }

  return { ...monitor, ...patch, notified: newlyMatched.length > 0 };
}

async function notifyMatches(monitor, products) {
  const notificationId = `price-${monitor.id}-${Date.now()}`;
  const visibleProducts = products.slice(0, 3);
  const message = visibleProducts
    .map((product) => `${product.title.slice(0, 32)} ¥${product.price.toFixed(2)}（比较价 ¥${product.comparisonPrice.toFixed(2)}）`)
    .join("\n");
  const notificationTargets = await chrome.storage.local.get({ notificationTargets: {} });
  notificationTargets.notificationTargets[notificationId] = visibleProducts[0].url;
  await chrome.storage.local.set(notificationTargets);

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon128.png",
    title: `京东低价提醒：${monitor.keyword}`,
    message: `${message}\n低于阈值 ¥${Number(monitor.threshold).toFixed(2)}，点击打开最低价商品`
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
  const packMatch = !rule.packCounts?.length
    || rule.packCounts.includes(Number(attributes.packCount));
  return keywordMatch && !excluded && dosageMatch && strengthMatch && packMatch;
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
    packCounts: packCounts?.length ? packCounts.sort((left, right) => left - right) : null,
    priceBasis
  };
}

function getComparablePrice(product, rule) {
  if (rule?.priceBasis === "perBox") {
    return product.attributes?.packCount > 0
      ? product.price / product.attributes.packCount
      : null;
  }
  if (rule?.priceBasis === "perUnit") {
    const packCount = product.attributes?.packCount;
    const unitsPerPack = product.attributes?.unitsPerPack;
    return packCount > 0 && unitsPerPack > 0
      ? product.price / (packCount * unitsPerPack)
      : null;
  }
  return product.price;
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
