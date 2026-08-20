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

Radar sound circles treat a non-empty, aligned `player_sound` table as the
authoritative server SoundEvent result. Every valid tick, XUID, radius,
duration, and step row is compacted without radius/event-name filtering or
inferred gunfire mixed into it. Demo playback often fails to instantiate the
stock Panorama children, so the injection replays those exact rows through ten
`PlayerSound` slots (matching native `CHudRadar`). If the table is missing or
malformed, valid partial rows and synthesized gunfire remain a best-effort
fallback for stripped GOTV demos.

The baked Panorama script also drives the rest of the POV HUD:

- Top teamcounter: ally HP / C4 / defuser visible; enemy detail strip hidden
- Bottom health bar: fill tinted from demo `player_color` / radar `colorSlot`
  (not GOTV team cyan/yellow)
- Native teammate overhead: name and equipment stay on the engine-positioned
  `CCSGO_HudReticle` player panel; Insight fills its native centered extra-info
  row with green economy only (no HP row)
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

The generated package also owns the complete lower-left message stream at
payload index 11. Tactical radio uses `grenade_thrown` when available; missing
rows and older 5E/Faceit/PWA/Valve demos are filled from the matching
`weapon_fire` release (same XUID and grenade kind). Planting/defusing radio,
player `chat_message` rows, direct `server_message` rows, and teammate
attack/kill notices reconstructed from `player_hurt`/`player_death` share one
tick-ordered timeline. Kill-feedback payload rows add the localized enemy-kill
cash award (including the weapon's classic-mode award amount) to that same
render queue. Panorama hides only CS2's native `ChatHistoryText` and each pooled
`AlertPanel1` through `AlertPanel16`, without hiding any resolved parent panel,
and leaves voice speaker notices visible. The Insight
row stack therefore controls chronology, spacing, the 15.5-second
5%/90%/95% opacity curve, medium Stratum2 metrics, and seek resets without
cross-source layout negotiation, duplicated text, or native panel recycling
affecting reconstructed messages.

The human-readable injected script is `voice_hud_injection.js`. Rebuild the
checked-in template with `tools/_patch_teamcounter_hud.py` then
`tools/rebuild_pov_voice_template.py` after editing JS or HUD CSS patches.
The template contains an empty payload only; demo Steam IDs, voice bytes, and
other match-specific data are never committed. At runtime the script resolves
the current POV pawn by XUID, builds the exact low/high voice-listen masks for
that player's SteamID-bound team, and filters the lower-left notices by the
same team decision. Opus frames remain in the `.dem` and are played by CS2
itself—the overlay only controls their audience and reconstructs the
native-style speaker and avatar notices. The text follows the current client
format exactly: separate plain Panorama labels render a full-size `●` in the
demo `m_iCompTeammateColor`, the CT/T-colored name, and the green localized
location without relying on HTML parsing. Reconstructed messages stay at the
fixed `182px + 22px` lower-left baseline, permanently one voice row above the
notices; speakers appearing or disappearing never move the message block.

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

Flash-blind opacity now scales continuously toward a full-face reference of
about 4.5 seconds at the usual 64 tick rate, then decays across the complete
demo-authored `player_blind` interval. There is no three-second mode switch or
fixed two-second tail, so similar flash durations no longer produce an abrupt
change in how long the white wash appears to last. The curve never changes the
demo-authored start/end ticks or extends the effect.
While a flash wash is active, only its Panorama render cadence rises from 20Hz
to about 60Hz; idle polling remains 20Hz.

Many GOTV demos omit `player_blind` while retaining each pawn's
`flash_duration` state. For those demos the backend reconstructs flash starts
from 16Hz property transitions. This keeps the Panorama wash active above the
HUD instead of falling back to CS2's spectator flash, which renders below HUD
panels. The opacity curve remains the same for strong and glancing flashes.

When demo playback jumps to another highlight segment, the injected controller
clears stock chat history. It listens for the Panorama time-jump event, detects
large tick discontinuities, and keeps clearing while the executor is paused at
the exact new-segment start. A half-second demo-tick grace covers the final
cached chat update after playback resumes.

Both POV packages override the stock `hudalerts.vxml_c` layout with an otherwise
identical layout that loads `hudalerts_insight.js` in the alert panel's own
Panorama context. On a demo time jump it adds a temporary suppress class, then
waits three seconds for CS2 to finish rebuilding HUD state and removes that
class only after the native alert has then remained `AlertHidden` for half a
second. This clears a seek-stale planted-bomb toast without disabling new match
alerts later in normal POV playback. The stock `hudalerts.vcss_c` styling
remains untouched; kill feed and Insight overlays are separate panels. Demo
playback and OBS Start/Pause/Resume timing are unchanged.

Recording uses `demo_pause` before `demo_gototick`, and CS2 does not reliably
deliver the time-jump event for that paused path. The persistent demo controller
therefore also detects the tick discontinuity directly. After `demo_resume` it
keeps the current alert panel suppressed across the two-second `spec_player`
HUD-rebuild window, re-resolves the panel if CS2 replaces it, and releases only
after the native alert becomes stably hidden. With no stale alert, suppression
ends during the five-second pre-roll, so alerts raised during the recorded
segment remain visible.
