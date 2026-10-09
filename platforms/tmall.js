// 天猫适配器骨架。完成页面解析后，将 supported 改为 true。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.tmall = {
  id: "tmall",
  name: "天猫",
  supported: false,
  buildSearchUrl(keyword, _page = 1) {
    return `https://list.tmall.com/search_product.htm?q=${encodeURIComponent(keyword)}`;
  }
};
