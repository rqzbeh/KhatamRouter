export default {
  id: "opencode-warp",
  priority: 39,
  hasFree: true,
  alias: "ocw",
  uiAlias: "ocw",
  display: {
    name: "OpenCode Free (WARP egress)",
    icon: "terminal",
    color: "#28C76F",
    textIcon: "OCW",
    description:
      "Same free Zen lane, but every request leaves through the bundled Cloudflare WARP sidecar so the exit IP rotates per request instead of being the one shared IP that earns the 403 FreeTierError.",
  },
  category: "free",
  noAuth: true,
  // Resolved at request time in connectionProxy.js: there is no pool row to
  // bind for a no-auth provider, so the resolver synthesizes the managed pool.
  managedSidecarPoolId: "opencode-warp-managed",
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content. stream.js lifts
      // the alias into reasoning_content for OpenAI-shaped clients; every other
      // model on the lane already emits reasoning_content, so the lift is a no-op.
      reasoningAliasFields: true,
    },
  },
  models: [
    { id: "beam-free", name: "Beam Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free" },
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    // jev is served from /zen/v1/systemone, which the sidecar URL rewriter does
    // not map, so it is left out of this lane until the daemon serves it.
    { id: "gpt-4o-mini-free", name: "GPT-4o Mini Free", targetFormat: "openai" },
    { id: "claude-3-haiku-free", name: "Claude 3 Haiku Free", targetFormat: "claude" },
    { id: "llama-3.1-8b-free", name: "Llama 3.1 8B Instruct Free", targetFormat: "openai" },
    { id: "mixtral-8x7b-free", name: "Mixtral 8x7B Instruct Free", targetFormat: "openai" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  liveCatalog: true,
  passthroughModels: true,
};
