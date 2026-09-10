# POV HUD resources

`pov_default.vpk` contains the static POV HUD CSS overrides for the teamcounter,
equipment strip, and radar clip. It deliberately does not replace CS2's
health/ammo stylesheet. When a demo is known,
the backend fills one of two physically separate templates with the parsed
payload and rebuilds its VPK entry CRCs before CS2 starts:

- `pov_voice_template.vpk` is the POV HUD package used by demo POV playback and
  highlight recording. It retains the teamcounter/equipment/radar styles while
  leaving health/ammo to the installed CS2 build.
- `pov_advanced_playback_template.vpk` is used by Advanced playback and by
  ordinary recordings that need only the independent voice/input overlays. It
  omits the compiled POV styles so those recordings retain CS2's native
  spectator HUD.

## Recording skybox layer

`skyboxes/<id>/` stores the eleven bundled Cartoon skyboxes as their original
compiled `.vmat_c` / `.vtex_c` pairs. Refresh the bundled catalog with
`python tools/sync_skybox_assets.py <compiled-skybox-directory>`. At runtime
the backend reads only the selected pair and writes it directly into the
map-specific temporary recording VPK; there is no aggregate asset VPK. The
matching settings-page panoramas live in `frontend/public/skyboxes`. Rebuild
them with `python tools/rebuild_skybox_previews.py <compiled-skybox-directory>
--cli <Source2Viewer-CLI.exe>`; this developer-only export step uses
[ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)
and Python's OpenEXR, NumPy, and Pillow packages. The
recording preset presents `recording_skybox` alongside POV HUD in the
experimental-features group while keeping the two selections independent.
Before each demo starts, the backend composes one of two runtime packages:

- ordinary recording: selected material/texture plus the current map aliases,
  with no Panorama entries;
- POV recording: the same sky layer merged into the demo-specific POV VPK.

The supported maps are Dust II, Inferno, Mirage, Nuke, Overpass, Anubis,
Cache, and Ancient. `default` installs no recording VPK in ordinary mode and
adds no sky aliases in POV mode, preserving the map's original sky.

Non-Cartoon resources are not stored in this repository. They are distributed
separately as an optional resource pack. Users can import only the pairs they
need through **Settings → Skybox resources → Add skybox**; imported custom
resources are stored in writable app data and survive updates.

## Recording map-material layer

`map_materials/waxed_reflection/catalog.vpk` is a product asset catalog, not a
mountable map preset. Its manifest maps the exact validated compiled material
bytes for Dust II, Ancient, Mirage, Nuke, Anubis, Inferno, Overpass, and Cache
to their real target paths. At recording or Advanced-playback launch time the
backend reads only the selected map entries and composes them into the same
temporary `pov.vpk` used by POV HUD and skybox replacement. The catalog itself
is never added to `gameinfo.gi`, and no per-map VPK is shipped or permanently
mounted.

The `waxed_reflection` profile preserves the accepted original map brightness,
uses the validated waxed wall/floor/crate materials, disables sun and direct
lighting, and keeps indirect lighting enabled. It can run by itself or merge
with POV HUD and a selected skybox. `default` adds neither material entries nor
lighting commands. Rebuild the catalog from the locally verified research
artifacts with `python tools/build_waxed_map_material_catalog.py`; the builder
checks source hashes, rejects post-process or sky modifications, and verifies
the complete generated VPK before writing it.

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

- Top teamcounter: ally HP / C4 / defuser visible; enemy detail strip hidden.
  Advanced playback leaves the installed game's teamcounter and equipment
  styles native and applies POV-only visibility at runtime. Switching to DEMO
  HUD therefore restores the current CS2 layout without a stale VPK override
- Bottom health bar: neither checked-in POV VPK contains
  `hudhealthammocenter.vcss_c`, and the injected script performs no fill/wash or
  player-color writes. Recording POV and Advanced's POV profile both hide the
  demo-only `HudSpecplayer` Steam-avatar card and reveal CS2's native
  `HudHealthAmmoCenter`, whose center slot supplies the CT/T faction logo. The
  installed CS2 build owns that complete resource, so `cl_hud_color 12` behaves
  exactly as it does in Advanced playback's POV mode
- Native teammate overhead: name and equipment stay on the engine-positioned
  `CCSGO_HudReticle` player panel; Insight fills its native centered extra-info
  row with green economy only (no HP row)
