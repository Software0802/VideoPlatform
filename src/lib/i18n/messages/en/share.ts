import type { share as zh } from "../zh-CN/share";

/** English strings for `share`; the type forces every zh-CN key to exist here. */
export const share: Record<keyof typeof zh, string> = {
  "share.metaTitle": "Shared creation · Genius",
  "share.alt": "Shared creation",
  "share.seconds": "{n}s",
  "share.cta": "Create with Genius",
  "share.foot": "This link expires; share again once it does",
};
