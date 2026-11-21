import { useState } from "react";
import { Check, Clapperboard, Copy, Gem, Layers3, Timer, Zap } from "lucide-react";
import { desktopBridge } from "../desktop/desktopBridge";
import { useLocaleStore } from "../i18n/localeStore";
import "./GetProPage.css";

const SITE_URL = "https://ciacut.cc/";
const QQ_GROUPS = [
  ["1群", "1078028719"],
  ["2群", "1042360781"],
];

export default function GetProPage() {
  const en = useLocaleStore((state) => state.effectiveLocale) === "en";
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const copy = (zh, english) => (en ? english : zh);
  const openSite = async (event) => {
    event.preventDefault();
    try {
      if (desktopBridge) await desktopBridge.openExternal(SITE_URL);
      else window.open(SITE_URL, "_blank", "noopener,noreferrer");
    } catch {
      setError(copy("暂时无法打开链接，请稍后重试。", "Unable to open the link. Please try again."));
    }
  };
  const copyGroupNumber = async (number) => {
    setCopyStatus("");
    try {
      if (desktopBridge?.writeClipboardText) await desktopBridge.writeClipboardText(number);
      else await navigator.clipboard.writeText(number);
      setCopyStatus(copy(`已复制群号 ${number}`, `Copied group number ${number}`));
    } catch {
      setCopyStatus(copy("复制群号失败，请重试。", "Couldn't copy the group number. Please try again."));
    }
  };
  const features = [
    [Layers3, copy("为地图换一种质感", "A new look for every scene"), copy("更多地图材质/滤镜，搭配场景与镜头风格。", "More map materials and filters to match your scene and camera style."), "materials"],
    [Zap, copy("让天气参与叙事", "Let the weather tell a story"), copy("闪电暴雨、漫天飞雪等效果，为关键时刻增加氛围。", "Lightning storms, snowfall and other effects add atmosphere to key moments."), "weather"],
    [Gem, copy("把饰品细节做到位", "Make the details yours"), copy("饰品更名、自定义贴纸与挂件，让高级饰品点缀你的高光。", "Custom names, stickers and charms let premium items dress your highlights."), "cosmetics"],
    [Timer, copy("录制跟上创作节奏", "Keep recording moving"), copy("兼容 HLAE 倍速录制，衔接视频制作流程。", "HLAE speed recording compatibility for your video workflow."), "recording"],
    [
      Clapperboard,
      copy("一键自动运镜", "One-click camera movement"),
      copy("从此高光运镜再无门槛", "Create camera moves for your highlights with no learning curve"),
      "camera",
      copy("2026年11月底发布自动运镜", "Automatic camera movement launches in late November 2026"),
    ],
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
            <p className="pro-terms">{copy("一台电脑、一个激活码、一个邮箱互相绑定。", "One computer, one activation code and one email are bound together.")}</p>
            <p className="pro-terms">{copy("若有疑问，请加 QQ 群。", "Join a QQ group if you have questions.")}</p>
            <ul className="pro-qq-groups">
              {QQ_GROUPS.map(([label, number]) => (
                <li key={number}>
                  <span>{copy(label, label === "1群" ? "Group 1" : "Group 2")}</span>
                  <button
                    type="button"
                    className="pro-qq-copy"
                    aria-label={copy(`复制 QQ 群号 ${number}`, `Copy QQ group number ${number}`)}
                    title={copy("复制群号", "Copy group number")}
                    onClick={() => void copyGroupNumber(number)}
                  >
                    {number}
                    <Copy size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <p className="pro-copy-status" role="status">{copyStatus}</p>
          </aside>
          <article className="pro-details">
            <h2>{copy("三步开始 Pro", "Start in three steps")}</h2>
            <ol className="pro-steps">
              <li>
                <span>1</span>
                <div>
                  {copy("进入 ", "Visit ")}
                  <a href={SITE_URL} onClick={openSite}>ciacut.cc</a>
                  {copy(" 官网，使用支付宝或微信自助付款", " and pay online with Alipay or WeChat Pay")}
                </div>
              </li>
              <li>
                <span>2</span>
                {copy("下载 Pro 版本客户端", "Download the Pro client")}
              </li>
              <li>
                <span>3</span>
                {copy("领取激活码，绑定当前电脑。一台电脑、一个激活码、一个邮箱互相绑定。", "Redeem your code on this computer. One computer, one code and one email are bound together.")}
              </li>
            </ol>
          </article>
        </div>
        <section aria-label={copy("Pro 功能与免费版说明", "Pro features and Free edition details")} className="pro-features">
          {features.map(([Icon, title, detail, key, releaseNote], index) => (
            <article className={`pro-feature pro-feature--${key}`} key={key}>
              <div className="pro-feature-top"><Icon size={20} /><span>0{index + 1}</span></div>
              <h3>{title}</h3>
              <p>{detail}</p>
              {releaseNote && <p className="pro-release-note">{releaseNote}</p>}
            </article>
          ))}
          <article className="pro-details">
            <h2>{copy("免费版，依然完整保留。", "Free stays free.")}</h2>
            <p>{copy("免费版继续免费下载、免费使用。Pro 使用独立安装包，两版可以同时安装，并共用数据。", "Free remains free to download and use. Pro has its own installer. The two editions can be installed together and share your data.")}</p>
            <ul>
              {[
                copy("已有 Demo、录制成果与配置继续保留", "Keep existing demos, recordings and settings"),
                copy("Pro 到期暂停付费能力，不删除你的作品", "Expiration pauses paid features, never deletes your work"),
                copy("具体支持地图与 HLAE 版本以发布说明为准", "Supported maps and HLAE versions are listed in release notes"),
              ].map((item) => <li key={item}><Check size={15} />{item}</li>)}
            </ul>
          </article>
        </section>
        {error ? <p role="alert" className="pro-error">{error}</p> : null}
      </div>
    </div>
  );
}
