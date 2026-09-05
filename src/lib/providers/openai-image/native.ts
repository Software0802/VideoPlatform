import { estimateOpenaiImageCostUsd, openaiImagePriceTable } from "@/lib/cost";
import { openaiPost, type OpenaiResponseBody } from "@/lib/providers/openai-image/client";
import { cropToAspect } from "@/lib/providers/openai-image/crop";
import {
  buildImageRequest,
  mapAspectToSize,
  mapQuality,
  parseImageResponse,
  type OpenAiImageUsage,
} from "@/lib/providers/openai-image/rest-map";
import { awaitImageTask, readPendingTask } from "@/lib/providers/openai-image/task-poll";
import { mediaStore } from "@/lib/storage/local-fs";
import {
  ProviderHttpError,
  type ProviderGenerateRequest,
  type ProviderHandle,
  type ProviderPoll,
  type VideoProvider,
} from "@/lib/providers/types";

const IMAGE_PATH = "/images/generations";
/** Staged inside the job dir; the runner renames it to `outputs/image.jpg` after commit. */
const STAGED_OUTPUT = "tmp/image.jpg";

export const openaiImageProvider: VideoProvider = {
  id: "openai",
  capabilities() {
    return {
      modes: ["text_to_image"],
      maxDurationSec: 0,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    if (req.mode !== "text_to_image") {
      throw new ProviderHttpError(400, "unsupported_mode", "OpenAI 生图 provider 只支持文生图");
    }
    // Same two calls `buildImageRequest` makes, so what is billed is what was asked for.
    const { size, crop } = mapAspectToSize(req.aspectRatio, req.imageResolution);
    const quality = mapQuality(req.imageResolution);

    // No business-level retry around this call: gpt-image-1 bills on success, so a second
    // submit for the same job is a second charge. Transport retries stay in fetchUpstream,
    // which only repeats on statuses that never produced an image.
    const response = await openaiPost(IMAGE_PATH, buildImageRequest(req));
    const { png, usage, actualCharge } = await resolveImage(response);
    const jpeg = await cropToAspect(png, crop);
    // Bytes go to the job dir, never into the handle: a base64 data URI on the handle would be
    // copied verbatim into job.json.
    await mediaStore.writeJobFile(req.jobId, STAGED_OUTPUT, jpeg);

    return {
      providerId: "openai",
      remoteId: req.jobId,
      localVideoPath: STAGED_OUTPUT,
      // What the upstream says it actually charged wins over a local estimate — but only when
      // a price table is configured. `actual_charge` is denominated in the upstream's own
      // currency (ccgoai settles in CNY credits) and so is the table, whereas the token
      // fallback is USD; taking it without a table would mix two currencies into one field.
      // See the unit warning in `@/lib/cost`.
      costUsdActual:
        (openaiImagePriceTable() ? actualCharge : undefined) ??
        estimateOpenaiImageCostUsd({ size, quality, outputTokens: usage?.outputTokens }),
      respectModeration: true,
    };
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    // Images are synchronous: submit already staged the file, so the runner goes straight to
    // persisting and never polls. Kept defensive so a stray call cannot hang a job.
    void handle;
    return { status: "done", progress: 100 };
  },
};

/**
 * Turn one generation response into image bytes, whichever of the three shapes came back:
 *
 *  - **200 + JSON** — the original synchronous path, `{ data: [{ b64_json }], usage }`.
 *  - **200 + `image/*`** — a relay answering with the raw frame. No `usage` comes with it, so
 *    pricing falls back to the tier table exactly as it does for a usage-less JSON answer.
 *  - **202 + JSON** — no image yet, only a task handle. `awaitImageTask` polls it to completion
 *    and fetches the result; the billed generation POST is never re-sent.
 *
 * `submit` stays synchronous from the runner's point of view either way: the wait happens here,
 * bounded by `OPENAI_IMAGE_TASK_TIMEOUT_MS`, and the runner still finds a staged file.
 */
async function resolveImage(response: OpenaiResponseBody): Promise<{
  png: Buffer;
  usage?: OpenAiImageUsage;
  actualCharge?: number;
}> {
  if (response.kind === "binary") return { png: response.bytes };
  const pending = readPendingTask(response.status, response.data);
  if (!pending) return parseImageResponse(response.data);
  const outcome = await awaitImageTask(pending);
  return { png: outcome.bytes, usage: outcome.usage, actualCharge: outcome.actualCharge };
}