- Both Insight entry points (demo POV play and POV highlight recording) install
  the same generated `pov.vpk` via `PovHudManager`

Insight's direct **Advanced playback** entry additionally fills payload index
12 with the XUID roster and a delta-tick event index. Moving the free demo
cursor over the small collapsed title-tab area at the right-center screen edge
opens a Panorama menu, including when the persistent title bar is disabled;
the panel hides again after the pointer leaves it. CS2's native DemoUI remains
visible and owns the timeline and playback controls. The Insight menu has five
sections, from top to bottom: HUD, voice, round seek, teams, and events. It
provides:

- Compact CT/T player columns with direct one-based live-slot switching. The
  list follows the radar track's alive/dead state: dead players receive an
  explicit skull/death treatment and cannot be selected, while their voice
  toggle remains independently available
- A hot POV HUD / DEMO-compatible HUD switch that does not change the active
  camera. Its dedicated template intentionally omits the remaining POV-only
  radar, team-counter, and equipment styles, so DEMO HUD can return to
  CS2's native resources without restarting. POV playback and recording use the
  separate full template and therefore keep those styles.
- CS2's native DemoUI for timeline, play/pause, and exact tick controls, plus a
  compact click-only Insight round picker that expands every parsed round and
  seeks directly to the selected round without text input
- Per-player kill, death, and utility-release events, including exact-tick
  paused seek and a playing three-second pre-roll. Rows use CS2 equipment and
  death-notice SVGs for the weapon, grenade, headshot, no-scope, through-smoke,
  penetration, blind-kill, and flash-assist markers, with CT/T-colored actor and
  target names. Every row also displays the round resolved from the demo's
  parsed `round_start` / `round_freeze_end` timeline.
- Team, all-player, muted, and custom per-player voice audience policies. The
  reconstructed speaker/avatar notice remains visible in both POV HUD and DEMO
  HUD instead of being treated as a POV-only visual
- Message ownership follows the HUD profile automatically: POV HUD uses
  Insight's reconstructed feed and DEMO HUD uses CS2's native feed and lifetime.
- DEMO HUD restores CS2's native square, non-rotating spectator radar (including
  its CT/T colors and 1-5 player numbers) instead of drawing Insight markers.
- DEMO HUD also treats CS2's native DemoUI X-ray switch as the single source of
  truth for both player outlines and overhead player markers. POV HUD retains
  its separate deterministic player-ID behavior.
- Event filters with five fixed visible rows and pagination embedded in the
  filter row; the content-sized menu preserves equal top and bottom padding
- A deterministic right-center initial position and a freely draggable title
  bar. Live cursor deltas move the menu directly in Panorama logical units;
  the native drag ghost remains a fallback when cursor polling is unavailable.
  Final top-left coordinates are clamped to the HUD viewport without snapping
  to a screen corner
- A pin switch that chooses between the default always-visible panel and
  right-edge mouse reveal; all structural panel regions consume mouse clicks so
  spectator MOUSE1 bindings cannot leak through the menu

The generated Advanced-playback VPK contains only the demo-controller injection
and the Insight HUD-alert integration. The compiled radar, teamcounter, and
equipment-info replacements remain in `pov_voice_template.vpk` and its static
`pov_default.vpk` fallback; health/ammo remains native in every mode.

Payload index 20 explicitly records whether the session requested POV visuals.
Ordinary recording overlays write `0`, use the style-free template, and keep the
native spectator health/player panels even when voice or the input HUD is on.

