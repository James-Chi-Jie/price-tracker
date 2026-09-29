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

async function checkMonitor(id) {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  const monitor = monitors.find((item) => item.id === id);
  if (!monitor) throw new Error("监控任务不存在");

  const adapter = self.PriceAdapters?.[monitor.platform || "jd"];
  if (!adapter) throw new Error("暂不支持该平台");
  if (!monitor.keyword?.trim()) throw new Error("监控关键词不能为空");

  const tab = await chrome.tabs.create({
    url: adapter.buildSearchUrl(monitor.keyword.trim()),
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

    if (!response.products.length) {
      throw new Error("未读取到商品结果，可能是页面未加载或触发了平台验证");
    }

    const previousMatches = monitor.matches || {};
    const nextMatches = { ...previousMatches };
    const newlyMatched = [];

    for (const product of response.products) {
      const isBelow = product.price < Number(monitor.threshold);
      const previous = previousMatches[product.id] || {};
      nextMatches[product.id] = {
        title: product.title,
        price: product.price,
        url: product.url,
        wasBelowThreshold: isBelow,
        lastSeenAt: Date.now()
      };
      if (isBelow && previous.wasBelowThreshold !== true) {
        newlyMatched.push(product);
      }
    }

    const eligibleProducts = response.products
      .filter((product) => product.price < Number(monitor.threshold))
      .sort((left, right) => left.price - right.price);
    const patch = {
      lastCheckedAt: Date.now(),
      lastError: "",
      matches: nextMatches,
      lowestPrice: response.products.reduce(
        (lowest, product) => Math.min(lowest, product.price),
        Number.POSITIVE_INFINITY
      ),
      eligibleCount: eligibleProducts.length,
      title: monitor.keyword
    };

    await updateMonitor(monitor.id, patch);
    if (newlyMatched.length) {
      await notifyMatches(monitor, newlyMatched.sort((left, right) => left.price - right.price));
    }

    return { ...monitor, ...patch, notified: newlyMatched.length > 0 };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function notifyMatches(monitor, products) {
  const notificationId = `price-${monitor.id}-${Date.now()}`;
  const visibleProducts = products.slice(0, 3);
  const message = visibleProducts
    .map((product) => `${product.title.slice(0, 32)} ¥${product.price.toFixed(2)}`)
    .join("\n");
  const notificationTargets = await chrome.storage.local.get({ notificationTargets: {} });
  notificationTargets.notificationTargets[notificationId] = visibleProducts[0].url;
  await chrome.storage.local.set(notificationTargets);

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon128.svg",
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
