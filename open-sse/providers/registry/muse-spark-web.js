export default {
  id: "muse-spark-web",
  priority: 150,
  alias: "muse-spark-web",
  // NOTE: "muse" is deliberately NOT an alias here — the official Meta Model API
  // provider `muse` already owns that token. Aliasing both would make
  // `muse/model` resolve to whichever registry entry is imported last.
  aliases: [
    "muse-spark-web-cookie",
    "metai-web",
  ],
  uiAlias: "muse",
  display: {
    name: "Muse Spark Web (Meta AI)",
    icon: "psychology",
    color: "#0064FF",
    textIcon: "MS",
    website: "https://www.meta.ai",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your ecto_1_sess= cookie value from meta.ai",
  transport: {
    baseUrl: "https://www.meta.ai/api/graphql",
    format: "muse-spark-web",
    authType: "cookie",
  },
  models: [
    { id: "muse-spark", name: "Muse Spark" },
    { id: "muse-spark-thinking", name: "Muse Spark (Thinking)" },
    { id: "muse-spark-contemplating", name: "Muse Spark (Contemplating)" },
  ],
  passthroughModels: true,
};
