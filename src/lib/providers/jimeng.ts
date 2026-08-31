import type { ProviderGenerateRequest, ProviderHandle, ProviderPoll, VideoProvider } from "@/lib/providers/types";

export const jimengProvider: VideoProvider = {
  id: "jimeng",
  capabilities() {
    return {
      modes: ["image_to_video"],
      maxDurationSec: 10,
      supportsLastFrameLock: true,
      maxResolution: "1080p",
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    void req;
    throw new Error("JIMENG_NOT_IMPLEMENTED");
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    void handle;
    throw new Error("JIMENG_NOT_IMPLEMENTED");
  },
};
