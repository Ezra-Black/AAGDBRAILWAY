import { logger } from "../logger";

const XAI_EDITS_URL = "https://api.x.ai/v1/images/edits";
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ImagineEditResult {
  buffer: Buffer;
  contentType: string;
  url?: string;
}

function requireApiKey(): string {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error("XAI_API_KEY is not set");
  }
  return key;
}

function timeoutMs(): number {
  const n = Number(process.env.XAI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 10_000 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Edit a placeholder graphic so the sample name becomes the customer's angel name.
 * Uses xAI Imagine edits; never modifies the original file on disk.
 * `imageSource` may be a public https URL or a data URI.
 */
export async function editAngelGraphic(input: {
  angelName: string;
  imageSource: string;
  model?: string;
}): Promise<ImagineEditResult> {
  const apiKey = requireApiKey();
  const model =
    input.model?.trim() ||
    process.env.XAI_IMAGE_MODEL?.trim() ||
    "grok-imagine-image-quality";
  const ms = timeoutMs();

  const prompt =
    `Edit this memorial angel graphic carefully. ` +
    `Keep the exact same artwork, composition, colors, lighting, effects, and lettering style. ` +
    `Only change the personal name text on the graphic so it reads exactly: "${input.angelName}". ` +
    `Replace whatever sample/placeholder name is currently shown with "${input.angelName}". ` +
    `Do not change any other text, symbols, layout, or design elements.`;

  logger.info("Calling xAI image edit", {
    model,
    timeout_ms: ms,
    source_kind: input.imageSource.startsWith("data:") ? "data_uri" : "url",
  });

  let res: Response;
  try {
    res = await fetch(XAI_EDITS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        image: {
          url: input.imageSource,
          type: "image_url",
        },
        response_format: "url",
        n: 1,
      }),
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`xAI image edit timed out after ${ms}ms`);
    }
    throw err;
  }

  const raw = await res.text();
  let json: {
    data?: Array<{ b64_json?: string; url?: string }>;
    error?: { message?: string };
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(
      `xAI image edit returned non-JSON (${res.status}): ${raw.slice(0, 300)}`
    );
  }

  if (!res.ok) {
    const msg = json.error?.message || raw.slice(0, 400);
    throw new Error(`xAI image edit failed (${res.status}): ${msg}`);
  }

  const item = json.data?.[0];
  if (item?.url) {
    logger.info("Downloading xAI result image");
    const imgRes = await fetch(item.url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!imgRes.ok) {
      throw new Error(`Failed to download generated image (${imgRes.status})`);
    }
    const arr = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/png";
    return { buffer: arr, contentType, url: item.url };
  }

  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, "base64"),
      contentType: "image/png",
    };
  }

  logger.error("xAI edit response missing image payload", {
    keys: Object.keys(json),
  });
  throw new Error("xAI image edit response did not include url or b64_json");
}
