chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READ_PRICE") return;

  readJdPrice()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});

async function readJdPrice() {
  await waitForPriceElement();

  const title = document.querySelector("#name h1, .sku-name, h1")?.textContent?.trim() || "";
  const price = extractFromStructuredData() || extractFromPriceSelectors();

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("页面中没有找到明确的京东价格");
  }

  return { price, title };
}

async function waitForPriceElement() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (document.querySelector(".p-price .price, .summary-price .price, [class*='price']")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function extractFromStructuredData() {
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
  for (const script of scripts) {
    try {
      const value = JSON.parse(script.textContent || "");
      const candidates = Array.isArray(value) ? value : [value];
      for (const item of candidates) {
        const price = Number(item?.offers?.price ?? item?.price);
        if (Number.isFinite(price) && price > 0) return price;
      }
    } catch {
      // 忽略无法解析的结构化数据，继续使用页面选择器。
    }
  }
  return null;
}

function extractFromPriceSelectors() {
  const selectors = [
    ".p-price .price",
    ".summary-price .price",
    ".J-p-1000000000",
    "[class*='p-price'] .price",
    "[class*='summary-price'] .price"
  ];

  const prices = [];
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      const price = parsePrice(node.textContent || "");
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }
  }

  return prices.length ? Math.min(...prices) : null;
}

function parsePrice(text) {
  const normalized = text.replace(/,/g, "").replace(/\s+/g, " ");
  const match = normalized.match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}
