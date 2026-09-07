import type { shell as zh } from "../zh-CN/shell";

/** English strings for `shell`; the type forces every zh-CN key to exist here. */
export const shell: Record<keyof typeof zh, string> = {
  "shell.nav.home": "Home",
  "shell.nav.create": "Create",
  "shell.nav.agent": "Agent",
  "shell.nav.canvas": "Canvas",
  "shell.nav.sub": "Subscription",
  "shell.nav.aria": "Main navigation",
  "shell.foot.legal": "Terms · Privacy",

  "shell.top.subscribe": "Subscribe",
  "shell.top.plan.basic": "Basic",
  "shell.top.notifications": "Notifications",
  "shell.top.notificationsUnread": "Notifications, {n} unread",
  "shell.top.account": "Account",
  "shell.top.changePassword": "Change password",
  "shell.top.signOut": "Sign out",
  "shell.top.signingOut": "Signing out",
  "shell.signOutFailed": "Sign-out failed",

  "shell.notify.empty": "No notifications yet. Finished jobs will show up here.",
  "shell.notify.dismiss": "Dismiss notification",
  "shell.notice.done": "Your creation is ready",
  "shell.notice.canceled": "Job canceled",
  "shell.notice.failed": "Generation failed",
  "shell.notice.unknownReason": "Unknown reason",

  "shell.lang.switch": "Switch language",

  "shell.pwd.title": "Change password",
  "shell.pwd.hint": "Once changed, sessions on other devices are signed out.",
  "shell.pwd.current": "Current password",
  "shell.pwd.next": "New password",
  "shell.pwd.nextPlaceholder": "New password ({n} characters or more)",
  "shell.pwd.again": "Confirm new password",
  "shell.pwd.againPlaceholder": "Type the new password again",
  "shell.pwd.err.required": "Enter both the current and the new password",
  "shell.pwd.err.short": "The new password needs at least {n} characters",
  "shell.pwd.err.mismatch": "The two new passwords do not match",
  "shell.pwd.err.same": "The new password must differ from the current one",
  "shell.pwd.submitting": "Submitting…",
  "shell.pwd.submit": "Change password",
  "shell.pwd.done": "Password changed. Other devices have been signed out.",
};
