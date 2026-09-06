import { notFound } from "next/navigation";
import { resolveSharedJob, sharePromptPreview } from "@/lib/share/resolve";
import "@/app/styles/share.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "分享的作品 · Genius",
};

/**
 * 公开播放页（方案 §1.4）。
 *
 * 是页面不是 `/api/*`，`src/proxy.ts` 看不见它——也不需要看见：这一页**故意**不要会话，
 * 令牌就是凭据。服务端直接验签 + 读记录，不绕一圈自己的 HTTP 接口。
 *
 * 全服务端渲染，一行客户端 JS 都没有：`<video controls>` 是浏览器原生的播放器。分享
 * 链接会被转发到微信、飞书这类内置浏览器里，越少东西可以出错越好。
 *
 * 令牌不对、过期、作品已删或产物已清理，一律 `notFound()`——与 `/api/share/:token` 的
 * 404 同一个判据（`resolveSharedJob`），不会出现「页面打得开、视频放不出」。
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rec = await resolveSharedJob(token);
  if (!rec || !rec.output) notFound();

  const output = rec.output;
  const mediaUrl = `/api/share/${encodeURIComponent(token)}/media`;
  const prompt = sharePromptPreview(rec.prompt);
  const durationSec = output.kind === "video" ? output.durationSec || rec.durationSec : 0;

  return (
    <div className="share">
      <div className="share__brand">Genius</div>
      <div className="share__card">
        {output.kind === "video" ? (
          // 用户生成的片子没有字幕轨可给，所以不带 `<track>`。
          <video className="share__media" src={mediaUrl} controls playsInline preload="metadata" />
        ) : (
          // 成片是本地文件、尺寸未知，`next/image` 在这里只会多一层无谓的优化管线。
          // eslint-disable-next-line @next/next/no-img-element
          <img className="share__media" src={mediaUrl} alt={prompt || "分享的作品"} />
        )}
        <div className="share__body">
          {prompt ? <p className="share__prompt">{prompt}</p> : null}
          <div className="share__meta">
            <span className="share__chip">{output.kind === "video" ? "视频" : "图片"}</span>
            {durationSec > 0 ? <span className="share__chip">{durationSec} 秒</span> : null}
            {rec.productName ? <span className="share__chip">{rec.productName}</span> : null}
          </div>
        </div>
      </div>
      <a className="share__cta" href="/login">
        用 Genius 创作
      </a>
      <div className="share__foot">链接有时效，过期后需重新分享</div>
    </div>
  );
}
