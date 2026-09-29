const summaryEl = document.querySelector("#summary");
const productsEl = document.querySelector("#products");
const selectedCountEl = document.querySelector("#selected-count");
const messageEl = document.querySelector("#message");
const confirmButton = document.querySelector("#confirm");
const selectAllButton = document.querySelector("#select-all");
const selectLowButton = document.querySelector("#select-low");
const clearAllButton = document.querySelector("#clear-all");

let draft = null;

init();

async function init() {
  const result = await chrome.storage.local.get({ selectionDraft: null });
  draft = result.selectionDraft;
  if (!draft?.products?.length) {
    summaryEl.textContent = "没有可用的搜索结果，请回到插件重新搜索。";
    confirmButton.disabled = true;
    return;
  }

  summaryEl.textContent = `关键词：${draft.keyword}　目标价格：¥${Number(draft.threshold).toFixed(2)}　共 ${draft.products.length} 个结果`;
  renderProducts();
}

function renderProducts() {
  productsEl.innerHTML = "";
  for (const product of draft.products) {
    const label = document.createElement("label");
    label.className = "product";
    label.dataset.id = product.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = product.id;
    checkbox.addEventListener("change", updateSelectedCount);

    const content = document.createElement("div");
    content.className = "product-main";

    const title = document.createElement("p");
    title.className = "product-title";
    title.textContent = product.title;

    const meta = document.createElement("div");
    meta.className = "product-meta";
    const price = document.createElement("span");
    price.className = `product-price${product.price < Number(draft.threshold) ? " product-low" : ""}`;
    price.textContent = `¥${Number(product.price).toFixed(2)}`;
    const sku = document.createElement("span");
    sku.textContent = `SKU ${product.id}`;
    meta.append(price, sku);
    content.append(title, meta);

    const link = document.createElement("a");
    link.className = "product-link";
    link.href = product.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看";
    link.addEventListener("click", (event) => event.stopPropagation());

    label.append(checkbox, content, link);
    productsEl.appendChild(label);
  }
  updateSelectedCount();
}

selectAllButton.addEventListener("click", () => {
  setAllChecked(() => true);
});

selectLowButton.addEventListener("click", () => {
  setAllChecked((checkbox) => {
    const product = draft.products.find((item) => String(item.id) === checkbox.value);
    return product && product.price < Number(draft.threshold);
  });
});

clearAllButton.addEventListener("click", () => {
  setAllChecked(() => false);
});

confirmButton.addEventListener("click", async () => {
  const productIds = [...productsEl.querySelectorAll("input:checked")].map((input) => input.value);
  if (!productIds.length) {
    showMessage("请至少选择一个商品", true);
    return;
  }

  confirmButton.disabled = true;
  showMessage("正在创建监控并执行首次检查…");
  const result = await chrome.runtime.sendMessage({ type: "CREATE_MONITOR", productIds });
  confirmButton.disabled = false;
  if (!result?.ok) {
    showMessage(`创建失败：${result?.error || "未知错误"}`, true);
    return;
  }
  showMessage("监控已创建，之后会按已选商品的 SKU 检查价格。");
});

function setAllChecked(predicate) {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) {
    checkbox.checked = predicate(checkbox);
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = productsEl.querySelectorAll("input:checked").length;
  selectedCountEl.textContent = `已选择 ${count} 个商品`;
}

function showMessage(message, isError = false) {
  messageEl.textContent = message;
  messageEl.className = isError ? "message error" : "message";
}
