const form = document.querySelector("#monitor-form");
const keywordInput = document.querySelector("#keyword");
const platformInput = document.querySelector("#platform");
const monitorsEl = document.querySelector("#monitors");
const messageEl = document.querySelector("#message");
const SEARCH_TIMEOUT_MS = 90000;
const PLATFORM_LABELS = { jd: "京东", tmall: "天猫", pdd: "拼多多" };

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();

  if (!keyword) return showMessage("请输入商品关键词");

  const platformName = PLATFORM_LABELS[platformInput.value] || "商品平台";
  showMessage(`正在读取${platformName}搜索结果…`);
  try {
    const result = await sendMessageWithTimeout({
      type: "START_PRODUCT_SELECTION",
      keyword,
      platform: platformInput.value
    }, SEARCH_TIMEOUT_MS);
    if (result?.ok) {
      form.reset();
      showMessage("已打开商品选择页");
      await chrome.tabs.create({
        url: result.selectionUrl || chrome.runtime.getURL("select.html"),
        active: true
      });
    } else {
      showMessage(`搜索失败：${result?.error || "未知错误"}`);
    }
  } catch (error) {
    showMessage(`搜索失败：${error.message}`);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.searchStatus?.newValue) return;
  const status = changes.searchStatus.newValue;
  if (status.state === "searching") {
    const pageText = status.page ? `第 ${status.page}/${status.totalPages} 页` : "准备中";
    const platformName = PLATFORM_LABELS[status.platform || "jd"] || "商品平台";
    showMessage(`正在读取${platformName}搜索结果：${pageText}…`);
  }
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
    const lowestPrice = Number.isFinite(monitor.lowestPrice)
      ? `¥${monitor.lowestPrice.toFixed(2)}`
      : "未检查";
    const checked = monitor.lastCheckedAt
      ? new Date(monitor.lastCheckedAt).toLocaleString()
      : "尚未检查";
    const error = monitor.lastError ? `<p class="error">${escapeHtml(monitor.lastError)}</p>` : "";
    const selectedProducts = Array.isArray(monitor.selectedProducts)
      ? monitor.selectedProducts
      : [];
    const exampleProducts = Array.isArray(monitor.exampleProducts)
      ? monitor.exampleProducts
      : [];
    const matchRule = monitor.matchRule;
    const basisLabels = { total: "总价", perBox: "每盒价", perUnit: "每单位价" };
    const platformName = PLATFORM_LABELS[monitor.platform || "jd"] || "商品平台";
    const dosageForms = matchRule?.dosageForms || (matchRule?.dosageForm ? [matchRule.dosageForm] : []);
    const strengths = matchRule?.strengths || (matchRule?.strength ? [matchRule.strength] : []);
    const unitSpecs = matchRule?.unitSpecs || (matchRule?.unitSpec ? [matchRule.unitSpec] : []);
    const scope = matchRule
      ? `类型匹配：必含 ${escapeHtml(matchRule.includeKeywords.join("、"))}`
        + (matchRule.excludeKeywords?.length ? `；排除 ${escapeHtml(matchRule.excludeKeywords.join("、"))}` : "")
        + (dosageForms.length ? `；剂型 ${escapeHtml(dosageForms.join("、"))}` : "")
        + (strengths.length ? `；规格 ${escapeHtml(strengths.join("、"))}` : "")
        + (unitSpecs.length ? `；单包装 ${escapeHtml(unitSpecs.join("、"))}` : "")
        + (matchRule.packCounts?.length ? `；盒数 ${matchRule.packCounts.join("、")}` : "；盒数不限")
      : selectedProducts.length
        ? `旧版任务：仅匹配 ${selectedProducts.length} 个指定 SKU`
        : "旧版任务：匹配该关键词下的全部商品";
    const selectedSummary = exampleProducts.length
      ? exampleProducts.slice(0, 2).map((product) => escapeHtml(product.title)).join("；")
        + (exampleProducts.length > 2 ? "…" : "")
      : "";
    const latestProducts = getLatestProducts(monitor);
    const latestProductLinks = latestProducts.length
      ? `<details class="matches"><summary>查看 ${latestProducts.length} 个匹配商品</summary><ul>${latestProducts.map(renderProductLink).join("")}</ul></details>`
      : '<p class="muted">暂无最近一次检查结果</p>';
    const targetSummary = renderTargetSummary(monitor);

    card.innerHTML = `
      <p class="title">${escapeHtml(platformName)}：${escapeHtml(monitor.keyword)}</p>
      <p class="scope">${scope}</p>
      ${selectedSummary ? `<p class="products-summary">${selectedSummary}</p>` : ""}
      <p>目标（${basisLabels[matchRule?.priceBasis || "total"]}）：${targetSummary}　最低：${lowestPrice}</p>
      <p>低价商品：${Number(monitor.eligibleCount || 0)} 个</p>
      ${latestProductLinks}
      ${monitor.missingSelectedCount ? `<p class="error">有 ${monitor.missingSelectedCount} 个商品暂不在搜索结果第一页</p>` : ""}
      <p class="muted">上次检查：${escapeHtml(checked)}</p>
      ${error}
      <div class="actions">
        <button data-action="check" data-id="${monitor.id}">立即检查</button>
        <button data-action="export-xlsx" data-id="${monitor.id}">导出 Excel</button>
        <button data-action="export-csv" data-id="${monitor.id}">导出 CSV</button>
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

  if (button.dataset.action === "export-xlsx") {
    await exportMonitor(button.dataset.id, "xlsx");
    return;
  }

  if (button.dataset.action === "export-csv") {
    await exportMonitor(button.dataset.id, "csv");
    return;
  }

  button.disabled = true;
  showMessage("正在检查…");
  const result = await chrome.runtime.sendMessage({ type: "CHECK_ONE", id });
  button.disabled = false;
  await render();
  showMessage(result?.ok ? "检查完成" : `检查失败：${result?.error || "未知错误"}`);
});

function showMessage(message) {
  messageEl.textContent = message;
}

function sendMessageWithTimeout(message, timeoutMs) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("搜索超时，请重新加载扩展后重试")), timeoutMs);
    })
  ]);
}

function getLatestProducts(monitor) {
  if (Array.isArray(monitor.latestProducts)) return monitor.latestProducts;
  return Object.entries(monitor.matches || {}).map(([id, product]) => ({ id, ...product }));
}

function renderProductLink(product) {
  const comparison = Number.isFinite(product.comparisonPrice)
    ? `比较价 ¥${Number(product.comparisonPrice).toFixed(2)}`
    : `¥${Number(product.price).toFixed(2)}`;
  return `<li class="match-item"><a href="${escapeHtml(product.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.title)}</a><span>实际 ¥${Number(product.price).toFixed(2)} · ${comparison}</span></li>`;
}

