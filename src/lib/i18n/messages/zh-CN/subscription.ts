/** 命名空间 `subscription`：键统一以 `subscription.` 开头。 */
export const subscription = {
  /* 我的方案 */
  "subscription.mine.title": "我的方案",
  "subscription.mine.usage": "积分使用详情",
  "subscription.mine.bills": "账单记录",
  "subscription.mine.none": "未订阅",
  "subscription.mine.expiresAt": "{date} 到期",
  "subscription.mine.cycleMonthly": "月付",
  "subscription.mine.cycleYearly": "年付",
  "subscription.mine.daily": "每日积分",
  "subscription.mine.dailyGranted": "今日已发",
  "subscription.mine.dailyPending": "今日待发",
  "subscription.mine.member": "会员积分",
  "subscription.mine.purchased": "已购积分",
  "subscription.mine.redeem": "兑换礼品码",
  "subscription.mine.creditsAria": "积分 {n}",

  /* 订阅方案 */
  "subscription.plans.title": "订阅方案",
  "subscription.plans.cycleAria": "计费周期",
  "subscription.plans.yearly": "按年支付",
  "subscription.plans.monthly": "按月支付",
  "subscription.plans.loading": "读取订阅方案…",
  "subscription.plans.error": "读取订阅方案失败，请稍后再试",

  /* 档位名（服务端只给 id，显示名在这里） */
  "subscription.plan.standard": "标准版",
  "subscription.plan.pro": "专业版",
  "subscription.plan.premium": "尊享版",
  "subscription.plan.ultimate": "至尊版",
  "subscription.plan.popular": "最受欢迎",

  /* 卡片 */
  "subscription.card.perMonth": "/月",
  "subscription.card.monthlyNote": "按月支付，可随时取消",
  "subscription.card.yearlyNote": "年付总额 ¥{total}，折合每月 ¥{monthly}",
  "subscription.card.subscribe": "订阅",
  "subscription.card.current": "当前方案",
  "subscription.card.busy": "处理中…",

  /* 功能行（服务端下发键名，数字在这里填） */
  "subscription.featureCredits": "每 30 天 {credits} 积分（未用完不结转）",
  "subscription.featureDaily": "每日额外赠送 {daily} 积分",
  "subscription.featureMemberFirst": "生成时先扣会员积分，再扣已购积分",
  "subscription.featureAllProducts": "全部视频 / 图片产品可用",

  /* 脚注 */
  "subscription.basis.note": "订阅价按平台成本加固定毛利率计算，随当前生效的模型与档位实时更新，年付不打折。",
  "subscription.basis.payFrom": "订阅从「已购积分」扣款；会员积分只能用于生成，不能用于购买订阅。",

  /* 确认弹窗 */
  "subscription.confirm.title": "确认订阅",
  "subscription.confirm.body": "{plan} · {cycle}，本次扣款 ¥{price}（从已购积分扣）。",
  "subscription.confirm.credits": "到账会员积分 {credits}，每 30 天重置。",
  "subscription.confirm.balance": "当前已购积分 {credits}。",
  "subscription.confirm.go": "确认订阅",

  /* 结果 */
  "subscription.toast.success": "订阅成功，会员积分已到账",
  "subscription.toast.insufficient": "已购积分不足，请先兑换礼品码",
  "subscription.toast.active": "已有生效中的订阅",

  /* 兑换礼品码 */
  "subscription.redeem.title": "兑换礼品码",
  "subscription.redeem.hint": "输入礼品码，积分立即到账（¥1 = 100 积分）。",
  "subscription.redeem.label": "礼品码",
  "subscription.redeem.placeholder": "例如 GIFT-XXXX-XXXX",
  "subscription.redeem.go": "兑换",
  "subscription.redeem.busy": "兑换中…",
  "subscription.redeem.success": "兑换成功，到账 {credits} 积分",

  /* 流水抽屉 */
  "subscription.ledger.grant": "充值 / 兑换",
  "subscription.ledger.charge": "任务扣款",
  "subscription.ledger.adjust": "人工调整",
  "subscription.ledger.empty": "还没有记录。",
  "subscription.ledger.loading": "读取中…",
  "subscription.ledger.more": "加载更多",
  "subscription.ledger.after": "余 {credits}",
  "subscription.ledger.error": "读取失败，请稍后再试",
} as const;
