chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READ_SEARCH_RESULTS") return;

  readJdSearchResults()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});

async function readJdSearchResults() {
  await waitForSearchResults();
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

async function waitForSearchResults() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (document.querySelector("li.gl-item, .gl-item, [data-sku]")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
    "[class*='_card_'], [class*='_info_'], .p-name em, .p-name, .p-img"
  );
  let title = (titleNode?.textContent || "").replace(/\s+/g, " ").trim();
  // New cards often put the displayed price after the title in the same node.
  title = title.split(/[¥￥]/)[0].trim();
  const price = extractSearchPrice(item);

  if (!id || !url || !title || !Number.isFinite(price) || price <= 0) return null;
  return { id, url, title, price, attributes: extractProductAttributes(title) };
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
  const candidates = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mg|毫克|g|克|ml|毫升|%)/gi)];
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
