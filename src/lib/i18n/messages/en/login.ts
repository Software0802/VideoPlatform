import type { login as zh } from "../zh-CN/login";

/** English strings for `login`; the type forces every zh-CN key to exist here. */
export const login: Record<keyof typeof zh, string> = {
  "login.metaTitle": "Sign in · Genius",
  "login.tabs.aria": "Sign in or sign up",
  "login.tab.login": "Sign in",
  "login.tab.register": "Sign up",
  "login.title": "Enter Genius",
  "login.sub": "Sign in to keep creating; signing up needs a one-time invite code.",
  "login.email": "Email",
  "login.password": "Password",
  "login.passwordWithMin": "Password ({n} characters or more)",
  "login.invite": "Invite code",
  "login.invitePlaceholder": "12 letters and digits",
  "login.err.email": "That email address doesn't look right",
  "login.err.password": "Password needs at least {n} characters",
  "login.err.invite": "Enter your invite code",
  "login.submitting": "Working",
  "login.hint.register": "Each invite code works once and then expires; ask an admin if you don't have one.",
  "login.hint.login": "No account yet? Switch to “Sign up” and enter an invite code.",
};
