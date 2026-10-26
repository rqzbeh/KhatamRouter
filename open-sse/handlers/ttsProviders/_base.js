// Shared TTS helpers
import { Buffer } from "node:buffer";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MiB

// Convert upstream Response (binary audio) to { base64, format }
export async function responseToBase64(res, defaultFormat = "mp3") {
  const clenHeader = res.headers?.get?.("content-length");
  if (clenHeader) {
    const clen = parseInt(clenHeader, 10);
    if (Number.isFinite(clen) && clen > MAX_AUDIO_BYTES) {
      throw new Error(`Upstream audio exceeds maximum allowed size of ${MAX_AUDIO_BYTES} bytes`);
    }
  }

  let buf;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_AUDIO_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`Upstream audio exceeds maximum allowed size of ${MAX_AUDIO_BYTES} bytes`);
        }
        chunks.push(value);
      }
      buf = Buffer.concat(chunks);
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
  } else {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`Upstream audio exceeds maximum allowed size of ${MAX_AUDIO_BYTES} bytes`);
    }
    buf = Buffer.from(ab);
  }

  if (buf.byteLength < 100) throw new Error("Upstream returned empty audio");
  const ctype = res.headers?.get?.("content-type") || "";
  let format = defaultFormat;
  if (ctype.includes("wav")) format = "wav";
  else if (ctype.includes("mpeg") || ctype.includes("mp3")) format = "mp3";
  else if (ctype.includes("ogg")) format = "ogg";
  else if (ctype.includes("pcm")) format = "pcm";
  return { base64: Buffer.from(buf).toString("base64"), format };
}

export async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  let msg = `Upstream error (${res.status})`;
  try {
    const parsed = JSON.parse(text);
    msg = parsed?.error?.message || parsed?.message || parsed?.detail?.message || (typeof parsed?.detail === "string" ? parsed.detail : null) || text || msg;
  } catch { msg = text || msg; }
  throw new Error(msg);
}

// Parse `model` string as "modelId/voiceId" — match against known model list (longest prefix wins)
export function parseModelVoice(model, defaultModel = "", defaultVoice = "", knownModels = []) {
  if (!model) return { modelId: defaultModel, voiceId: defaultVoice };
  const known = knownModels.map((m) => m.id || m).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of known) {
    if (model === id) return { modelId: id, voiceId: defaultVoice };
    if (model.startsWith(`${id}/`)) return { modelId: id, voiceId: model.slice(id.length + 1) };
  }
  const idx = model.lastIndexOf("/");
  if (idx > 0) return { modelId: model.slice(0, idx), voiceId: model.slice(idx + 1) };
  return { modelId: defaultModel || model, voiceId: defaultVoice || model };
}
