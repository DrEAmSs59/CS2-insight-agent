import { useState } from "react";

const ANIMATIONS = ["c4-roll.svg", "chicken-crates.svg", "team-emblems.svg"];

/** One decorative animation per loading session; progress updates keep it running. */
export default function Cs2LoadingAnimation({ className = "" }) {
  const [animation] = useState(() => ANIMATIONS[Math.floor(Math.random() * ANIMATIONS.length)]);

  return (
    <img
      src={`${import.meta.env.BASE_URL}loaders/${animation}`}
      width={64}
      height={64}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`block h-16 w-16 shrink-0 object-contain ${className}`}
    />
  );
}
