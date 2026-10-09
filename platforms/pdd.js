// 拼多多适配器骨架。完成页面解析后，将 supported 改为 true。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.pdd = {
  id: "pdd",
  name: "拼多多",
  supported: false,
  buildSearchUrl(keyword, _page = 1) {
    return `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(keyword)}`;
  }
};
