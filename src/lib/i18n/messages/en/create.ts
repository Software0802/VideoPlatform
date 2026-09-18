import type { create as zh } from "../zh-CN/create";

/** English strings for `create`; the type forces every zh-CN key to exist here. */
export const create: Record<keyof typeof zh, string> = {
  "create.currentTask": "Current job",
  "create.noTask": "No job yet",
  "create.idle": "Write a prompt and start from the panel below.",
  "create.shots": "Rendering shots {done}/{total}",
  "create.purged": "This creation was cleared after expiry and cannot be regenerated — submit it again.",
  "create.retry": "Generate again",
  "create.retryShots": "Redo failed shots",
  "create.verify": "Verify upstream",
  "create.blocked.running":
    "This shot was interrupted after it was submitted and will not be retried automatically; the other shots are still running.",
  "create.blocked.verify":
    "The service was interrupted and this submission returned no result. You have not been charged — use \u201cVerify upstream\u201d to check whether it is already generating before creating again.",
  "create.blocked.done":
    "The service was interrupted and this creation did not finish. You were not charged and the reserved credits are back in your balance — you can create again.",
  "create.imageAlt": "Generated image",
  "create.recent": "Recent jobs",
  "create.recentEmpty": "No jobs yet.",
  "create.firstFrame": "Starts from the first frame",

  "create.stage.queued": "Queued",
  "create.stage.submitting": "Submitted",
  "create.stage.pending": "Generating",
  "create.stage.persisting": "Writing",
  "create.stage.directing": "Shot planning",
  "create.stage.keyframing": "Locking keyframes",
  "create.stage.generating_shots": "Rendering shots",
  "create.stage.qc": "Quality check",
  "create.stage.stitching": "Stitching",
  "create.stage.succeeded": "Done",
  "create.stage.failed": "Failed",
  "create.stage.expired": "Expired",
  "create.stage.canceled": "Canceled",

  "create.mode.text_to_image": "Text to image",
  "create.mode.text_to_video": "Text to video",
  "create.mode.image_to_video": "Image to video",
  "create.mode.reference_to_video": "Reference to video",
  "create.mode.edit_video": "Edit video",
  "create.mode.extend_video": "Extend video",
};
