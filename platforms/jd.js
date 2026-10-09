// 京东适配器。后续可以继续增加其他平台适配器。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.jd = {
  id: "jd",
  name: "京东",
  supported: true,
  buildSearchUrl(keyword, page = 1) {
    const jdPage = Math.max(1, (Number(page) - 1) * 2 + 1);
    const start = (Math.max(1, Number(page)) - 1) * 30 + 1;
    return `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}&enc=utf-8&page=${jdPage}&s=${start}&click=0`;
  }
};
