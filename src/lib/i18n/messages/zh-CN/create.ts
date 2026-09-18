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
  /*
    阻断栏（review 2026-09-15 U-06）。服务端那句 `retryBlocked.message` 是给运维看的
    （「上游可能已接单计费」说的是**我们的**上游账户），普通创作者看到会以为自己被扣了钱。
    用户侧的事实：扣款只在 succeeded 发生（`jobs/store.ts` 的 pendingCharge），非成功的
    终态由 settleRelease 释放预留。所以按两件事分叉——任务是不是已经终态、还有没有核验通道，
    三条都只讲用户自己那份钱与下一步动作，不替上游结论。
  */
  "create.blocked.running": "这一镜在提交后中断了，不会自动重做；其余镜头仍在继续，完成的部分照常出片。",
  "create.blocked.verify": "服务中断，这次提交没有拿到结果。本次尚未扣费——点「核验上游」确认它是不是已经在生成，再决定要不要重新创作。",
  "create.blocked.done": "服务中断，这次创作没有完成。本次没有扣费，预留的积分已经退回，可以直接重新创作。",
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
