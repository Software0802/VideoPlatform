/** 命名空间 `account`：账户页（/account，H3）三张卡，键统一以 `account.` 开头。 */
export const account = {
  /* 账号 */
  "account.profile.title": "账号",
  "account.profile.email": "邮箱",
  "account.profile.joined": "注册时间",
  "account.profile.language": "界面语言",

  /* 余额（数字单位是积分：¥1 = 100 积分，与顶栏同一口径） */
  "account.balance.title": "余额",
  "account.balance.purchased": "已购积分",
  "account.balance.member": "会员积分",
  "account.balance.reserved": "在途预留",
  "account.balance.available": "可用积分",
  "account.balance.unitNote": "单位为积分，¥1 = 100 积分；在途预留是进行中任务占住、暂不可用的部分。",
  "account.balance.subscription": "订阅",
  "account.balance.ledger": "查看流水",
  "account.balance.topup": "充值 / 订阅",

  /* 安全 */
  "account.security.title": "安全",
  "account.security.changePassword": "修改密码",
  "account.security.logoutAll": "退出全部设备",
  "account.security.logoutAllText": "将退出这个账号在所有设备上的登录，包括当前这台。",
  "account.security.logoutAllConfirm": "确认退出",
  "account.security.loggingOut": "退出中…",
} as const;
