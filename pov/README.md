# POV HUD resources

`pov_default.vpk` contains the static POV HUD CSS overrides (teamcounter,
equipment strip, radar clip, and bottom health-bar fill). When a demo is known,
the backend instead starts from `pov_voice_template.vpk`, extracts
`svc_VoiceData` packet ticks and `CCSPlayerPawn.m_szLastPlaceName`, and fills the
bounded data slot in the bundled Panorama demo-controller script. The package
is rebuilt with fresh VPK entry CRCs before CS2 starts.

The same dynamic package also embeds an 8Hz XUID-bound radar track (payload
index 8). At runtime Panorama hides the stock team-colored radar, draws the
stock map backdrop, and interpolates teammate markers at frame rate with real
player colors, yaw, alive/dead state, and POV highlight. Seek, pause, playback
speed, and observer switches follow `GetDemoControllerState().nTick` and
`GameStateAPI.GetHudPlayerXuid()`—the same clock as the voice/input overlays.
Enemy spotted bits are classified from each target's live `team_num` at that
tick, not the end-of-demo roster snapshot. Switching the observed player to
any CT or T therefore immediately selects that side's red contacts and
last-known question marks, including across half-time team swaps.

The baked Panorama script also drives the rest of the POV HUD:

- Top teamcounter: ally HP / C4 / defuser visible; enemy detail strip hidden
- Bottom health bar: fill tinted from demo `player_color` / radar `colorSlot`
  (not GOTV team cyan/yellow)
- Both Insight entry points (demo POV play and POV highlight recording) install
  the same generated `pov.vpk` via `PovHudManager`

While POV is active, Insight also forces `cl_hud_color 12` (teammate / player
color) through `POV_CORE_FORCED_COMMANDS`, so stock HA accents follow slot
colors. Radar scale/centering and other POV cvars stay in that same list;
Session restore rolls back `gameinfo.gi` and removes the fixed target `pov.vpk`.
When the manifest and backup are valid it performs a byte-verified restore. If
those records are missing or stale, it removes only the Agent-owned
`Game csgo/pov.vpk` search-path entry from the current `gameinfo.gi`, preserving
all other Steam or user changes.

For demos with a decodable `svc_UserCmds` chain, the same native Panorama
layer renders the observed pawn's W/A/S/D, Shift (walk), Ctrl (crouch), Space
(jump), transient R (reload), M1, and M2 inputs.

The human-readable injected script is `voice_hud_injection.js`. Rebuild the
checked-in template with `tools/_patch_teamcounter_hud.py` then
`tools/rebuild_pov_voice_template.py` after editing JS or HUD CSS patches.
The template contains an empty payload only; demo Steam IDs, voice bytes, and
other match-specific data are never committed. At runtime the script resolves
the current POV pawn by XUID, builds the exact low/high voice-listen masks for
that player's SteamID-bound team, and filters the lower-left notices by the
same team decision. Opus frames remain in the `.dem` and are played by CS2
itself—the overlay only controls their audience and reconstructs the
native-style speaker, avatar, color, and localized location notices.

Input tracks are accepted only when the raw UserCmd extractor produces real
button transitions. Demos without that message chain keep the input panel
hidden rather than substituting motion inference. Radar fails closed the same
way: if the map transform or tick samples cannot be extracted, the custom radar
HUD stays hidden while voice continues to work.

If a demo has no usable voice packets, the generated package keeps a
roster-only payload so radar and kill-feedback tracks can still attach. If the
dynamic build fails or the compact payload does not fit the fixed template
slot, installation falls back to `pov_default.vpk` rather than installing a
partial package.

Every POV kill plays the stock body/headshot attacker-feedback event and the
stock `UI.KillCard.1` confirmation layer (`kill_doof_01.vsnd`) together. The
confirmation sound is additive; it does not replace the armor/headshot variant.

Strong flash-blind events (at least three seconds at the usual 64 tick rate)
hold the full-screen Panorama wash at exact opacity 1 before a two-second fade.
This deliberately covers radar, teamcounter, kill feed, and other HUD panels;
short glancing flashes keep a duration-scaled translucent peak. The opacity
curve never changes the demo-authored start/end ticks or extends the effect.
