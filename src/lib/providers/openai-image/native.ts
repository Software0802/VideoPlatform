import { estimateOpenaiImageCostUsd } from "@/lib/cost";
import { openaiPost } from "@/lib/providers/openai-image/client";
import { cropToAspect } from "@/lib/providers/openai-image/crop";
import {
  buildImageRequest,
  mapAspectToSize,
  mapQuality,
  parseImageResponse,
} from "@/lib/providers/openai-image/rest-map";
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
    const data = await openaiPost(IMAGE_PATH, buildImageRequest(req));
    const { png, usage } = parseImageResponse(data);
    const jpeg = await cropToAspect(png, crop);
    // Bytes go to the job dir, never into the handle: a base64 data URI on the handle would be
    // copied verbatim into job.json.
    await mediaStore.writeJobFile(req.jobId, STAGED_OUTPUT, jpeg);

    return {
      providerId: "openai",
      remoteId: req.jobId,
      localVideoPath: STAGED_OUTPUT,
      costUsdActual: estimateOpenaiImageCostUsd({
        size,
        quality,
        outputTokens: usage?.outputTokens,
      }),
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
