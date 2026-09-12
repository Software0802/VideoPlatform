import type { subscription as zh } from "../zh-CN/subscription";

/** English strings for `subscription`; the type forces every zh-CN key to exist here. */
export const subscription: Record<keyof typeof zh, string> = {
  "subscription.mine.title": "My plan",
  "subscription.mine.usage": "Credit usage",
  "subscription.mine.bills": "Billing history",
  "subscription.mine.none": "No subscription",
  "subscription.mine.expiresAt": "Expires {date}",
  "subscription.mine.cycleMonthly": "Monthly",
  "subscription.mine.cycleYearly": "Yearly",
  "subscription.mine.daily": "Daily credits",
  "subscription.mine.dailyGranted": "Granted today",
  "subscription.mine.dailyPending": "Pending today",
  "subscription.mine.member": "Member credits",
  "subscription.mine.purchased": "Purchased credits",
  "subscription.mine.redeem": "Redeem gift code",
  "subscription.mine.creditsAria": "Credits {n}",

  "subscription.plans.title": "Plans",
  "subscription.plans.cycleAria": "Billing cycle",
  "subscription.plans.yearly": "Pay yearly",
  "subscription.plans.monthly": "Pay monthly",
  "subscription.plans.loading": "Loading plans…",
  "subscription.plans.error": "Could not load the plans. Please try again later.",

  "subscription.plan.standard": "Standard",
  "subscription.plan.pro": "Pro",
  "subscription.plan.premium": "Premium",
  "subscription.plan.ultimate": "Ultimate",
  "subscription.plan.popular": "Most popular",

  "subscription.card.perMonth": "/mo",
  "subscription.card.monthlyNote": "Billed monthly, cancel anytime",
  "subscription.card.yearlyNote": "¥{total} per year, ¥{monthly} per month",
  "subscription.card.subscribe": "Subscribe",
  "subscription.card.current": "Current plan",
  "subscription.card.busy": "Working…",

  "subscription.featureCredits": "{credits} credits every 30 days (no rollover)",
  "subscription.featureDaily": "{daily} bonus credits every day",
  "subscription.featureMemberFirst": "Generations spend member credits first, purchased credits after",
  "subscription.featureAllProducts": "Every video and image product included",

  "subscription.basis.note":
    "Prices are platform cost plus a fixed margin, recalculated from the models in use; yearly is not discounted.",
  "subscription.basis.payFrom":
    "Subscriptions are paid from purchased credits. Member credits can only be spent on generations, never on a subscription.",

  "subscription.confirm.title": "Confirm subscription",
  "subscription.confirm.body": "{plan} · {cycle} — ¥{price} will be charged to your purchased credits.",
  "subscription.confirm.credits": "{credits} member credits land right away and reset every 30 days.",
  "subscription.confirm.balance": "You have {credits} purchased credits.",
  "subscription.confirm.go": "Subscribe",

  "subscription.toast.success": "Subscribed — member credits added",
  "subscription.toast.insufficient": "Not enough purchased credits. Redeem a gift code first.",
  "subscription.toast.active": "You already have an active subscription",

  "subscription.redeem.title": "Redeem gift code",
  "subscription.redeem.hint": "Enter a gift code and the credits land right away (¥1 = 100 credits).",
  "subscription.redeem.label": "Gift code",
  "subscription.redeem.placeholder": "e.g. GIFT-XXXX-XXXX",
  "subscription.redeem.go": "Redeem",
  "subscription.redeem.busy": "Redeeming…",
  "subscription.redeem.success": "Redeemed — {credits} credits added",

  "subscription.ledger.grant": "Top-up / redemption",
  "subscription.ledger.charge": "Job charge",
  "subscription.ledger.adjust": "Manual adjustment",
  "subscription.ledger.empty": "Nothing here yet.",
  "subscription.ledger.loading": "Loading…",
  "subscription.ledger.more": "Load more",
  "subscription.ledger.after": "Balance {credits}",
  "subscription.ledger.error": "Could not load. Please try again later.",
};
