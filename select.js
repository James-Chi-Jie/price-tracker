const summaryEl = document.querySelector("#summary");
const productsEl = document.querySelector("#products");
const selectedCountEl = document.querySelector("#selected-count");
const messageEl = document.querySelector("#message");
const confirmButton = document.querySelector("#confirm");
const selectLowButton = document.querySelector("#select-low");
const selectAllButton = document.querySelector("#select-all");
const clearAllButton = document.querySelector("#clear-all");
const excludeKeywordsInput = document.querySelector("#exclude-keywords");
const priceBasisSelect = document.querySelector("#price-basis");
const thresholdsEl = document.querySelector("#thresholds");
const thresholdHintEl = document.querySelector("#threshold-hint");

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
  renderThresholds();
  renderProducts();
}

function renderOptions() {
  const groups = [
    { id: "dosage-options", title: "剂型", key: "dosageForm", format: (value) => value },
    { id: "strength-options", title: "剂量规格", key: "strength", format: (value) => value },
    { id: "unit-options", title: "单包装数量", key: "unitSpec", format: (value) => value },
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
      checkbox.addEventListener("change", () => {
        renderThresholds();
        updatePriceHighlights();
      });
    }
    container.appendChild(list);
  }
}

function renderThresholds() {
  const previousValues = new Map(
    [...thresholdsEl.querySelectorAll("input[data-variant-threshold]")]
      .map((input) => [input.dataset.variantThreshold, input.value])
  );
  const variants = new Map();
  for (const product of getEligiblePreviewProducts()) {
    const key = getVariantKey(product);
    if (!variants.has(key)) variants.set(key, getVariantLabel(product));
  }
  thresholdsEl.innerHTML = "";
  const values = variants.size ? [...variants.entries()] : [["default", "未识别规格"]];

  for (const [variantKey, variantLabel] of values) {
    const label = document.createElement("label");
    label.className = "threshold-item";
    const name = document.createElement("span");
    name.textContent = variantLabel;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.01";
    input.step = "0.01";
    input.placeholder = "例如：200";
    input.required = true;
    input.dataset.variantThreshold = variantKey;
    input.value = previousValues.get(variantKey) || "";
    input.addEventListener("input", updatePriceHighlights);
    label.append(name, input);
    thresholdsEl.appendChild(label);
  }

  thresholdHintEl.textContent = variants.size
    ? "每个识别到的规格组合分别使用对应目标价格，例如 2g·6袋 和 2g·10袋可以分别设置。"
    : "暂未识别出规格组合，将使用一个统一目标价格。";
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
      attributes.unitSpec,
      attributes.packCount ? `${attributes.packCount}盒` : "",
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
  const thresholds = getThresholdRules();
  if (!thresholds) {
    showMessage("请先填写所有有效的目标价格", true);
    thresholdsEl.querySelector("input")?.focus();
    return;
  }

  let selected = 0;
  for (const product of draft.products) {
    const card = [...productsEl.querySelectorAll(".product")]
      .find((item) => item.dataset.id === String(product.id));
    const checkbox = card?.querySelector("input[type=checkbox]");
    const comparisonPrice = getComparablePrice(product);
    const threshold = getThresholdForProduct(product, thresholds);
    const isLow = comparisonPrice !== null && threshold !== null && comparisonPrice < threshold;
    if (checkbox) checkbox.checked = isLow;
    if (isLow) selected += 1;
  }
  updateSelectedCount();
  showMessage(`已选中 ${selected} 个低于目标价格的预览商品`);
});

priceBasisSelect.addEventListener("change", updatePriceHighlights);
excludeKeywordsInput.addEventListener("input", () => {
  renderThresholds();
  updatePriceHighlights();
});

selectAllButton.addEventListener("click", () => {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) checkbox.checked = true;
  updateSelectedCount();
});

clearAllButton.addEventListener("click", () => {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) checkbox.checked = false;
  updateSelectedCount();
});

confirmButton.addEventListener("click", async () => {
  const thresholdRules = getThresholdRules();
  if (!thresholdRules) {
    showMessage("请先填写所有有效的目标价格", true);
    thresholdsEl.querySelector("input")?.focus();
    return;
  }

  const productIds = [...productsEl.querySelectorAll("input:checked")].map((input) => input.value);
  const includeKeywords = splitKeywords(draft.keyword);
  const excludeKeywords = splitKeywords(excludeKeywordsInput.value);
  const variantRule = {
    dosageForms: getOptionValues("dosageForm"),
    strengths: getOptionValues("strength"),
    unitSpecs: getOptionValues("unitSpec"),
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
    thresholdRules
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

function getThresholdRules() {
  const inputs = [...thresholdsEl.querySelectorAll("input[data-variant-threshold]")];
  const rules = { default: null, byVariant: {} };
  for (const input of inputs) {
    const threshold = Number(input.value);
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    if (input.dataset.variantThreshold === "default") rules.default = threshold;
    else rules.byVariant[input.dataset.variantThreshold] = threshold;
  }
  return rules;
}

function getThresholdForProduct(product, rules) {
  if (Object.keys(rules.byVariant).length) {
    return rules.byVariant[getVariantKey(product)] ?? null;
  }
  return rules.default;
}

function getEligiblePreviewProducts() {
  const selectedOptions = {
    dosageForm: getOptionValues("dosageForm"),
    strength: getOptionValues("strength"),
    unitSpec: getOptionValues("unitSpec"),
    packCount: getOptionValues("packCount")
  };
  const excluded = splitKeywords(excludeKeywordsInput.value).map((item) => item.toLowerCase());
  return draft.products.filter((product) => {
    const attributes = product.attributes || {};
    const optionMatch = Object.entries(selectedOptions).every(([key, values]) => {
      if (!values.length) return true;
      return values.includes(String(attributes[key] ?? ""));
    });
    const title = String(product.title || "").toLowerCase();
    return optionMatch && !excluded.some((keyword) => title.includes(keyword));
  });
}

function getVariantKey(product) {
  const attributes = product.attributes || {};
  return [attributes.strength, attributes.unitSpec, attributes.packCount]
    .map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, ""))
    .join("|") || "default";
}

function getVariantLabel(product) {
  const attributes = product.attributes || {};
  return [
    attributes.strength,
    attributes.unitSpec,
    attributes.packCount ? `${attributes.packCount}盒` : ""
  ].filter(Boolean).join(" · ") || "规格待确认";
}

function getComparablePrice(product) {
  const price = Number(product.price);
  if (!Number.isFinite(price)) return null;
  if (priceBasisSelect.value === "perBox") {
    const packCount = getEffectiveBoxCount(product);
    return packCount > 0 ? price / packCount : null;
  }
  if (priceBasisSelect.value === "perUnit") {
    const packCount = getEffectiveBoxCount(product);
    const unitsPerPack = Number(product.attributes?.unitsPerPack);
    return packCount > 0 && unitsPerPack > 0
      ? price / (packCount * unitsPerPack)
      : null;
  }
  return price;
}

function getEffectiveBoxCount(product) {
  const packCount = Number(product.attributes?.packCount);
  if (packCount > 0) return packCount;
  return Number(product.attributes?.unitsPerPack) > 0 ? 1 : null;
}

function updatePriceHighlights() {
  const thresholds = getThresholdRules();
  for (const card of productsEl.querySelectorAll(".product")) {
    const product = draft?.products.find((item) => String(item.id) === card.dataset.id);
    const priceElement = card.querySelector(".product-price");
    const comparisonPrice = product ? getComparablePrice(product) : null;
    const threshold = product && thresholds ? getThresholdForProduct(product, thresholds) : null;
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
