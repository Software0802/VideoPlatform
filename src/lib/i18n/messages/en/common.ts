import type { common as zh } from "../zh-CN/common";

/** English strings for `common`; the type forces every zh-CN key to exist here. */
export const common: Record<keyof typeof zh, string> = {
  "common.ok": "OK",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.confirm": "Confirm",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.back": "Back",
  "common.comingSoon": "Coming soon",
  "common.error.generic": "Something went wrong. Please try again later.",
  "common.error.network": "Network error. Please try again later.",
  "common.credits": "Credits",
  "common.creditsN": "Credits {n}",
  "common.language": "Language",
  "common.video": "Video",
  "common.image": "Image",
  "common.audio": "Audio",
  "common.all": "All",
  "common.download": "Download",
  "common.share": "Share",
  "common.withAudio": "With sound",
  "common.silent": "Silent",
};
