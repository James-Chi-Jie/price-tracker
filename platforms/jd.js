// 京东适配器。后续可以增加 platforms/taobao.js、platforms/pdd.js 等适配器。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.jd = {
  id: "jd",
  name: "京东",
  canHandle(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === "jd.com" || hostname.endsWith(".jd.com");
    } catch {
      return false;
    }
  }
};
