/* Copyright (c) Ian Lucas. MIT: /licenses/ianlucas-inventory-simulator.txt.
 * Adapted from background.tsx and splash.tsx at 1fd61a6.
 * Keep one media element; CSS handles resizing. Progress tracks playable media,
 * rather than the upstream splash's timer-based simulated download progress. */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { backgrounds } from "./lucasBackgrounds.js";
import { useLucasBackground } from "./lucasAppearance.js";

export default memo(function LucasWorkshopBackground({ locale }) {
  const preference = useLucasBackground();
  const background = useMemo(() => preference || backgrounds[Math.floor(Math.random() * backgrounds.length)].value, [preference]);
  return preference === "solid"
    ? <div className="lucas-background-layer lucas-background-solid" data-ready="true" aria-hidden="true" />
    : <VideoBackground background={background} locale={locale} />;
});

function VideoBackground({ background, locale }) {
  const media = useRef(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    const video = media.current;
    video.setAttribute("src", `/workshop/bg-${background}.webm`);
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [background]);
  useEffect(() => {
    const video = media.current;
    setReady(false);
    setFailed(false);
    setProgress(null);
    const sync = () => {
      if (video.error) setFailed(true);
      else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        setProgress(100);
        setReady(true);
      } else if (Number.isFinite(video.duration) && video.duration > 0 && video.buffered.length) {
        setProgress(Math.min(100, video.buffered.end(0) / video.duration * 100));
      }
    };
    const events = ["loadeddata", "loadedmetadata", "progress", "error"];
    events.forEach(event => video.addEventListener(event, sync));
    // A cached video can reach HAVE_ENOUGH_DATA before the listener is installed.
    sync();
    return () => events.forEach(event => video.removeEventListener(event, sync));
  }, [background]);
  return <div className="lucas-background-layer" data-ready={ready}>
    <video ref={media} className="lucas-workshop-background" src={`/workshop/bg-${background}.webm`}
      autoPlay muted loop playsInline disablePictureInPicture aria-hidden="true"
      onContextMenu={event => event.preventDefault()} />
    <div className="lucas-background-splash" aria-hidden={ready}>
      {failed ? <p role="status">{locale === "en" ? "Background could not be loaded." : "背景加载失败。"}</p> :
        <div className="lucas-background-progress" role="progressbar"
          aria-label={locale === "en" ? "Loading background" : "正在加载背景"}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress === null ? undefined : Math.round(progress)}>
          <div style={{ width: `${progress ?? 0}%` }} />
        </div>}
    </div>
  </div>;
}
