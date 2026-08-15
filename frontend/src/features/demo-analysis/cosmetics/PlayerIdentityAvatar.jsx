/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from "react";
import { playerAppearance } from "../../../utils/playerAppearance.js";

export default function PlayerIdentityAvatar({ player, avatarUrl, fallbackTone = "blue", className = "h-8 w-8" }) {
  const [failed, setFailed] = useState(false);
  const name = String(player?.name || player?.player_name || "").trim();
  const tone = playerAppearance(player, fallbackTone);

  useEffect(() => setFailed(false), [avatarUrl]);

  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 font-black ${className}`}
      style={{ color: tone.color, background: tone.background, borderColor: tone.color }}
      data-player-color-source={tone.source}
    >
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt={`${name} Steam avatar`}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      )}
      <i
        aria-hidden="true"
        className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full border border-cs2-bg-card"
        style={{ background: tone.color }}
      />
    </span>
  );
}
