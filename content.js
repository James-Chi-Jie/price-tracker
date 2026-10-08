chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GO_TO_SEARCH_PAGE") {
    goToSearchPage(Number(message.page))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "READ_SEARCH_RESULTS") return;

  readJdSearchResults(Number(message.expectedPage) || null)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});

async function readJdSearchResults(expectedPage = null) {
  await waitForSearchResults(expectedPage);
  const items = [...document.querySelectorAll("[data-sku], li.gl-item, .gl-item")];
  const seen = new Set();
  const products = [];

  for (const item of items) {
    const product = parseSearchItem(item);
    if (!product || seen.has(product.id)) continue;
    seen.add(product.id);
    products.push(product);
  }

  return { products };
}

async function goToSearchPage(page) {
  if (!Number.isInteger(page) || page < 1) throw new Error("无效的京东页码");
  if (getCurrentSearchPage() === page) return { ok: true, page };

  const input = await waitForPaginationInput();
  if (!input) throw new Error("未找到京东分页输入框");

  const beforeIds = getSearchItemIds();
  input.focus();
  input.value = String(page);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const container = input.closest(".p-skip") || input.parentElement;
  const confirmButton = container?.querySelector(".btn-default, .btn, button");
  if (confirmButton) {
    confirmButton.click();
  } else {
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const currentPage = getCurrentSearchPage();
    const currentIds = getSearchItemIds();
    if (currentPage === page && currentIds.length) return { ok: true, page };
    if (currentIds.length && currentIds.join(",") !== beforeIds.join(",")) {
      return { ok: true, page: currentPage || page };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`京东第 ${page} 页加载超时`);
}

async function waitForPaginationInput() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const input = findPaginationInput();
    if (input) return input;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function findPaginationInput() {
  const candidates = [...document.querySelectorAll(
    "#J_bottomPage input, #J_topPage input, .p-skip input, input.input-txt, input"
  )];
  return candidates.find((input) => {
    const text = [
      input.className,
      input.parentElement?.textContent,
      input.parentElement?.parentElement?.textContent
    ].join(" ");
    return /到第|页/.test(text) || /input-txt|p-skip/.test(String(input.className));
  }) || null;
}

function getCurrentSearchPage() {
  const current = document.querySelector(
    "#J_bottomPage .p-num .curr, #J_topPage .p-num .curr, .p-num .curr, .p-num a.curr, .p-num b.curr"
  );
  const page = Number(current?.textContent?.trim());
  return Number.isInteger(page) && page > 0 ? page : null;
}

function getSearchItemIds() {
  return [...document.querySelectorAll("[data-sku], li.gl-item, .gl-item")]
    .map((item) => item.getAttribute("data-sku") || "")
    .filter(Boolean);
}

async function waitForSearchResults(expectedPage = null) {
  const deadline = Date.now() + 10000;
  const fallbackDeadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const hasItems = document.querySelector("li.gl-item, .gl-item, [data-sku]");
    if (hasItems && (!expectedPage || getCurrentSearchPage() === expectedPage)) {
      return;
    }
    if (hasItems && Date.now() >= fallbackDeadline) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("京东搜索结果加载超时");
}

function parseSearchItem(item) {
  const sku = item.getAttribute("data-sku") || "";
  const linkNode = item.querySelector("a.p-img, .p-name a, a[href*='/item.jd.com/']");
  const linkedUrl = normalizeProductUrl(linkNode?.href || "");
  const id = sku || extractProductId(linkedUrl);
  // The current JD layout does not expose a normal product anchor on every
  // card, but it does expose data-sku. Build the detail URL from that value.
  const url = id ? `https://item.jd.com/${id}.html` : linkedUrl;
  const titleNode = item.querySelector(
    ".p-name em, .p-name, [class*='_title_'], [class*='_name_'], [class*='_card_'], [class*='_info_'], .p-img"
  );
  const titleCandidates = [
    titleNode?.textContent,
    ...[...item.querySelectorAll(
      ".p-name em, .p-name, [class*='_title_'], [class*='_name_'], [class*='_card_'], [class*='_info_']"
    )].map((node) => node.textContent),
    item.textContent
  ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  let title = titleCandidates[0] || "";
  // New cards often put the displayed price after the title in the same node.
  title = title.split(/[¥￥]/)[0].trim();
  const price = extractSearchPrice(item);

  if (!id || !url || !title || !Number.isFinite(price) || price <= 0) return null;
  const attributeText = titleCandidates
    .filter((candidate) => /(袋|支|片|粒|贴|瓶|包|盒|箱|mg|毫克|g|克|ml|毫升|%)/i.test(candidate))
    .slice(0, 8)
    .join(" ");
  return { id, url, title, price, attributes: extractProductAttributes(attributeText || title) };
}

function extractSearchPrice(item) {
  const selectors = [
    "[class*='_price_']",
    ".p-price .price",
    ".p-price strong",
    ".p-price"
  ];

  const prices = [];
  for (const selector of selectors) {
    for (const node of item.querySelectorAll(selector)) {
      const price = parsePrice(node.textContent || "");
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }
  }

  return prices.length ? Math.min(...prices) : null;
}

function normalizeProductUrl(value) {
  try {
    const url = new URL(value, location.href);
    if (!url.hostname.endsWith("jd.com")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function extractProductId(url) {
  const match = url.match(/\/item\.jd\.com\/(\d+)\.html/);
  return match?.[1] || "";
}

function parsePrice(text) {
  const normalized = text.replace(/,/g, "").replace(/\s+/g, " ");
  const match = normalized.match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function extractProductAttributes(title) {
  const text = String(title || "");
  const dosageForms = [
    "滴眼液", "口服液", "洗眼液", "凝胶", "胶囊", "软膏", "乳膏",
    "喷雾", "贴剂", "栓", "膜", "片", "丸", "粉", "液", "贴"
  ];
  const dosageForm = dosageForms.find((form) => text.includes(form)) || null;
  const strengthMatch = extractPackageStrength(text);
  const packMatch = text.match(/(\d+)\s*(?:盒|箱)(?:装|套)?/i);
  const unitMatch = text.match(/(?:\*|×|x)\s*(\d+)\s*(支|片|粒|贴|袋|瓶|包)/i)
    || text.match(/(\d+)\s*(支|片|粒|贴|袋|瓶|包)/i);
  const unitsPerPack = unitMatch ? Number(unitMatch[1]) : null;
  const unitType = unitMatch?.[2] || null;

  return {
    dosageForm,
    strength: strengthMatch ? `${strengthMatch[1]}${strengthMatch[2]}` : null,
    packCount: packMatch ? Number(packMatch[1]) : null,
    unitsPerPack,
    unitType,
    unitSpec: unitsPerPack && unitType ? `${unitsPerPack}${unitType}` : null
  };
}

function extractPackageStrength(text) {
  // 百分号通常来自“100%正品/好评”等卡片营销文案，不作为默认剂量规格。
  const candidates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mg|毫克|g|克|ml|毫升)/gi)];
  if (!candidates.length) return null;

  const packageCandidate = candidates.find((match) => {
    const end = match.index + match[0].length;
    const after = text.slice(end, end + 12);
    return /^\s*(?:\/\s*(?:袋|支|片|粒|贴|瓶|包)|[*×x]\s*\d+\s*(?:袋|支|片|粒|贴|瓶|包)?)/i.test(after);
  });
  if (packageCandidate) return packageCandidate;

  const meaningfulCandidate = candidates.find((match) => {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    return !/(?:含|含有|成分|含量|每袋含|每支含|每片含)\s*$/i.test(before);
  });
  return meaningfulCandidate || candidates[0];
}
