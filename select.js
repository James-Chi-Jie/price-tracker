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

let draft = null;
let autoSuggestedKeywords = "";

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

  confirmButton.disabled = true;
  showMessage("正在创建监控并执行首次检查…");
  const result = await chrome.runtime.sendMessage({
    type: "CREATE_MONITOR",
    productIds,
    includeKeywords,
    excludeKeywords
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
  const selectedIds = new Set(
    [...productsEl.querySelectorAll("input:checked")].map((input) => String(input.value))
  );
  const selectedProducts = draft.products.filter((product) => selectedIds.has(String(product.id)));
  const suggestion = suggestIncludeKeywords(selectedProducts);
  if (!includeKeywordsInput.value.trim() || includeKeywordsInput.value.trim() === autoSuggestedKeywords) {
    includeKeywordsInput.value = suggestion;
  }
  autoSuggestedKeywords = suggestion;
}
