/** 命名空间 `create`：创作页（当前任务 / 最近任务）与 `src/lib/client/labels.ts` 的标签表，键以 `create.` 开头。 */
export const create = {
  "create.currentTask": "当前任务",
  "create.noTask": "还没有任务",
  "create.idle": "写一句提示词，从下面的面板开始创作。",
  "create.shots": "生成分镜 {done}/{total}",
  "create.purged": "作品已过期清理，无法重新生成这一条，请重新提交。",
  "create.retry": "重新生成",
  "create.retryShots": "重做失败分镜",
  "create.verify": "核验上游",
  "create.imageAlt": "生成图像",
  "create.recent": "最近任务",
  "create.recentEmpty": "还没有任务记录。",
  "create.firstFrame": "首帧起始",

  /* 创作页「当前任务」那一行的阶段名 */
  "create.stage.queued": "排队中",
  "create.stage.submitting": "已提交",
  "create.stage.pending": "生成中",
  "create.stage.persisting": "写入中",
  "create.stage.directing": "分镜",
  "create.stage.keyframing": "锁帧",
  "create.stage.generating_shots": "生成分镜",
  "create.stage.qc": "质检",
  "create.stage.stitching": "拼接",
  "create.stage.succeeded": "完成",
  "create.stage.failed": "失败",
  "create.stage.expired": "已过期",
  "create.stage.canceled": "已取消",

  /* 六种后端模式的中文名（`labels.ts` 的 MODE_LABEL） */
  "create.mode.text_to_image": "文生图",
  "create.mode.text_to_video": "文生视频",
  "create.mode.image_to_video": "图生视频",
  "create.mode.reference_to_video": "参考生视频",
  "create.mode.edit_video": "编辑视频",
  "create.mode.extend_video": "延长视频",
} as const;
