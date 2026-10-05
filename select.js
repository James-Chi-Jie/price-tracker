const summaryEl = document.querySelector("#summary");
const productsEl = document.querySelector("#products");
const selectedCountEl = document.querySelector("#selected-count");
const messageEl = document.querySelector("#message");
const confirmButton = document.querySelector("#confirm");
const selectAllButton = document.querySelector("#select-all");
const clearAllButton = document.querySelector("#clear-all");
const excludeKeywordsInput = document.querySelector("#exclude-keywords");
const priceBasisSelect = document.querySelector("#price-basis");
const thresholdInput = document.querySelector("#threshold");

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

  summaryEl.textContent = `产品名：${draft.keyword}　共 ${draft.products.length} 个结果`;
  renderOptions();
  renderProducts();
}

function renderOptions() {
  const groups = [
    { id: "dosage-options", title: "剂型", key: "dosageForm", format: (value) => value },
    { id: "strength-options", title: "规格/浓度", key: "strength", format: (value) => value },
    { id: "pack-options", title: "盒数", key: "packCount", format: (value) => `${value}盒` }
  ];

  for (const group of groups) {
    const container = document.querySelector(`#${group.id}`);
    const counts = new Map();
    for (const product of draft.products) {
      const value = product.attributes?.[group.key];
      if (value === null || value === undefined || value === "") continue;
      const normalizedValue = String(value);
      counts.set(normalizedValue, (counts.get(normalizedValue) || 0) + 1);
    }
    const values = [...counts.keys()].sort((left, right) => {
      if (group.key === "packCount") return Number(left) - Number(right);
      return left.localeCompare(right, "zh-CN");
    });

    container.innerHTML = "";
    const title = document.createElement("div");
    title.className = "option-title";
    title.textContent = values.length ? group.title : `${group.title}（本页未识别到）`;
    container.appendChild(title);
    if (!values.length) continue;

    const list = document.createElement("div");
    list.className = "option-list";
    for (const value of values) {
      const label = document.createElement("label");
      label.className = "option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.filterKey = group.key;
      checkbox.value = value;
      const text = document.createElement("span");
      const isOnlyOption = values.length === 1;
      if (isOnlyOption) {
        checkbox.checked = true;
        checkbox.disabled = true;
        label.classList.add("option-auto");
      }
      text.textContent = isOnlyOption
        ? `${group.format(value)}（${counts.get(value)}个结果，已自动选择）`
        : `${group.format(value)}（${counts.get(value)}个结果）`;
      label.append(checkbox, text);
      list.appendChild(label);
    }
    container.appendChild(list);
  }
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
    price.className = "product-price";
    price.textContent = `¥${Number(product.price).toFixed(2)}`;
    const sku = document.createElement("span");
    sku.textContent = `SKU ${product.id}`;
    const attributes = product.attributes || {};
    const variant = document.createElement("span");
    variant.textContent = [
      attributes.dosageForm,
      attributes.strength,
      attributes.packCount ? `${attributes.packCount}盒` : "",
      attributes.unitsPerPack ? `${attributes.unitsPerPack}${attributes.unitType || "个"}` : ""
    ].filter(Boolean).join(" · ") || "规格待确认";
    meta.append(price, sku, variant);
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
  updatePriceHighlights();
}

selectLowButton.addEventListener("click", () => {
  const threshold = getThreshold();
  if (threshold === null) {
    showMessage("请先填写有效的目标价格", true);
    thresholdInput.focus();
    return;
  }

  let selected = 0;
  for (const product of draft.products) {
    const card = [...productsEl.querySelectorAll(".product")]
      .find((item) => item.dataset.id === String(product.id));
    const checkbox = card?.querySelector("input[type=checkbox]");
    const comparisonPrice = getComparablePrice(product);
    const isLow = comparisonPrice !== null && comparisonPrice < threshold;
    if (checkbox) checkbox.checked = isLow;
    if (isLow) selected += 1;
  }
  updateSelectedCount();
  showMessage(`已选中 ${selected} 个低于目标价格的预览商品`);
});

thresholdInput.addEventListener("input", updatePriceHighlights);
priceBasisSelect.addEventListener("change", updatePriceHighlights);

selectAllButton.addEventListener("click", () => {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) checkbox.checked = true;
  updateSelectedCount();
});

clearAllButton.addEventListener("click", () => {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) checkbox.checked = false;
  updateSelectedCount();
});

confirmButton.addEventListener("click", async () => {
  const threshold = getThreshold();
  if (threshold === null) {
    showMessage("请先填写有效的目标价格", true);
    thresholdInput.focus();
    return;
  }

  const productIds = [...productsEl.querySelectorAll("input:checked")].map((input) => input.value);
  const includeKeywords = splitKeywords(draft.keyword);
  const excludeKeywords = splitKeywords(excludeKeywordsInput.value);
  const variantRule = {
    dosageForms: getOptionValues("dosageForm"),
    strengths: getOptionValues("strength"),
    packCounts: getOptionValues("packCount").map(Number),
    priceBasis: priceBasisSelect.value
  };

  confirmButton.disabled = true;
  showMessage("正在创建监控并执行首次检查…");
  const result = await chrome.runtime.sendMessage({
    type: "CREATE_MONITOR",
    productIds,
    includeKeywords,
    excludeKeywords,
    variantRule,
    threshold
  });
  confirmButton.disabled = false;
  if (!result?.ok) {
    showMessage(`创建失败：${result?.error || "未知错误"}`, true);
    return;
  }
  showMessage("监控已创建，之后会检查所有符合这些条件的商品 SKU。");
});

function getOptionValues(key) {
  return [...document.querySelectorAll(`input[data-filter-key="${key}"]:checked`)].map((input) => input.value);
}

function updateSelectedCount() {
  const count = productsEl.querySelectorAll("input:checked").length;
  selectedCountEl.textContent = `已选 ${count} 个预览商品（不影响监控范围）`;
}

function getThreshold() {
  const threshold = Number(thresholdInput.value);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
}

function getComparablePrice(product) {
  const price = Number(product.price);
  if (!Number.isFinite(price)) return null;
  if (priceBasisSelect.value === "perBox") {
    const packCount = Number(product.attributes?.packCount);
    return packCount > 0 ? price / packCount : null;
  }
  if (priceBasisSelect.value === "perUnit") {
    const packCount = Number(product.attributes?.packCount);
    const unitsPerPack = Number(product.attributes?.unitsPerPack);
    return packCount > 0 && unitsPerPack > 0
      ? price / (packCount * unitsPerPack)
      : null;
  }
  return price;
}

function updatePriceHighlights() {
  const threshold = getThreshold();
  for (const card of productsEl.querySelectorAll(".product")) {
    const product = draft?.products.find((item) => String(item.id) === card.dataset.id);
    const priceElement = card.querySelector(".product-price");
    const comparisonPrice = product ? getComparablePrice(product) : null;
    priceElement?.classList.toggle(
      "product-low",
      threshold !== null && comparisonPrice !== null && comparisonPrice < threshold
    );
  }
}

function splitKeywords(value) {
  return [...new Set(String(value || "").split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function showMessage(message, isError = false) {
  messageEl.textContent = message;
  messageEl.className = isError ? "message error" : "message";
}
