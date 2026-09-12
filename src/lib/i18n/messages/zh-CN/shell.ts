/** 命名空间 `shell`：侧栏 / 顶栏 / 视图标题 / 通知 / 语言切换 / 修改密码，键统一以 `shell.` 开头。 */
export const shell = {
  /* 侧栏与视图标题共用同一组名字（`views.ts` 只存键名） */
  "shell.nav.home": "主页",
  "shell.nav.create": "创作",
  "shell.nav.agent": "智能体",
  "shell.nav.canvas": "画布",
  "shell.nav.sub": "订阅",
  "shell.nav.account": "账户",
  "shell.nav.aria": "主导航",
  "shell.foot.legal": "条款 · 隐私",

  /* 顶栏 */
  "shell.top.subscribe": "订阅",
  "shell.top.plan.basic": "基础版",
  "shell.top.notifications": "通知",
  "shell.top.notificationsUnread": "通知 {n} 条未读",
  "shell.top.account": "账户",
  "shell.top.changePassword": "修改密码",
  "shell.top.signOut": "退出",
  "shell.top.signingOut": "退出中",

  /* 通知 */
  "shell.notify.empty": "还没有新通知。任务完成时会出现在这里。",
  "shell.notify.dismiss": "关闭通知",
  "shell.notice.done": "作品已生成",
  "shell.notice.canceled": "任务已取消",
  "shell.notice.failed": "生成失败",
  "shell.notice.unknownReason": "未知原因",

  /* 语言切换（顶栏与登录页共用） */
  "shell.lang.switch": "切换语言",

  /* 修改密码弹窗 */
  "shell.pwd.title": "修改密码",
  "shell.pwd.hint": "修改成功后，其它设备上的登录会被下线。",
  "shell.pwd.current": "当前密码",
  "shell.pwd.next": "新密码",
  "shell.pwd.nextPlaceholder": "新密码（至少 {n} 位）",
  "shell.pwd.again": "确认新密码",
  "shell.pwd.againPlaceholder": "再输一次新密码",
  "shell.pwd.err.required": "请填写当前密码与新密码",
  "shell.pwd.err.short": "新密码至少 {n} 位",
  "shell.pwd.err.mismatch": "两次输入的新密码不一致",
  "shell.pwd.err.same": "新密码不能与当前密码相同",
  "shell.pwd.err.wrong": "当前密码不正确",
  "shell.pwd.submitting": "提交中…",
  "shell.pwd.submit": "确认修改",
  "shell.pwd.done": "密码已修改，其它设备已下线",
} as const;
