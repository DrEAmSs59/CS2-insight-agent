# POV HUD resources

`pov_default.vpk` contains the static POV HUD overrides. When a demo is known,
the backend instead starts from `pov_voice_template.vpk`, extracts
`svc_VoiceData` packet ticks and `CCSPlayerPawn.m_szLastPlaceName`, and fills the
bounded data slot in the bundled Panorama demo-controller script. The package
is rebuilt with fresh VPK entry CRCs before CS2 starts.

The human-readable injected script is `voice_hud_injection.js`. The checked-in
template contains an empty payload only; demo Steam IDs, voice bytes, and other
match-specific data are never committed. Opus frames remain in the `.dem` and
are played by CS2 itself—the overlay only reconstructs the native-style
speaker, avatar, color, and localized location notices.

If a demo has no usable voice packets, parsing fails, or the compact schedule
does not fit the fixed template slot, installation falls back to
`pov_default.vpk` rather than installing a partial package.
