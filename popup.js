const form = document.querySelector("#monitor-form");
const keywordInput = document.querySelector("#keyword");
const thresholdInput = document.querySelector("#threshold");
const monitorsEl = document.querySelector("#monitors");
const messageEl = document.querySelector("#message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();
  const threshold = Number(thresholdInput.value);

  if (!keyword) return showMessage("请输入商品关键词");
  if (!Number.isFinite(threshold) || threshold <= 0) return showMessage("请输入有效的目标价格");

  showMessage("正在读取京东搜索结果…");
  const result = await chrome.runtime.sendMessage({
    type: "START_PRODUCT_SELECTION",
    keyword,
    threshold
  });
  if (result?.ok) {
    form.reset();
    showMessage("已打开商品选择页");
  } else {
    showMessage(`搜索失败：${result?.error || "未知错误"}`);
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
    const scope = matchRule
      ? `类型匹配：必含 ${escapeHtml(matchRule.includeKeywords.join("、"))}`
        + (matchRule.excludeKeywords?.length ? `；排除 ${escapeHtml(matchRule.excludeKeywords.join("、"))}` : "")
      : selectedProducts.length
        ? `旧版任务：仅匹配 ${selectedProducts.length} 个指定 SKU`
        : "旧版任务：匹配该关键词下的全部商品";
    const selectedSummary = exampleProducts.length
      ? exampleProducts.slice(0, 2).map((product) => escapeHtml(product.title)).join("；")
        + (exampleProducts.length > 2 ? "…" : "")
      : "";

    card.innerHTML = `
      <p class="title">京东：${escapeHtml(monitor.keyword)}</p>
      <p class="scope">${scope}</p>
      ${selectedSummary ? `<p class="products-summary">${selectedSummary}</p>` : ""}
      <p>目标：¥${Number(monitor.threshold).toFixed(2)}　最低：${lowestPrice}</p>
      <p>低价商品：${Number(monitor.eligibleCount || 0)} 个</p>
      ${monitor.missingSelectedCount ? `<p class="error">有 ${monitor.missingSelectedCount} 个商品暂不在搜索结果第一页</p>` : ""}
      <p class="muted">上次检查：${escapeHtml(checked)}</p>
      ${error}
      <div class="actions">
        <button data-action="check" data-id="${monitor.id}">立即检查</button>
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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

render();
