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

  const adapter = Object.values(self.PriceAdapters || {})
    .find((candidate) => candidate.canHandle(monitor.url));
  if (!adapter) throw new Error("暂不支持该平台");

  const tab = await chrome.tabs.create({ url: monitor.url, active: false });
  try {
    await waitForTabComplete(tab.id);
    await sleep(1500);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "READ_PRICE",
      platform: adapter.id
    });

    if (!response?.price || !Number.isFinite(response.price)) {
      throw new Error(response?.error || "未能读取有效价格");
    }

    const isBelow = response.price < Number(monitor.threshold);
    const shouldNotify = isBelow && monitor.wasBelowThreshold !== true;
    const patch = {
      lastPrice: response.price,
      lastCheckedAt: Date.now(),
      lastError: "",
      wasBelowThreshold: isBelow,
      title: response.title || monitor.title || "京东商品"
    };

    await updateMonitor(monitor.id, patch);
    if (shouldNotify) {
      await notifyPrice(monitor, response.price, response.title);
    }

    return { ...monitor, ...patch, notified: shouldNotify };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function notifyPrice(monitor, price, title) {
  const safeTitle = title || monitor.title || "京东商品";
  await chrome.notifications.create(`price-${monitor.id}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon128.svg",
    title: "京东低价提醒",
    message: `${safeTitle}\n当前 ¥${price.toFixed(2)}，低于阈值 ¥${Number(monitor.threshold).toFixed(2)}`
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
