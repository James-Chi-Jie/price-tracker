// 拼多多适配器。只读取公开搜索结果，不绕过登录、验证码或风控验证。
self.PriceAdapters = self.PriceAdapters || {};
self.PriceAdapters.pdd = {
  id: "pdd",
  name: "拼多多",
  supported: true,
  pageNavigation: "url",
  buildSearchUrl(keyword, page = 1) {
    const url = new URL("https://mobile.yangkeduo.com/search_result.html");
    url.searchParams.set("search_key", keyword);
    const pageNumber = Math.max(1, Number(page) || 1);
    if (pageNumber > 1) url.searchParams.set("page", String(pageNumber));
    return url.href;
  }
};
