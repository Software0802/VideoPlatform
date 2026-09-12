import AccountView from "@/components/genius/account/AccountView";

/**
 * `/account` 账户页（H3）：账号信息、余额 / 订阅摘要与安全操作。
 * 会话校验与能力下发都在 `(shell)/layout.tsx`，这里只挂视图；侧栏不加第六项，
 * 入口在顶栏头像菜单。
 */
export default function AccountPage() {
  return <AccountView />;
}
