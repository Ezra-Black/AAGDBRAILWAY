import { logger } from "../logger";

const XAI_EDITS_URL = "https://api.x.ai/v1/images/edits";

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

/**
 * Edit a placeholder graphic so the sample name becomes the customer's angel name.
 * Uses xAI Imagine edits; never modifies the original file on disk.
 */
export async function editAngelGraphic(input: {
  angelName: string;
  imageDataUri: string;
  model?: string;
}): Promise<ImagineEditResult> {
  const apiKey = requireApiKey();
  const model =
    input.model?.trim() ||
    process.env.XAI_IMAGE_MODEL?.trim() ||
    "grok-imagine-image-quality";

  const prompt =
    `Edit this memorial angel graphic carefully. ` +
    `Keep the exact same artwork, composition, colors, lighting, effects, and lettering style. ` +
    `Only change the personal name text on the graphic so it reads exactly: "${input.angelName}". ` +
    `Replace whatever sample/placeholder name is currently shown with "${input.angelName}". ` +
    `Do not change any other text, symbols, layout, or design elements.`;

  const res = await fetch(XAI_EDITS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      image: {
        url: input.imageDataUri,
        type: "image_url",
      },
      response_format: "b64_json",
      n: 1,
    }),
  });

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
  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, "base64"),
      contentType: "image/png",
    };
  }

  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download generated image (${imgRes.status})`);
    }
    const arr = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/png";
    return { buffer: arr, contentType, url: item.url };
  }

  logger.error("xAI edit response missing image payload", {
    keys: Object.keys(json),
  });
  throw new Error("xAI image edit response did not include b64_json or url");
}
