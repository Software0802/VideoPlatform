import { HomeView } from "@/components/genius/home/HomeView";

/** `/` 主页。会话校验与能力下发都在 `(shell)/layout.tsx`，这里只挂视图。 */
export default function HomePage() {
  return <HomeView />;
}
