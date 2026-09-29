chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READ_SEARCH_RESULTS") return;

  readJdSearchResults()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});

async function readJdSearchResults() {
  await waitForSearchResults();
  const items = [...document.querySelectorAll("li.gl-item, .gl-item, [data-sku]")];
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
  const linkNode = item.querySelector("a.p-img, .p-name a, a[href*='/item.jd.com/']");
  const url = normalizeProductUrl(linkNode?.href || "");
  const id = item.getAttribute("data-sku") || extractProductId(url);
  const title = (
    item.querySelector(".p-name em, .p-name, .p-img")?.textContent || ""
  ).replace(/\s+/g, " ").trim();
  const price = extractSearchPrice(item);

  if (!id || !url || !title || !Number.isFinite(price) || price <= 0) return null;
  return { id, url, title, price };
}

function extractSearchPrice(item) {
  const selectors = [
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
