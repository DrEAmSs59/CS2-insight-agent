import { useState } from "react";
import { ArrowDownToLine, Check, CheckCheck, Gem, Layers3, Monitor, ShieldCheck, Sparkles, Timer, Zap } from "lucide-react";
import { desktopBridge } from "../desktop/desktopBridge";
import { useLocaleStore } from "../i18n/localeStore";
import "./GetProPage.css";

export function safeProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

export default function GetProPage() {
  const en = useLocaleStore((state) => state.effectiveLocale) === "en";
  const [error, setError] = useState("");
  const copy = (zh, english) => (en ? english : zh);
  const downloadUrl = safeProductUrl(import.meta.env.VITE_INSIGHT_PRO_DOWNLOAD_URL || "");
  const openLink = async (url) => {
    if (!url) return;
    try {
      if (desktopBridge) await desktopBridge.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError(copy("暂时无法打开链接，请稍后重试。", "Unable to open the link. Please try again."));
    }
  };
  const features = [
    [Layers3, copy("为地图换一种质感", "A new look for every scene"), copy("更多地图材质，搭配场景与镜头风格。", "More map materials to match your scene and camera style."), "materials"],
    [Zap, copy("让天气参与叙事", "Let the weather tell a story"), copy("闪电效果，为关键时刻增加氛围。", "Lightning effects add atmosphere to key moments."), "weather"],
    [Gem, copy("把饰品细节做到位", "Make the details yours"), copy("饰品更名、贴纸与挂件，完成你的 Demo 造型。", "Custom names, stickers and charms for your demo."), "cosmetics"],
    [Timer, copy("录制跟上创作节奏", "Keep recording moving"), copy("兼容 HLAE 倍速录制，衔接视频制作流程。", "HLAE speed recording compatibility for your video workflow."), "recording"],
  ];

  return (
    <div className="insight-pro-page">
      <div className="pro-page-heading">
        <div>
          <span className="pro-eyebrow">INSIGHT / PRO</span>
          <h1>{copy("获取 Pro 版本", "Get Pro")}</h1>
        </div>
        <span className="pro-build-label">FREE EDITION</span>
      </div>
      <div className="pro-hero">
        <div className="pro-hero-copy">
          <span className="pro-eyebrow"><Sparkles size={14} />{copy("为你的下一部作品", "FOR YOUR NEXT FILM")}</span>
          <h2>{copy("从还原比赛，", "From the match.")}<br /><em>{copy("到表达你的风格。", "To your own style.")}</em></h2>
          <p>{copy("CS2 洞察 Pro，让地图、天气与饰品细节服务于你的镜头。", "CS2 Insight Pro brings maps, weather and cosmetic details into your creative workflow.")}</p>
          <div className="pro-assurances">
            <span><Monitor size={15} />{copy("单设备授权", "One device")}</span>
            <span><ShieldCheck size={15} />{copy("沿用原有数据", "Keep your data")}</span>
            <span><CheckCheck size={15} />{copy("手动续费", "Manual renewal")}</span>
          </div>
        </div>
        <aside className="pro-price-card">
          <span className="pro-plan-name">INSIGHT AGENT <b>PRO</b></span>
          <div className="pro-price"><small>¥</small>6.99<span>/ {copy("30 天", "30 days")}</span></div>
          <p>{copy("激活后计时 · 不自动扣款", "Starts on activation · No automatic charge")}</p>
          <button className="pro-primary-action" type="button" disabled={!downloadUrl} onClick={() => openLink(downloadUrl)}>
            <ArrowDownToLine size={17} />
            {copy("下载 Pro 安装包", "Download Pro installer")}
          </button>
          <span className="pro-availability">
            {downloadUrl
              ? copy("安装 Pro 将替换免费版，保留原有数据", "Replaces the Free app and preserves your data")
              : copy("Pro 正在准备中，下载开放后可在此获取", "Pro downloads will be available here soon")}
          </span>
        </aside>
      </div>
      <section aria-label={copy("Pro 功能", "Pro features")} className="pro-features">
        {features.map(([Icon, title, detail, key], index) => (
          <article className={`pro-feature pro-feature--${key}`} key={key}>
            <div className="pro-feature-top"><Icon size={23} /><span>0{index + 1}</span></div>
            <h3>{title}</h3>
            <p>{detail}</p>
            <span className="pro-feature-caption">{copy("Pro 功能规划", "Planned for Pro")}</span>
          </article>
        ))}
      </section>
      <section className="pro-details-grid">
        <article className="pro-details">
          <h3>{copy("免费版，依然完整保留。", "Free stays free.")}</h3>
          <p>{copy("免费版继续免费下载、免费使用。Pro 使用独立安装包，两版共用数据路径，同一电脑安装时互相替换。", "Free remains free to download and use. Pro has a separate installer; the two editions share your data location and replace each other on installation.")}</p>
          <ul>
            {[
              copy("已有 Demo、录制成果与配置继续保留", "Keep existing demos, recordings and settings"),
              copy("Pro 到期暂停付费能力，不删除你的作品", "Expiration pauses paid features, never deletes your work"),
              copy("具体支持地图与 HLAE 版本以发布说明为准", "Supported maps and HLAE versions are listed in release notes"),
            ].map((item) => <li key={item}><Check size={15} />{item}</li>)}
          </ul>
        </article>
        <article className="pro-details">
          <h3>{copy("三步开始 Pro", "Start in three steps")}</h3>
          <ol className="pro-steps">
            {[
              copy("下载并安装独立 Pro 版", "Install the separate Pro edition"),
              copy("添加开发者微信，转账购买授权", "Contact the developer on WeChat to purchase"),
              copy("领取激活码，绑定当前电脑", "Redeem your code on this computer"),
            ].map((item, index) => <li key={item}><span>{index + 1}</span>{item}</li>)}
          </ol>
        </article>
      </section>
      {error ? <p role="alert" className="pro-error">{error}</p> : null}
      <p className="pro-footnote">{copy("用于离线 Demo 与视频创作。所有权益、兼容范围及售后规则将在购买前明确展示。", "For offline demos and video creation. Features, compatibility and support terms are shown before purchase.")}</p>
    </div>
  );
}
