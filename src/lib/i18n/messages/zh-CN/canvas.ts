/**
 * 命名空间 `canvas`：画布视图（占位数据视图，不接后端），键统一以 `canvas.` 开头。
 * 原型里刻意保留英文的几处（工具名、`Upload a picture` / `Output Results` 节点标签）
 * 仍是字面量，不进字典——见 `DESIGN.md`「与交接包的有意偏离」。
 */
export const canvas = {
  /* 空态 */
  "canvas.empty.rightClick": "右键",
  "canvas.empty.title": "在画布上放下第一个节点",
  "canvas.empty.sub": "从这里开始搭建你的镜头流程",
  "canvas.entry.image": "生图",
  "canvas.entry.story": "故事视频",
  "canvas.entry.three": "三视图",
  "canvas.entry.grid": "九宫格",

  /* 节点 */
  "canvas.node.text1": "文本 1",
  "canvas.node.img1": "图片 1",
  "canvas.node.text3": "文本 3",
  "canvas.node.video2": "视频 2",
  "canvas.node.handleLeft": "在左侧添加节点",
  "canvas.node.handleRight": "在右侧添加节点",
  "canvas.node.hintVideo": "生成视频",
  "canvas.node.hintText": "请输入内容…",
  "canvas.rte.aria": "富文本",
  "canvas.nodeText1":
    "为一款便携式投影仪创作一张 4:5 的社交媒体信息流广告。夜晚的城市屋顶上，三位年轻朋友正在观看投影到白墙上的电影，周围环绕着温暖的串灯。将便携式投影仪置于地面在前景中，清晰展示产品。添加醒目的标题「随时随地，畅享影院」，辅助文案「大屏之夜，随行随实」，并在右下角设置「立刻购买」按钮。写实商业摄影，Instagram 和 Facebook DTC 广告风格，移动端优先构图，版式简洁，文字少而清晰易读。",
  "canvas.seedPrompt": "我要生成一个一家人在家里看恐龙摧毁城市的视频",
  "canvas.videoSeedPrompt": "根据提示词生成视频",
  "canvas.result.title": "便携投影仪 · 社交媒体广告方案",
  "canvas.result.concept": "广告概念：「家庭恐龙之夜」",
  "canvas.result.sceneLabel": "场景描述",
  "canvas.result.scene":
    "核心画面：一家三口坐在客厅地板上，投影仪把恐龙横穿城市的画面投到白墙上，孩子伸手去碰投影里的恐龙。",
  "canvas.result.layoutLabel": "广告版式（4:5）",

  /* 提示词面板 */
  "canvas.prompt.text": "文本",
  "canvas.prompt.addRef": "添加参考",
  "canvas.prompt.fromToolbox": "从工具箱选择参考",
  "canvas.prompt.aria": "画布提示词",
  "canvas.prompt.placeholder": "描述您想要生成的任何内容…",
  "canvas.prompt.send": "发送",
  "canvas.vidchip": "参考 · 16:9 · 540p · 3秒",
  "canvas.modelpop.title": "模型",
  "canvas.model.claude": "擅长复杂推理、长上下文理解和高质量写作",
  "canvas.model.seed": "中文理解能力强，非常适合创意生成和图片任务",
  "canvas.model.qwen": "平衡的通用能力，助力高性价比的日常创作",

  /* 节点类型菜单 */
  "canvas.menu.text": "文本",
  "canvas.menu.image": "图片",
  "canvas.menu.video": "视频",
  "canvas.menu.audio": "音频",
  "canvas.menu.board": "分镜表",

  /* 右上 / 左侧 / 左下浮层 */
  "canvas.topright.share": "分享",
  "canvas.topright.assistant": "智能助手",
  "canvas.tools.add": "添加节点",
  "canvas.tools.select": "选择",
  "canvas.tools.assets": "素材",
  "canvas.tools.toolbox": "工具箱",
  "canvas.tools.undo": "撤销",
  "canvas.tools.redo": "重做",
  "canvas.bottom.panels": "面板",
  "canvas.bottom.fit": "适应画布",
  "canvas.bottom.minimap": "缩略图",
  "canvas.bottom.zoom": "缩放",

  /* 工具箱抽屉 */
  "canvas.toolbox.title": "工具箱",
  "canvas.toolbox.close": "关闭工具箱",
  "canvas.toolbox.tab.community": "社区工具",
  "canvas.toolbox.tab.mine": "我的工具",
  "canvas.toolbox.search": "搜索工具",
  "canvas.toolbox.filter": "筛选",
  "canvas.toolbox.uses": "{n} 次使用 · 作者 hu…",
  "canvas.toolbox.apply": "应用到画布",
  "canvas.toolbox.empty": "没有匹配的工具。",
  "canvas.cat.all": "全部",
  "canvas.cat.image": "图像生成",
  "canvas.cat.video": "视频生成",
  "canvas.cat.audio": "音频与人声",
  "canvas.cat.util": "实用",
} as const;
