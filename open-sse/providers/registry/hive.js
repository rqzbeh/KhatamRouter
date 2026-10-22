// Hive AI — self-hosted OpenAI-compatible LLMs (https://docs.thehive.ai).
// Context window / tool / modality metadata lives in providers/capabilities.js
// (the canonical source); this file only declares ids and display.
export default {
  id: "hive",
  priority: 119,
  alias: "hive",
  // "hive-ai" is the provider key used in Hive's own CLI-config examples.
  aliases: [
    "hive-ai",
  ],
  uiAlias: "hive",
  display: {
    name: "Hive",
    icon: "layers",
    color: "#1089F5",
    textIcon: "HV",
    website: "https://thehive.ai",
    notice: {
      text: "OpenAI-compatible. Self-hosted 1M-context LLMs with vision and tool calling.",
      apiKeyUrl: "https://docs.thehive.ai/docs/chat-completions-openai-compatible-llms#create-your-v3-api-key",
    },
  },
  category: "apikey",
  transport: {
    // api.thehive.ai and api-cdn.thehive.ai both serve /api/v3; api-va1 is the
    // Virginia region host. Verified live: both return 200 for the seed models.
    // No validateUrl: Hive exposes no GET-able /models (404), so deriveValidateUrl
    // is left to build the conventionally-correct probe URL.
    baseUrl: "https://api.thehive.ai/api/v3/chat/completions",
  },
  // Hive rejects the bare short ids: POST /api/v3/chat/completions with
  // model "deepseek-v4.1-flash" returns 400 "Invalid Model Name", while
  // "deepseek-ai/deepseek-v4.1-flash" returns 200 (verified live 2026-09-30).
  // The aliases are therefore a real rewrite, not dead flexibility.
  models: [
    { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "zai-org/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (short)", upstreamModelId: "deepseek-ai/deepseek-v4.1-flash" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (short)", upstreamModelId: "zai-org/glm-5.3-flash" },
  ],
  passthroughModels: true,
};
