/** 中转管理页 `/admin/relays`（N3.5）的文案，统一 `admin.` 前缀。 */
export const admin = {
  "admin.relays.title": "中转列表",
  "admin.relays.hint":
    "配置来源：文件 > LUMEN_RELAYS 种子 > 老 env 折算。只显示环境变量名，密钥留在 .env。",
  "admin.relays.loading": "正在读取中转列表…",
  "admin.relays.empty": "还没有中转。",
  "admin.relays.forbidden": "无权限",
  "admin.relays.envManaged": "由环境变量定义，改 .env",
  "admin.relays.managedOnly": "仅文件管理的条目可改",

  "admin.relays.source.file": "文件",
  "admin.relays.source.envSeed": "env 种子",
  "admin.relays.source.legacy": "老 env",

  "admin.relays.channel.video": "视频",
  "admin.relays.channel.image": "图片",
  "admin.relays.channel.chat": "对话",

  "admin.relays.health.ok": "正常",
  "admin.relays.health.cooldown": "冷却",
  "admin.relays.health.halfOpen": "半开",

  "admin.relays.key.has": "有 key",
  "admin.relays.key.missing": "无 key",

  "admin.relays.catalog.none": "无目录",
  "admin.relays.catalog.snapshot": "快照",

  "admin.relays.enabled": "已启用",
  "admin.relays.disabled": "已停用",
  "admin.relays.up": "上移",
  "admin.relays.down": "下移",
  "admin.relays.discover": "目录发现",
  "admin.relays.probe": "探测",
  "admin.relays.delete": "删除",

  "admin.relays.probeConfirm":
    "探测会向 {name} 发一次真实请求（一张 1K 图或一句对话），上游可能计费。继续？",
  "admin.relays.deleteConfirm": "删除中转 {name}？历史任务记录仍可解析（影子表）。",
  "admin.relays.probe.result": "探测：HTTP {status} · {ms}ms · {detail}",
  "admin.relays.discover.result": "目录 {n} 个模型，新增 {added}，消失 {removed}",

  "admin.relays.create": "新建中转",
  "admin.relays.creating": "创建中…",
  "admin.relays.createSubmit": "创建",
  "admin.relays.form.name": "名称",
  "admin.relays.form.priority": "优先级",
  "admin.relays.form.channels": "通道",
  "admin.relays.form.imageModel": "图片模型",
  "admin.relays.form.chatModel": "对话模型",
  "admin.relays.form.catalogSource": "目录来源",
};
