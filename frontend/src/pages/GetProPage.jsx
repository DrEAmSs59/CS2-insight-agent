import { useState } from "react";
import { Check, Gem, Layers3, Timer, Zap } from "lucide-react";
import { desktopBridge } from "../desktop/desktopBridge";
import { useLocaleStore } from "../i18n/localeStore";
import "./GetProPage.css";

const SITE_URL = "https://ciacut.cc/";
const WECHAT_ID = "CS2INAIGHTAGENT";
const QQ_GROUPS = [
  ["1群", "1078028719"],
  ["2群", "1042360781"],
];

export default function GetProPage() {
  const en = useLocaleStore((state) => state.effectiveLocale) === "en";
  const [error, setError] = useState("");
  const copy = (zh, english) => (en ? english : zh);
  const openLink = async (url) => {
    try {
      if (desktopBridge) await desktopBridge.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError(copy("暂时无法打开链接，请稍后重试。", "Unable to open the link. Please try again."));
    }
  };
  const features = [
    [Layers3, copy("为地图换一种质感", "A new look for every scene"), copy("更多地图材质/滤镜，搭配场景与镜头风格。", "More map materials and filters to match your scene and camera style."), "materials"],
    [Zap, copy("让天气参与叙事", "Let the weather tell a story"), copy("闪电暴雨、漫天飞雪等效果，为关键时刻增加氛围。", "Lightning storms, snowfall and other effects add atmosphere to key moments."), "weather"],
    [Gem, copy("把饰品细节做到位", "Make the details yours"), copy("饰品更名、自定义贴纸与挂件，让高级饰品点缀你的高光。", "Custom names, stickers and charms let premium items dress your highlights."), "cosmetics"],
    [Timer, copy("录制跟上创作节奏", "Keep recording moving"), copy("兼容 HLAE 倍速录制，衔接视频制作流程。", "HLAE speed recording compatibility for your video workflow."), "recording"],
  ];

  return (
    <div className="insight-pro-page">
      <div className="pro-offer">
        <div className="pro-page-heading">
          <span className="pro-eyebrow">INSIGHT / PRO</span>
          <h1>{copy("获取 Pro 版本", "Get Pro")}</h1>
        </div>
        <div className="pro-intro">
          <aside className="pro-price-card">
            <span className="pro-plan-name">INSIGHT AGENT <b>PRO</b></span>
            <div className="pro-price"><small>¥</small>6.99<span>/ {copy("30 天", "30 days")}</span></div>
            <p className="pro-terms">{copy("激活后计时 · 不自动扣款。", "Starts on activation. No automatic charge.")}</p>
            <p className="pro-terms">{copy("若之前有捐赠，请添加微信，截图捐赠记录，会获得对应捐赠金额的 Pro 期限。", "If you donated before, add the developer on WeChat and send a screenshot of the record. You receive Pro time matching that amount.")}</p>
            <p className="pro-terms">{copy("一台电脑、一个激活码、一个邮箱互相绑定。", "One computer, one activation code and one email are bound together.")}</p>
            <p className="pro-wechat pro-selectable">
              {copy("请加微信号", "WeChat")}
              <strong data-testid="developer-wechat-id">{WECHAT_ID}</strong>
            </p>
          </aside>
          <div className="pro-release">
            <h2>{copy("Pro 发布请关注官网", "Follow the site for the Pro release")}</h2>
            <a href={SITE_URL} onClick={(event) => { event.preventDefault(); void openLink(SITE_URL); }}>{SITE_URL}</a>
            <p>
              {copy("或加 QQ 群。1群若满，请加 2群。", "Or join a QQ group. If group 1 is full, join group 2.")}
            </p>
            <ul className="pro-selectable">
              {QQ_GROUPS.map(([label, number]) => (
                <li key={number}>
                  <span>{copy(label, label === "1群" ? "Group 1" : "Group 2")}</span>
                  <strong>{number}</strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <section aria-label={copy("Pro 功能", "Pro features")} className="pro-features">
          {features.map(([Icon, title, detail, key], index) => (
            <article className={`pro-feature pro-feature--${key}`} key={key}>
              <div className="pro-feature-top"><Icon size={20} /><span>0{index + 1}</span></div>
              <h3>{title}</h3>
              <p>{detail}</p>
            </article>
          ))}
        </section>
        <section className="pro-details-grid">
          <article className="pro-details">
            <h3>{copy("免费版，依然完整保留。", "Free stays free.")}</h3>
            <p>{copy("免费版继续免费下载、免费使用。Pro 使用独立安装包，两版可以同时安装，并共用数据。", "Free remains free to download and use. Pro has its own installer. The two editions can be installed together and share your data.")}</p>
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
                copy("关注官网或加入 QQ 群，等待 Pro 发布", "Follow the site or a QQ group until Pro is released"),
                copy("添加开发者微信，转账购买授权", "Contact the developer on WeChat to purchase"),
                copy("领取激活码，绑定当前电脑。一台电脑、一个激活码、一个邮箱互相绑定。", "Redeem your code on this computer. One computer, one code and one email are bound together."),
              ].map((item, index) => <li key={item}><span>{index + 1}</span>{item}</li>)}
            </ol>
          </article>
        </section>
        <p className="pro-footnote">{copy("具体功能以 Pro 版本发布后为准。", "Specific features follow the Pro release.")}</p>
        {error ? <p role="alert" className="pro-error">{error}</p> : null}
      </div>
    </div>
  );
}
