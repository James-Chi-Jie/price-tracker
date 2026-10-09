// 天猫适配器。搜索页可能重定向到淘宝搜索域名，但仍由天猫搜索入口发起。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.tmall = {
  id: "tmall",
  name: "天猫",
  supported: true,
  pageNavigation: "url",
  buildSearchUrl(keyword, page = 1) {
    const url = new URL("https://list.tmall.com/search_product.htm");
    url.searchParams.set("q", keyword);
    const pageNumber = Math.max(1, Number(page) || 1);
    if (pageNumber > 1) {
      // 天猫入口常会把 page 参数丢给 s.taobao.com；同时带上结果偏移量，避免重复返回第一页。
      url.searchParams.set("page", String(pageNumber));
      url.searchParams.set("s", String((pageNumber - 1) * 48));
    }
    return url.href;
  }
};
