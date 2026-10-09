// 淘宝适配器。只读取搜索结果页公开展示的商品卡片。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.taobao = {
  id: "taobao",
  name: "淘宝",
  supported: true,
  pageNavigation: "url",
  buildSearchUrl(keyword, page = 1) {
    const url = new URL("https://s.taobao.com/search");
    url.searchParams.set("q", keyword);
    const pageNumber = Math.max(1, Number(page) || 1);
    if (pageNumber > 1) {
      url.searchParams.set("page", String(pageNumber));
      url.searchParams.set("s", String((pageNumber - 1) * 44));
    }
    return url.href;
  }
};
