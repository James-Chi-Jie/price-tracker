const form = document.querySelector("#monitor-form");
const keywordInput = document.querySelector("#keyword");
const monitorsEl = document.querySelector("#monitors");
const messageEl = document.querySelector("#message");
const SEARCH_TIMEOUT_MS = 90000;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();

  if (!keyword) return showMessage("请输入商品关键词");

  showMessage("正在读取京东搜索结果…");
  try {
    const result = await sendMessageWithTimeout({
      type: "START_PRODUCT_SELECTION",
      keyword
    }, SEARCH_TIMEOUT_MS);
    if (result?.ok) {
      form.reset();
      showMessage("已打开商品选择页");
    } else {
      showMessage(`搜索失败：${result?.error || "未知错误"}`);
    }
  } catch (error) {
    showMessage(`搜索失败：${error.message}`);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.searchStatus?.newValue) return;
  const status = changes.searchStatus.newValue;
  if (status.state === "searching") {
    const pageText = status.page ? `第 ${status.page}/${status.totalPages} 页` : "准备中";
    showMessage(`正在读取京东搜索结果：${pageText}…`);
  }
});

async function render() {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  monitorsEl.innerHTML = "";

  if (!monitors.length) {
    monitorsEl.innerHTML = '<p class="empty">还没有监控任务。</p>';
    return;
  }

  for (const monitor of monitors) {
    const card = document.createElement("article");
    card.className = "monitor";
    const lowestPrice = Number.isFinite(monitor.lowestPrice)
      ? `¥${monitor.lowestPrice.toFixed(2)}`
      : "未检查";
    const checked = monitor.lastCheckedAt
      ? new Date(monitor.lastCheckedAt).toLocaleString()
      : "尚未检查";
    const error = monitor.lastError ? `<p class="error">${escapeHtml(monitor.lastError)}</p>` : "";
    const selectedProducts = Array.isArray(monitor.selectedProducts)
      ? monitor.selectedProducts
      : [];
    const exampleProducts = Array.isArray(monitor.exampleProducts)
      ? monitor.exampleProducts
      : [];
    const matchRule = monitor.matchRule;
    const basisLabels = { total: "总价", perBox: "每盒价", perUnit: "每单位价" };
    const dosageForms = matchRule?.dosageForms || (matchRule?.dosageForm ? [matchRule.dosageForm] : []);
    const strengths = matchRule?.strengths || (matchRule?.strength ? [matchRule.strength] : []);
    const unitSpecs = matchRule?.unitSpecs || (matchRule?.unitSpec ? [matchRule.unitSpec] : []);
    const scope = matchRule
      ? `类型匹配：必含 ${escapeHtml(matchRule.includeKeywords.join("、"))}`
        + (matchRule.excludeKeywords?.length ? `；排除 ${escapeHtml(matchRule.excludeKeywords.join("、"))}` : "")
        + (dosageForms.length ? `；剂型 ${escapeHtml(dosageForms.join("、"))}` : "")
        + (strengths.length ? `；规格 ${escapeHtml(strengths.join("、"))}` : "")
        + (unitSpecs.length ? `；单包装 ${escapeHtml(unitSpecs.join("、"))}` : "")
        + (matchRule.packCounts?.length ? `；盒数 ${matchRule.packCounts.join("、")}` : "；盒数不限")
      : selectedProducts.length
        ? `旧版任务：仅匹配 ${selectedProducts.length} 个指定 SKU`
        : "旧版任务：匹配该关键词下的全部商品";
    const selectedSummary = exampleProducts.length
      ? exampleProducts.slice(0, 2).map((product) => escapeHtml(product.title)).join("；")
        + (exampleProducts.length > 2 ? "…" : "")
      : "";
    const latestProducts = getLatestProducts(monitor);
    const latestProductLinks = latestProducts.length
      ? `<details class="matches"><summary>查看 ${latestProducts.length} 个匹配商品</summary><ul>${latestProducts.map(renderProductLink).join("")}</ul></details>`
      : '<p class="muted">暂无最近一次检查结果</p>';
    const targetSummary = renderTargetSummary(monitor);

    card.innerHTML = `
      <p class="title">京东：${escapeHtml(monitor.keyword)}</p>
      <p class="scope">${scope}</p>
      ${selectedSummary ? `<p class="products-summary">${selectedSummary}</p>` : ""}
      <p>目标（${basisLabels[matchRule?.priceBasis || "total"]}）：${targetSummary}　最低：${lowestPrice}</p>
      <p>低价商品：${Number(monitor.eligibleCount || 0)} 个</p>
      ${latestProductLinks}
      ${monitor.missingSelectedCount ? `<p class="error">有 ${monitor.missingSelectedCount} 个商品暂不在搜索结果第一页</p>` : ""}
      <p class="muted">上次检查：${escapeHtml(checked)}</p>
      ${error}
      <div class="actions">
        <button data-action="check" data-id="${monitor.id}">立即检查</button>
        <button data-action="export" data-id="${monitor.id}">导出 CSV</button>
        <button class="danger" data-action="delete" data-id="${monitor.id}">删除</button>
      </div>`;
    monitorsEl.appendChild(card);
  }
}

monitorsEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;

  if (button.dataset.action === "delete") {
    const { monitors } = await chrome.storage.local.get({ monitors: [] });
    await chrome.storage.local.set({ monitors: monitors.filter((item) => item.id !== id) });
    await render();
    return;
  }

  if (button.dataset.action === "export") {
    await exportMonitor(button.dataset.id);
    return;
  }

  button.disabled = true;
  showMessage("正在检查…");
  const result = await chrome.runtime.sendMessage({ type: "CHECK_ONE", id });
  button.disabled = false;
  await render();
  showMessage(result?.ok ? "检查完成" : `检查失败：${result?.error || "未知错误"}`);
});

function showMessage(message) {
  messageEl.textContent = message;
}

function sendMessageWithTimeout(message, timeoutMs) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("搜索超时，请重新加载扩展后重试")), timeoutMs);
    })
  ]);
}

function getLatestProducts(monitor) {
  if (Array.isArray(monitor.latestProducts)) return monitor.latestProducts;
  return Object.entries(monitor.matches || {}).map(([id, product]) => ({ id, ...product }));
}

function renderProductLink(product) {
  const comparison = Number.isFinite(product.comparisonPrice)
    ? `比较价 ¥${Number(product.comparisonPrice).toFixed(2)}`
    : `¥${Number(product.price).toFixed(2)}`;
  return `<li class="match-item"><a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.title)}</a><span>实际 ¥${Number(product.price).toFixed(2)} · ${comparison}</span></li>`;
}

function renderTargetSummary(monitor) {
  const rules = monitor.thresholdRules;
  if (rules?.byPack && Object.keys(rules.byPack).length) {
    return Object.entries(rules.byPack)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([pack, threshold]) => `${pack}盒 ¥${Number(threshold).toFixed(2)}`)
      .join("；");
  }
  if (rules?.byVariant && Object.keys(rules.byVariant).length) {
    return Object.entries(rules.byVariant)
      .map(([variant, threshold]) => `${formatVariantKey(variant)} ¥${Number(threshold).toFixed(2)}`)
      .join("；");
  }
  const threshold = Number(rules?.default ?? monitor.threshold);
  return Number.isFinite(threshold) ? `¥${threshold.toFixed(2)}` : "未设置";
}

function formatVariantKey(value) {
  const [strength, unitSpec, packCount] = String(value).split("|");
  return [strength, unitSpec, packCount ? `${packCount}盒` : ""]
    .filter((item) => item && item !== "null")
    .join(" · ") || "规格待确认";
}

async function exportMonitor(id) {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  const monitor = monitors.find((item) => item.id === id);
  if (!monitor) return showMessage("监控任务不存在");
  const products = getLatestProducts(monitor);
  if (!products.length) return showMessage("暂无可导出的检查结果");

  const rows = [
    ["SKU", "商品标题", "实际价格", "比较价格", "剂型", "规格", "盒数", "链接"],
    ...products.map((product) => [
      product.id,
      product.title,
      Number(product.price).toFixed(2),
      Number.isFinite(product.comparisonPrice) ? Number(product.comparisonPrice).toFixed(2) : "",
      product.attributes?.dosageForm || "",
      product.attributes?.strength || "",
      product.attributes?.packCount || "",
      product.url
    ])
  ];
  const csv = "\\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\\r\\n");
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `jd-price-monitor-${Date.now()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  showMessage(`已导出 ${products.length} 个商品`);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

render();