function renderTargetSummary(monitor) {
  const rules = monitor.thresholdRules;
  if (rules?.byPack && Object.keys(rules.byPack).length) {
    return Object.entries(rules.byPack)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([pack, threshold]) => `${pack}盒 ¥${Number(threshold).toFixed(2)}`)
      .join("；");
  }
  if (rules?.byVariant && Object.keys(rules.byVariant).length) {
    return Object.entries(rules.byVariant)
      .map(([variant, threshold]) => `${formatVariantKey(variant)} ¥${Number(threshold).toFixed(2)}`)
      .join("；");
  }
  const threshold = Number(rules?.default ?? monitor.threshold);
  return Number.isFinite(threshold) ? `¥${threshold.toFixed(2)}` : "未设置";
}

function formatVariantKey(value) {
  const [strength, unitSpec, packCount] = String(value).split("|");
  return [strength, unitSpec, packCount ? `${packCount}盒` : ""]
    .filter((item) => item && item !== "null")
    .join(" · ") || "规格待确认";
}

async function exportMonitor(id, format = "xlsx") {
  const { monitors } = await chrome.storage.local.get({ monitors: [] });
  const monitor = monitors.find((item) => item.id === id);
  if (!monitor) return showMessage("监控任务不存在");
  const latestProducts = getLatestProducts(monitor);
  const products = latestProducts.filter((product) => {
    const comparisonPrice = Number(product.comparisonPrice);
    const productThreshold = Number(product.threshold);
    const monitorThreshold = Number(monitor.threshold);
    const threshold = Number.isFinite(productThreshold) && productThreshold > 0
      ? productThreshold
      : monitorThreshold;
    return Number.isFinite(comparisonPrice)
      && Number.isFinite(threshold)
      && threshold > 0
      && comparisonPrice < threshold;
  });
  if (!products.length) return showMessage("暂无低于目标价格的商品");

  const priceBasis = monitor.matchRule?.priceBasis || "total";
  const basisLabels = { total: "按商品总价", perBox: "按盒", perUnit: "按单位" };
  const headers = ["平台", "SKU", "商品标题", "当前价格"];
  if (priceBasis !== "total") headers.push("比较价格");
  headers.push("目标价格", "价格计算方式", "剂型", "规格", "单包装数量", "盒数", "链接");

  const rows = [
    headers,
    ...products.map((product) => {
      const row = [
        PLATFORM_LABELS[monitor.platform || "jd"] || monitor.platform || "",
        product.id,
        product.title,
        Number(product.price).toFixed(2)
      ];
      if (priceBasis !== "total") {
        row.push(Number.isFinite(product.comparisonPrice)
          ? Number(product.comparisonPrice).toFixed(2)
          : "");
      }
      row.push(
        Number.isFinite(product.threshold)
          ? Number(product.threshold).toFixed(2)
          : Number.isFinite(monitor.threshold)
            ? Number(monitor.threshold).toFixed(2)
            : "",
        basisLabels[priceBasis] || basisLabels.total,
        product.attributes?.dosageForm || "",
        product.attributes?.strength || "",
        product.attributes?.unitSpec || "",
        product.attributes?.packCount || "",
        String(product.url ?? "").trim()
      );
      return row;
    })
  ];

  if (format === "csv") {
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `price-monitor-${Date.now()}.csv`
    );
    showMessage(`已导出 ${products.length} 个商品 CSV`);
    return;
  }

  const workbook = createXlsxWorkbook(headers, rows.slice(1));
  downloadBlob(
    new Blob([workbook], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    `price-monitor-${Date.now()}.xlsx`
  );
  showMessage(`已导出 ${products.length} 个商品 Excel`);
}

