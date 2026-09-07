/** 命名空间 `agent`：键统一以 `agent.` 开头。 */
export const agent = {
  /* 首屏 */
  "agent.heroLead": "一切，始于",
  "agent.heroAccent": "一个想法",
  "agent.askLabel": "智能体提示词",
  "agent.askPlaceholder": "说出你的想法，我来生成图片或视频",
  "agent.addAsset": "添加素材",
  "agent.send": "发送",
  "agent.picksTitle": "选择一个技能开始",
  /** 这台实例没配对话提供方（`GET /api/agent/skills` 的 `available: false`）。 */
  "agent.unavailable": "智能体暂未开放",

  /* 三档文本模型（映射温度与输出上限，不是模型名） */
  "agent.tier.fast": "自动 · 极速",
  "agent.tier.balanced": "自动 · 均衡",
  "agent.tier.quality": "自动 · 精创",

  /* 产品下拉 */
  "agent.imageChip": "图片: {name}",
  "agent.videoChip": "视频: {name}",
  "agent.auto": "自动",
  "agent.autoDesc": "智能体将为此请求选择最佳模型",
  "agent.creditsEach": "约 {n} 积分",
  "agent.skill": "技能",
  "agent.skillNone": "不使用技能",
  "agent.manageSkills": "管理工具",

  /* 历史抽屉 */
  "agent.history": "历史记录",
  "agent.historyAria": "智能体历史",
  "agent.drawerTitle": "智能体",
  "agent.collapseHistory": "收起历史记录",
  "agent.newChat": "新建对话",
  "agent.tasksLabel": "任务",
  "agent.noSessions": "还没有会话",
  "agent.deleteSession": "删除会话 {title}",

  /* 技能广场 */
  "agent.plazaTitle": "技能广场",
  "agent.back": "返回智能体",
  "agent.filterAll": "全部",
  "agent.filterOn": "已启用",
  "agent.filterOff": "已关闭",
  "agent.plazaEmpty": "没有符合条件的技能。",
  "agent.enableSkill": "启用技能 {name}",
  "agent.author": "@Genius",

  /* 会话页 */
  "agent.chatInputLabel": "会话输入",
  "agent.chatPlaceholder": "描述你想创建的内容，或提出问题",
  "agent.thinking": "思考中…",
  "agent.usedSkill": "已调用技能",
  "agent.credits": "{n} 积分",
  "agent.jobFailed": "创建失败",
  /** 服务端把限流写成码（`rate_limited`），文案在这里——服务端不翻译。 */
  "agent.jobRateLimited": "创建过于频繁，稍后再让我试一次",
  "agent.assets": "资产",
  "agent.assetsAll": "全部",
  "agent.assetsImage": "图片",
  "agent.assetsVideo": "视频",
  "agent.assetsEmpty": "本次会话还没有作品",
  "agent.assetAria": "作品 {n}",
  "agent.closePreview": "关闭预览",
  "agent.loading": "加载中…",

  /* 任务状态（只分用户看得懂的几档，不逐个映射后端状态机） */
  "agent.statusQueued": "排队中",
  "agent.statusRunning": "生成中",
  "agent.statusSucceeded": "已完成",
  "agent.statusFailed": "失败",
  "agent.statusCanceled": "已取消",
  "agent.statusExpired": "已过期",
  "agent.statusPurged": "已清理",
} as const;
