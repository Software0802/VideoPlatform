import type { account as zh } from "../zh-CN/account";

/** English strings for `account`; the type forces every zh-CN key to exist here. */
export const account: Record<keyof typeof zh, string> = {
  "account.profile.title": "Account",
  "account.profile.email": "Email",
  "account.profile.joined": "Joined",
  "account.profile.language": "Language",

  "account.balance.title": "Balance",
  "account.balance.purchased": "Purchased credits",
  "account.balance.member": "Member credits",
  "account.balance.reserved": "Reserved",
  "account.balance.available": "Available",
  "account.balance.unitNote":
    "Amounts are in credits (¥1 = 100 credits). Reserved credits are held by jobs still running.",
  "account.balance.subscription": "Subscription",
  "account.balance.ledger": "View ledger",
  "account.balance.topup": "Top up / Subscribe",

  "account.security.title": "Security",
  "account.security.changePassword": "Change password",
  "account.security.logoutAll": "Sign out of all devices",
  "account.security.logoutAllText": "This signs the account out on every device, including this one.",
  "account.security.logoutAllConfirm": "Sign out everywhere",
  "account.security.loggingOut": "Signing out…",
};