function downloadBlob(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function createXlsxWorkbook(headers, dataRows) {
  const rows = [headers, ...dataRows];
  const hyperlinks = [];
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const cellRef = `${xlsxColumnName(columnIndex)}${rowIndex + 1}`;
      const isUrl = rowIndex > 0
        && columnIndex === row.length - 1
        && /^https:\/\//i.test(String(value ?? "").trim());
      if (isUrl) {
        const relationshipId = `rId${hyperlinks.length + 1}`;
        hyperlinks.push({ cellRef, relationshipId, url: String(value).trim() });
        return inlineStringCell(cellRef, "打开链接");
      }
      return inlineStringCell(cellRef, value);
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");

  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((item) => `<hyperlink ref="${item.cellRef}" r:id="${item.relationshipId}"/>`).join("")}</hyperlinks>`
    : "";
  const relationshipXml = hyperlinks.map((item) =>
    `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(item.url)}" TargetMode="External"/>`
  ).join("");

  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="低价商品" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>${sheetRows}</sheetData>${hyperlinkXml}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`
    },
    {
      name: "xl/worksheets/_rels/sheet1.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationshipXml}</Relationships>`
    }
  ];

  return createStoredZip(files);
}

function inlineStringCell(cellRef, value) {
  return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function xlsxColumnName(index) {
  let name = "";
  let number = index + 1;
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = new TextEncoder().encode(file.content);
    const crc = crc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
}

render();
