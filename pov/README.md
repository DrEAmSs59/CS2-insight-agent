# POV HUD resources

`pov_default.vpk` contains the static POV HUD overrides. When a demo is known,
the backend instead starts from `pov_voice_template.vpk`, extracts
`svc_VoiceData` packet ticks and `CCSPlayerPawn.m_szLastPlaceName`, and fills the
bounded data slot in the bundled Panorama demo-controller script. The package
is rebuilt with fresh VPK entry CRCs before CS2 starts.

For demos with a decodable `svc_UserCmds` chain, the same native Panorama
layer renders the observed pawn's W/A/S/D, Shift (walk), Ctrl (crouch), Space
(jump), transient R (reload), M1, and M2 inputs. It follows the demo tick and
`GameStateAPI.GetHudPlayerXuid()`, so pause, seeking, playback speed, and
observer-target changes do not require an OBS clock or browser source.

The human-readable injected script is `voice_hud_injection.js`. The checked-in
template contains an empty payload only; demo Steam IDs, voice bytes, and other
match-specific data are never committed. At runtime the script resolves the
current POV pawn by XUID, builds the exact low/high voice-listen masks for that
player's SteamID-bound team, and filters the lower-left notices by the same
team decision. Opus frames remain in the `.dem` and are played by CS2 itself—
the overlay only controls their audience and reconstructs the native-style
speaker, avatar, color, and localized location notices.

Input tracks are accepted only when the raw UserCmd extractor produces real
button transitions. Demos without that message chain keep the input panel
hidden rather than substituting motion inference.

If a demo has no usable voice packets, parsing fails, or the compact schedule
does not fit the fixed template slot, installation falls back to
`pov_default.vpk` rather than installing a partial package.