The menu payload is generated only for direct Advanced playback. Highlight
recording continues to use the same POV assets and tracks but leaves index 12
empty, so recording automation never receives an interactive edge menu. Its
fixed `all` / `team` / `enemy` / `mute` voice audience is stored at payload
index 13. Trusted session console commands are stored at payload index 14 and
are applied only after Panorama can read the loaded demo-controller state; the
short bounded reapply window prevents map initialization from restoring the
pre-demo rendering values. Unlike
ordinary POV generation, Advanced playback fails the launch preparation if its
event index cannot be built instead of silently falling back to the static VPK.

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
(jump), transient R (reload), M1, and M2 inputs. The centered input HUD uses
the compact dark-key/Insight-orange-press styling from the retired OBS overlay, while
retaining the VPK-only 1-5, Tab, E/F/H, hand-switch, and mouse-motion data. The
1-5 row sits in an upward-expanded panel above the original three-row keyboard,
so it remains visible without moving those rows on screen. The mouse-motion
panel occupies only the rounded lower body, while the
upper section is reserved for two flush M1/M2 outlines separated by their shared
center line. The mouse sits closer to the keyboard, has no extra outer shell or
wheel, and keeps both button labels blank.
The complete input HUD stays fixed at its centered anchor even while native
bomb, round, and match banners are visible. Weapon-select payload pulses remain
exact, but the number-row highlight is held for 12 demo ticks so Panorama cannot
skip a one-tick selection between display refreshes. The 1-4 and F keycaps stay
visible in hybrid mode, and all pressed keycaps use the Insight primary orange.
Recording presets and the pre-record dialog expose this as a binary show/hide
choice; show always resolves to the high-frequency resident `hybrid` mode.
Advanced Demo playback always packages that mode and adds a live `INPUT`
toggle to the in-game HUD row, so visibility can be changed without relaunching
the Demo. Each explicit switch to `DEMO HUD` also starts with CS2's native
X-ray enabled; DemoUI can still turn it off afterwards.

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

The human-readable injected script is `voice_hud_injection.js`.
`tools/rebuild_pov_voice_template.py` rebuilds both checked-in templates after
editing the JS or HUD CSS resources. Both templates contain an empty payload
only; demo Steam IDs, voice bytes, and other match-specific data are never
committed. At runtime the script resolves
the current POV pawn by XUID, builds the exact low/high voice-listen masks for
the selected recording audience, and filters the lower-left notices with that
same decision. Team and enemy policies follow live sides across half-time
swaps; all and mute apply to both sides. Opus frames remain in the `.dem` and are played by CS2
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

All players remain in one switchable payload. High-frequency mouse samples,
button-mask changes, and button-audio edges use delta-tick/base36 tracks; audio
edges retain the exact IEEE-754 bits of the extractor's subtick `when` value.
This reduces Panorama parse cost without discarding Pawns or coarsening input
timing.

The lower-left combat strip is sourced from
`CCSPlayerController_ActionTrackingServices`, not reconstructed from damage
events. Each Pawn carries sparse K/D/A, current-round damage, and match-damage
states. `m_iDamage` supplies completed-round damage while
`m_flTotalRoundDamageDealt` supplies the live round; the terminal overlap is
deduplicated when the final round commits before the live value clears. K/D/A
stays above the account balance; round and match damage occupy the unused strip
to the balance's right. The glyphs use CS2's own `digitpanel-font` metrics
(Stratum2 Mono, 38 px, 18 px columns) and the stock DigitPanel 0.6-second
cubic-bezier transition. Pawn switches initialize instantly; changes for the
same Pawn use the native per-digit roll. The complete strip is mounted under
native `HudLowerLeft`; each rolling-number container carries the same
`.hud-colorize-wash` class directly used by `HudMoney`, while the caption
Labels carry the same direct wash class used by the stock health labels. This
strip also carries the native `HudMoney` parent's `.additive` blend class. This
preserves both the wash hue and final scene-composited luminance instead of
tinting an ancestor composition layer or assigning a guessed text color. Team
color, custom HUD color, and `cl_hud_color 12` observed-Pawn color therefore
follow the same live cascade as the account balance.

If a demo has no usable voice packets, the generated package keeps a
roster-only payload so radar and kill-feedback tracks can still attach. The
compiled Panorama `DATA` block expands to the exact compact payload size and
its resource offsets and VPK CRCs are rebuilt before launch, so long demos are
not constrained by a fixed template slot. If the dynamic build itself fails,
installation falls back to `pov_default.vpk` rather than installing a partial
package. The direct Advanced playback exception is described above.

Every POV kill plays the stock body/headshot attacker-feedback event and the
stock `UI.KillCard.1` confirmation layer (`kill_doof_01.vsnd`) together. The
confirmation sound is additive; it does not replace the armor/headshot variant.

Flash-blind opacity reproduces only CS2's white overlay: it builds for
`(255 / 45) / 60` seconds, remains fully white while more than 3.43 seconds
remain, and then follows `(remaining_seconds / 3.43)^4` through the complete
demo-authored `player_blind` interval. The separate captured-frame afterimage
stays native; converting its linear screenshot alpha into additional Panorama
white makes POV flashes too bright and visually opaque for too long. The curve
never changes the demo-authored start/end ticks or extends the effect.
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
