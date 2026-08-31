export type NativeMode =
  | "text_to_image"
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video"
  | "edit_video"
  | "extend_video";

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
export type Resolution = "480p" | "720p" | "1080p";
export type ImageResolution = "1k" | "2k";
export type ProviderId = "grok" | "mock" | "jimeng";

export type MediaRef =
  | { kind: "path"; path: string }
  | { kind: "data_uri"; dataUri: string }
  | { kind: "file_id"; fileId: string }
  | { kind: "url"; url: string };

export type ProviderGenerateRequest = {
  jobId: string;
  mode: NativeMode;
  prompt: string;
  model: string;
  durationSec?: number;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  imageResolution?: ImageResolution;
  generateAudio: boolean;
  startImage?: MediaRef;
  referenceImages?: MediaRef[];
  referenceAudios?: { voiceId: string }[];
  sourceVideo?: MediaRef;
};

export type ProviderHandle = {
  providerId: ProviderId;
  remoteId?: string;
  localVideoPath?: string;
  /** Sync image generations return a URL immediately (no request_id poll). */
  remoteUrl?: string;
  fileOutputId?: string;
  costUsdActual?: number;
  respectModeration?: boolean;
};

export type ProviderPoll = {
  status: "pending" | "done" | "failed" | "expired";
  progress: number;
  remoteUrl?: string;
  durationSec?: number;
  respectModeration?: boolean;
  errorCode?: string;
  errorMessage?: string;
  usage?: {
    costInUsdTicks?: number;
    costUsdActual?: number;
    raw?: unknown;
  };
  fileOutputId?: string;
};

export interface VideoProvider {
  readonly id: ProviderId;
  capabilities(): {
    modes: NativeMode[];
    maxDurationSec: number;
    supportsLastFrameLock: boolean;
    maxResolution: Resolution;
  };
  submit(req: ProviderGenerateRequest): Promise<ProviderHandle>;
  poll(handle: ProviderHandle): Promise<ProviderPoll>;
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}
