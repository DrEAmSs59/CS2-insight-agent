import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import {
  normalizeTextAlign,
  normalizeTextFontSize,
  normalizeTextFontWeight,
  normalizeTextLineHeight,
  textBlockJustifyContent,
  textStylePreset,
} from "../src/features/lite-cut/editor/textLayout.js";
import { normalizeSceneTransform, sceneMaterialLayout, sceneTransformStyle, VIDEO_SCENE_TRANSFORM_DEFAULTS } from "../src/features/lite-cut/state/sceneTransform.js";
import { boundaryTransitionPreviewVisual, transitionNodePreviewVisual, transitionPreviewVisual } from "../src/features/lite-cut/editor/transitionPreviewUtils.js";

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

function BaseCase({ data }) {
  return <Canvas width={data.width} height={data.height}><FullFrame src={assetUrl("source_a.png")} /></Canvas>;
}

function FilterTransformCase({ data }) {
  const transform = normalizeSceneTransform(data.transform, VIDEO_SCENE_TRANSFORM_DEFAULTS);
  const materialLayout = sceneMaterialLayout({
    transform,
    crop: data.crop,
    contentFit: data.contentFit || "contain",
    canvasWidth: data.width,
    canvasHeight: data.height,
    sourceWidth: data.sourceWidth || 640,
    sourceHeight: data.sourceHeight || 360,
  });
  return (
    <Canvas width={data.width} height={data.height}>
      <div style={{ position: "absolute", overflow: "hidden", ...sceneTransformStyle(transform, { defaults: VIDEO_SCENE_TRANSFORM_DEFAULTS }) }}>
        <div style={materialLayout.viewportStyle}>
          <img src={assetUrl("source_a.png")} alt="" style={{ ...materialLayout.mediaStyle, filter: data.cssFilter || undefined }} />
        </div>
      </div>
    </Canvas>
  );
}

function TransitionCase({ data }) {
  const visual = boundaryTransitionPreviewVisual(data.transition, data.progress);
  return (
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("transition_outgoing.png")} style={{ transform: visual.outgoingTransform || undefined, transformOrigin: visual.outgoingTransformOrigin || undefined }} />
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
      <div style={{ position: "absolute", left: `${data.x * 100}%`, top: `${data.y * 100}%`, width: `${data.boxWidth * 100}%`, height: `${data.boxHeight * 100}%`, opacity: visual.mainOpacity, clipPath: visual.mainClipPath || undefined, transform: `${visual.mainTransform || ""} translate(-50%, -50%) scale(${data.scale || 1})`.trim() }}>
        <img src={assetUrl("overlay_image.png")} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "fill", filter: visual.materialFilter || undefined }} />
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
  const preset = textStylePreset(data.presetId);
  const align = normalizeTextAlign(data.align);
  const fontSize = normalizeTextFontSize(data.fontSize);
  const fontWeight = normalizeTextFontWeight(data.fontWeight);
  const lineHeight = normalizeTextLineHeight(data.lineHeight);
  const textVisual = transitionNodePreviewVisual(
    data.transition || "cut",
    data.phase === "out" ? "from" : "to",
    data.progress ?? 1,
  );
  useEffect(() => {
    let active = true;
    const face = new FontFace(data.fontFamily, `url(${assetUrl(data.fontAsset || "font-under-test.ttf")}?v=${encodeURIComponent(data.caseId || "font")})`, { weight: String(data.fontWeight || 700) });
    face.load().then((loaded) => {
      document.fonts.add(loaded);
      return document.fonts.load(`${data.fontWeight || 700} ${data.fontSize}px ${JSON.stringify(data.fontFamily)}`, data.text);
    }).then(() => {
      if (active) setFontReady(true);
    }).catch(() => {
      if (active) setFontReady(true);
    });
    return () => { active = false; };
  }, [data.fontFamily, data.fontSize, data.text]);
  if (!fontReady) return <Canvas width={data.width} height={data.height} />;
  return (
    <div data-font-ready="true" style={{ display: "contents" }}>
    <Canvas width={data.width} height={data.height}>
      <FullFrame src={assetUrl("source_a.png")} />
      <div style={{ position: "absolute", clipPath: textVisual.mainClipPath || undefined, ...sceneTransformStyle({ x: data.x, y: data.y, width: data.boxWidth, height: data.boxHeight, scale: data.scale, rotation: data.rotation || 0, opacity: 1 }, { opacity: textVisual.mainOpacity, prefixTransform: textVisual.mainTransform }) }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: textBlockJustifyContent(align), width: "100%", height: "100%", overflow: "hidden", fontFamily: data.fontFamily, fontSize: `${fontSize}px`, fontWeight, fontSynthesis: "none", lineHeight, color: preset.fill_color || "#ffffff", WebkitTextStroke: "3px rgba(0, 0, 0, 0.72)", paintOrder: "stroke fill", filter: textVisual.materialFilter || undefined }}>
          <span style={{ flex: "0 0 auto", letterSpacing: "0px", textAlign: align, whiteSpace: "pre" }}>
            {data.text}
          </span>
        </div>
      </div>
    </Canvas>
    </div>
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
    if (data.kind === "base") return <BaseCase data={data} />;
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
