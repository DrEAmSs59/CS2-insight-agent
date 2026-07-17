import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import { TEXT_STYLE_CARDS } from "../src/components/liteCut/editor/editorPresets.js";
import { normalizePreviewLayerTransform } from "../src/components/liteCut/editor/previewFrameUtils.js";
import { transitionPreviewVisual, textTransitionPreviewVisual } from "../src/components/liteCut/editor/transitionPreviewUtils.js";

function assetUrl(name) {
  return `/__litecut_visual_tmp/${name}`;
}

function Canvas({ width, height, children }) {
  return (
    <div data-visual-root style={{ position: "relative", width, height, overflow: "hidden", background: "#000", contain: "layout paint" }}>
      {children}
    </div>
  );
}

function FullFrame({ src, style = {} }) {
  return <img src={src} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", ...style }} />;
}

function FilterTransformCase({ data }) {
  const transform = normalizePreviewLayerTransform(data.transform);
  const objectFit = Math.abs(transform.width - transform.height) > 0.001 ? "fill" : "contain";
  return (
    <Canvas width={data.width} height={data.height}>
      <div style={{ position: "absolute", left: `${(transform.x * 100).toFixed(2)}%`, top: `${(transform.y * 100).toFixed(2)}%`, width: `${(transform.width * 100).toFixed(2)}%`, height: `${(transform.height * 100).toFixed(2)}%`, opacity: transform.opacity, filter: data.cssFilter || undefined, transform: `translate(-50%, -50%) scale(${transform.scale}) rotate(${transform.rotation}deg)` }}>
        <img src={assetUrl("source_a.png")} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit }} />
      </div>
    </Canvas>
  );
}

function TransitionCase({ data }) {
  const visual = transitionPreviewVisual(data.transition, data.progress);
  return (
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("transition_outgoing.png")} />
      <FullFrame src={assetUrl("transition_incoming.png")} style={{ opacity: visual.mainOpacity, clipPath: visual.mainClipPath || undefined, transform: visual.mainTransform || undefined, filter: visual.mainFilter || undefined }} />
      {visual.flashOpacity > 0 ? <div style={{ position: "absolute", inset: 0, background: "white", opacity: visual.flashOpacity }} /> : null}
      {visual.blackOpacity > 0 ? <div style={{ position: "absolute", inset: 0, background: "black", opacity: visual.blackOpacity }} /> : null}
    </Canvas>
  );
}

function ImageTransitionCase({ data }) {
  const visual = transitionPreviewVisual(data.transition, data.progress);
  return (
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("source_a.png")} />
      <div style={{ position: "absolute", left: `${data.x * 100}%`, top: `${data.y * 100}%`, width: `${data.boxWidth * 100}%`, height: `${data.boxHeight * 100}%`, opacity: visual.mainOpacity, clipPath: visual.mainClipPath || undefined, transform: `${visual.mainTransform || ""} translate(-50%, -50%) scale(${data.scale || 1})`.trim(), filter: visual.mainFilter || undefined }}>
        <img src={assetUrl("overlay_image.png")} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "fill" }} />
        {visual.flashOpacity > 0 ? <span style={{ position: "absolute", inset: 0, background: "white", opacity: visual.flashOpacity }} /> : null}
        {visual.blackOpacity > 0 ? <span style={{ position: "absolute", inset: 0, background: "black", opacity: visual.blackOpacity }} /> : null}
      </div>
    </Canvas>
  );
}

function AlphaVideoCase({ data }) {
  const [ready, setReady] = useState(false);
  return (
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("checker.png")} />
      <video
        src={assetUrl("alpha-preview.webm")}
        muted
        autoPlay
        playsInline
        preload="auto"
        onLoadedData={(event) => { event.currentTarget.currentTime = data.second || 0.5; }}
        onSeeked={(event) => { event.currentTarget.pause(); setReady(true); }}
        data-alpha-ready={ready ? "true" : "false"}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
      />
    </Canvas>
  );
}

function TextCase({ data }) {
  const [fontReady, setFontReady] = useState(false);
  const styleCard = TEXT_STYLE_CARDS.find((item) => item.id === data.presetId) || TEXT_STYLE_CARDS[0];
  const textVisual = textTransitionPreviewVisual(data.transition || "cut", data.progress ?? 1, data.phase || "in");
  useEffect(() => {
    let active = true;
    const face = new FontFace(data.fontFamily, `url(${assetUrl(data.fontAsset || "font-under-test.ttf")}?v=${encodeURIComponent(data.caseId || "font")})`, { weight: "100 900" });
    face.load().then((loaded) => {
      document.fonts.add(loaded);
      return document.fonts.load(`${data.fontSize}px ${JSON.stringify(data.fontFamily)}`, data.text);
    }).then(() => {
      if (active) setFontReady(true);
    }).catch(() => {
      if (active) setFontReady(true);
    });
    return () => { active = false; };
  }, [data.fontFamily, data.fontSize, data.text]);
  if (!fontReady) return <Canvas width={data.width} height={data.height} />;
  return (
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("source_a.png")} />
      <div style={{ position: "absolute", left: `${((data.x + textVisual.offsetX) * 100).toFixed(2)}%`, top: `${((data.y + textVisual.offsetY) * 100).toFixed(2)}%`, width: `${(data.boxWidth * 100).toFixed(2)}%`, height: `${(data.boxHeight * 100).toFixed(2)}%`, opacity: textVisual.opacity, transform: `translate(-50%, -50%) scale(${data.scale})` }}>
        <div className={`flex h-full w-full items-center justify-center text-center leading-tight ${styleCard.className}`} style={{ fontFamily: data.fontFamily, fontSize: `${data.fontSize}px`, textShadow: "0 2px 12px rgba(0,0,0,0.72)" }}>
          {data.text}
        </div>
      </div>
    </Canvas>
  );
}

function App() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch(`${assetUrl("case.json")}?v=${Date.now()}`, { cache: "no-store" }).then((response) => response.json()).then(setData);
  }, []);
  const content = useMemo(() => {
    if (!data) return null;
    if (data.kind === "transition") return <TransitionCase data={data} />;
    if (data.kind === "image-transition") return <ImageTransitionCase data={data} />;
    if (data.kind === "alpha-video") return <AlphaVideoCase data={data} />;
    if (data.kind === "text") return <TextCase data={data} />;
    return <FilterTransformCase data={data} />;
  }, [data]);
  useEffect(() => {
    if (!data) return;
    const markReady = async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.documentElement.dataset.visualReady = "true";
    };
    void markReady();
  }, [data]);
  return content;
}

document.documentElement.style.background = "#000";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
createRoot(document.getElementById("root")).render(<App />);
