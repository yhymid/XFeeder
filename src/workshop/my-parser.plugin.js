// src/workshop/my-parser.plugin.js
module.exports = {
  id: "my-parser",
  enabled: true,
  init(api) {
    api.registerParser({
      name: "my-parser",
      priority: 50,
      test: (url) => url.includes("example.com"),
      parse: async (url, ctx) => {
        const res = await ctx.get(url);
        return [{
          title: "Example",
          link: url,
          contentSnippet: "Description",
          isoDate: new Date().toISOString(),
          guid: url
        }];
      }
    });
  }
};