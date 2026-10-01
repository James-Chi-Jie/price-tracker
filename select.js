const summaryEl = document.querySelector("#summary");
const productsEl = document.querySelector("#products");
const selectedCountEl = document.querySelector("#selected-count");
const messageEl = document.querySelector("#message");
const confirmButton = document.querySelector("#confirm");
const selectAllButton = document.querySelector("#select-all");
const selectLowButton = document.querySelector("#select-low");
const clearAllButton = document.querySelector("#clear-all");
const includeKeywordsInput = document.querySelector("#include-keywords");
const excludeKeywordsInput = document.querySelector("#exclude-keywords");
const dosageFormInput = document.querySelector("#dosage-form");
const strengthInput = document.querySelector("#strength");
const packModeSelect = document.querySelector("#pack-mode");
const packCountsInput = document.querySelector("#pack-counts");
const priceBasisSelect = document.querySelector("#price-basis");

let draft = null;
let autoSuggestedFields = { include: "", dosageForm: "", strength: "" };

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
    checkbox.addEventListener("change", () => {
      updateSelectedCount();
      updateRuleSuggestion();
    });

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
  updateRuleSuggestion();
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

packModeSelect.addEventListener("change", updatePackInputState);
updatePackInputState();

confirmButton.addEventListener("click", async () => {
  const productIds = [...productsEl.querySelectorAll("input:checked")].map((input) => input.value);
  if (!productIds.length) {
    showMessage("请至少选择一个商品", true);
    return;
  }
  const includeKeywords = splitKeywords(includeKeywordsInput.value);
  const excludeKeywords = splitKeywords(excludeKeywordsInput.value);
  if (!includeKeywords.length) {
    showMessage("请填写至少一个必含关键词，避免监控到错误的商品类型", true);
    includeKeywordsInput.focus();
    return;
  }
  const selectedProducts = getSelectedProducts();
  const packCounts = resolvePackCounts(selectedProducts);
  if (packCounts === "invalid") return;
  const variantRule = {
    dosageForm: dosageFormInput.value.trim(),
    strength: strengthInput.value.trim(),
    packCounts,
    priceBasis: priceBasisSelect.value
  };

  confirmButton.disabled = true;
  showMessage("正在创建监控并执行首次检查…");
  const result = await chrome.runtime.sendMessage({
    type: "CREATE_MONITOR",
    productIds,
    includeKeywords,
    excludeKeywords,
    variantRule
  });
  confirmButton.disabled = false;
  if (!result?.ok) {
    showMessage(`创建失败：${result?.error || "未知错误"}`, true);
    return;
  }
  showMessage("监控已创建，之后会检查所有符合匹配规则的商品 SKU。");
});

function setAllChecked(predicate) {
  for (const checkbox of productsEl.querySelectorAll("input[type=checkbox]")) {
    checkbox.checked = predicate(checkbox);
  }
  updateSelectedCount();
  updateRuleSuggestion();
}

function getSelectedProducts() {
  const selectedIds = new Set(
    [...productsEl.querySelectorAll("input:checked")].map((input) => String(input.value))
  );
  return draft.products.filter((product) => selectedIds.has(String(product.id)));
}

function resolvePackCounts(selectedProducts) {
  if (packModeSelect.value === "all") return null;
  if (packModeSelect.value === "selected") {
    const counts = [...new Set(selectedProducts
      .map((product) => product.attributes?.packCount)
      .filter((count) => Number.isInteger(count) && count > 0))];
    if (!counts.length) {
      showMessage("代表商品没有识别出盒数，请改用自定义盒数", true);
      packModeSelect.value = "custom";
      updatePackInputState();
      return "invalid";
    }
    return counts.sort((left, right) => left - right);
  }

  const counts = packCountsInput.value
    .split(/[\s,，、;；]+/)
    .map((value) => Number.parseInt(value.replace(/\D/g, ""), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  const uniqueCounts = [...new Set(counts)].sort((left, right) => left - right);
  if (!uniqueCounts.length) {
    showMessage("请填写有效的自定义盒数，例如：1,2,3", true);
    packCountsInput.focus();
    return "invalid";
  }
  return uniqueCounts;
}

function updatePackInputState() {
  packCountsInput.disabled = packModeSelect.value !== "custom";
}

function updateSelectedCount() {
  const count = productsEl.querySelectorAll("input:checked").length;
  selectedCountEl.textContent = `已选择 ${count} 个商品`;
}

function showMessage(message, isError = false) {
  messageEl.textContent = message;
  messageEl.className = isError ? "message error" : "message";
}

function splitKeywords(value) {
  return [...new Set(String(value || "").split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function suggestIncludeKeywords(products) {
  const selectedTitles = products.map((product) => product.title);
  if (!selectedTitles.length) return "";

  // Suggest common meaningful Chinese runs. This is only a starting point;
  // the user can edit it before creating a monitor.
  const runLists = selectedTitles.map((title) => title.match(/[\u4e00-\u9fff]{2,}/g) || []);
  const firstRuns = runLists[0];
  const commonRuns = firstRuns.filter((run) => runLists.every((runs) => runs.includes(run)));
  const stopWords = new Set(["自营", "官方", "正品", "旗舰店", "药房", "商品"]);
  const useful = (commonRuns.length ? commonRuns : firstRuns)
    .filter((run) => !stopWords.has(run))
    .sort((left, right) => right.length - left.length);
  const formTerms = [
    "滴眼液", "口服液", "洗眼液", "胶囊", "软膏", "乳膏", "喷雾", "贴剂",
    "凝胶", "栓", "膜", "片", "丸", "粉", "液", "贴"
  ].filter((term) => selectedTitles.every((title) => title.includes(term)));
  const distinctForms = formTerms.filter(
    (term) => !formTerms.some((other) => other !== term && other.includes(term))
  );
  const extraTerms = distinctForms.length ? distinctForms : useful.slice(0, 1);
  return [...new Set([draft.keyword, ...extraTerms])].join(" ");
}

function updateRuleSuggestion() {
  const selectedProducts = getSelectedProducts();
  const suggestions = {
    include: suggestIncludeKeywords(selectedProducts),
    dosageForm: commonAttribute(selectedProducts, "dosageForm"),
    strength: commonAttribute(selectedProducts, "strength")
  };
  if (!includeKeywordsInput.value.trim() || includeKeywordsInput.value.trim() === autoSuggestedFields.include) {
    includeKeywordsInput.value = suggestions.include;
  }
  if (!dosageFormInput.value.trim() || dosageFormInput.value.trim() === autoSuggestedFields.dosageForm) {
    dosageFormInput.value = suggestions.dosageForm;
  }
  if (!strengthInput.value.trim() || strengthInput.value.trim() === autoSuggestedFields.strength) {
    strengthInput.value = suggestions.strength;
  }
  autoSuggestedFields = suggestions;
}

function commonAttribute(products, key) {
  const values = [...new Set(products.map((product) => product.attributes?.[key]).filter(Boolean))];
  return values.length === 1 ? String(values[0]) : "";
}
