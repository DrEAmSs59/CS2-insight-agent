import { useCallback, useMemo, useState } from "react";
import { resolveHudWeaponStem } from "./resolveHudWeaponStem";

const HUD_BASE = "/hud-death-notice";

/** @param {{ chain: string[], title?: string, imgClass?: string }} p */
function HudChainImg({ chain, title = "", imgClass = "inline-block h-[18px] w-[18px] shrink-0 object-contain align-middle" }) {
  const [i, setI] = useState(0);
  const stem = chain[Math.min(i, chain.length - 1)] || "ak47";
  const onErr = useCallback(() => {
    setI((x) => (x < chain.length - 1 ? x + 1 : x));
  }, [chain.length]);

  return (
    <img
      src={`${HUD_BASE}/${stem}.svg`}
      alt=""
      title={title}
      draggable={false}
      className={imgClass}
      onError={onErr}
    />
  );
}

/** 固定槽位 + object-contain：HLAE 各枪 SVG 画布比例不一，统一以「约等于 AK 条里步枪占位」为基准。 */
function WeaponHudImg({ chain, title }) {
  const [i, setI] = useState(0);
  const stem = chain[Math.min(i, chain.length - 1)] || "ak47";
  const onErr = useCallback(() => {
    setI((x) => (x < chain.length - 1 ? x + 1 : x));
  }, [chain.length]);

  return (
    <span
      className="inline-flex h-[22px] w-[48px] shrink-0 items-center justify-center align-middle"
      title={title}
    >
      <img
        src={`${HUD_BASE}/${stem}.svg`}
        alt=""
        draggable={false}
        className="block max-h-[20px] max-w-[46px] h-auto w-auto object-contain object-center"
        onError={onErr}
      />
    </span>
  );
}

/**
 * @param {{ event: Record<string, unknown>, weaponName?: string, weaponKey?: string }} props
 */
export default function KillfeedIconStrip({ event, weaponName = "", weaponKey = "" }) {
  const wStem = resolveHudWeaponStem(weaponKey, weaponName);
  const weaponChain = useMemo(() => [...new Set([wStem, "knife", "ak47"])], [wStem]);

  const parts = [];
  if (event?.is_blind) parts.push(<HudChainImg key="bl" chain={["blindkill"]} title="盲视野击杀" />);
  parts.push(<WeaponHudImg key="wpn" chain={weaponChain} title={weaponName || "武器"} />);
  if (event?.is_headshot) parts.push(<HudChainImg key="hs" chain={["headshot"]} title="爆头" />);
  if (event?.is_noscope) parts.push(<HudChainImg key="ns" chain={["noscope"]} title="盲狙 / 不开镜" />);
  if (event?.is_jump_kill) parts.push(<HudChainImg key="air" chain={["jumpkill"]} title="空中击杀" />);
  if (event?.is_through_smoke) parts.push(<HudChainImg key="sm" chain={["throughsmoke"]} title="穿烟" />);
  if (event?.is_wallbang) parts.push(<HudChainImg key="wb" chain={["penetrate"]} title="穿墙" />);

  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-white/[0.07] bg-black/50 px-1 py-0.5">
      {parts}
    </span>
  );
}
