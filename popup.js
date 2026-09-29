const form = document.querySelector("#monitor-form");
const urlInput = document.querySelector("#url");
const thresholdInput = document.querySelector("#threshold");
const monitorsEl = document.querySelector("#monitors");
const messageEl = document.querySelector("#message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  const threshold = Number(thresholdInput.value);

  if (!isJdUrl(url)) return showMessage("请输入京东商品链接");
  if (!Number.isFinite(threshold) || threshold <= 0) return showMessage("请输入有效的目标价格");

  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  monitors.push({
    id: crypto.randomUUID(),
    url,
    threshold,
    title: "",
    lastPrice: null,
    lastCheckedAt: null,
    lastError: "",
    wasBelowThreshold: false
  });
  await chrome.storage.local.set({ monitors });
  form.reset();
  showMessage("已添加，正在执行首次检查…");
  await chrome.runtime.sendMessage({ type: "CHECK_ONE", id: monitors.at(-1).id });
  await render();
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
    const price = monitor.lastPrice ? `¥${monitor.lastPrice.toFixed(2)}` : "未检查";
    const checked = monitor.lastCheckedAt
      ? new Date(monitor.lastCheckedAt).toLocaleString()
      : "尚未检查";
    const error = monitor.lastError ? `<p class="error">${escapeHtml(monitor.lastError)}</p>` : "";

    card.innerHTML = `
      <p class="title">${escapeHtml(monitor.title || "京东商品")}</p>
      <p>目标：¥${Number(monitor.threshold).toFixed(2)}　当前：${price}</p>
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
  await chrome.runtime.sendMessage({ type: "CHECK_ONE", id });
  button.disabled = false;
  await render();
  showMessage("检查完成");
});

function isJdUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "jd.com" || hostname.endsWith(".jd.com");
  } catch {
    return false;
  }
}

function showMessage(message) {
  messageEl.textContent = message;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

render();
