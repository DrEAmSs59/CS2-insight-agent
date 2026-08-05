/*__CS2_INSIGHT_INJECTION_BEGIN__*/
// Injected into the stock Panorama huddemocontroller script in
// pov_voice_template.vpk. demo_voice_hud.py replaces only the bounded payload
// between the two marker comments before installing the package. The payload
// contains [location tokens, voice speakers, exact svc_UserCmd input tracks,
// SteamID/slot/team roster, reserved slots, radar track at index 8,
// kill/HS attacker-feedback cues at index 9, flash-blind intervals at index 10].
;(function CS2InsightDemoVoiceHud() {
    "use strict";

    const packed = /*__CS2_INSIGHT_VOICE_DATA_BEGIN__*/[[], [], [], []]/*__CS2_INSIGHT_VOICE_DATA_END__*/;
    const locationTokens = packed[0];
    const encodedSpeakers = packed[1];
    const encodedInputTracks = packed[2] || [];
    const encodedRoster = packed[3] || [];
    const encodedRadar = packed[8] || null;
    const encodedKillFeedback = packed[9] || null;
    const encodedFlashBlind = packed[10] || null;
    const PLAYER_COLOR_HEX = ["#88CEF5", "#009E80", "#F1E441", "#E6802A", "#BD2C96"];
    const RADAR_MAP_SIZE = 1024;
    const KILL_FEEDBACK_CATCHUP_TICKS = 128;
    const MAX_VISIBLE_VOICE_NOTICES = 3;
    const VOICE_NOTICE_ROW_HEIGHT = 22;
    // Half-angle for "in POV view" checks (dropped C4 for CT, etc.).
    // Keep near the stock radar FOV cone (~80° total) so wall-blocked pings
    // outside the visible cone are not treated as "in view".
    const POV_VIEW_HALF_FOV_DEG = 40;
    // CT dropped-C4: world-model sight range approx; blocks far wallhack pings.
    const POV_C4_MAX_VIEW_DIST = 750;
    // Stock attacker-only SOS events (needs sv_cheats; local -insecure demos OK).
    const KILL_FEEDBACK_EVENT_HS = "Player.DeathHeadShot.AttackerFeedback";
    const KILL_FEEDBACK_EVENT_HS_ARMOR = "Player.DeathHeadShotArmor.AttackerFeedback";
    const KILL_FEEDBACK_EVENT_BODY = "Player.DeathBody.AttackerFeedback";
    const KILL_FEEDBACK_EVENT_BODY_ARMOR = "Player.DeathBodyArmor.AttackerFeedback";
    // Flash tinnitus SOS events (duration bands match stock Flashbang.Ring.*).
    const FLASH_TINNITUS_SHORT = "Flashbang.Ring.Short";
    const FLASH_TINNITUS_MEDIUM = "Flashbang.Ring.Medium";
    const FLASH_TINNITUS_LONG = "Flashbang.Ring.Long";
    // Full-face blind_duration ≈ 4.5s @ 64 tick/s. Peak wash scales to this.
    const FLASH_FULL_DURATION_TICKS = 288;
    const roster = encodedRoster.map(function (encoded) {
        return {
            xuid: String(encoded[0]),
            slot: Number(encoded[1]),
            team: Number(encoded[2]),
            unmuted: false,
        };
    }).filter(function (player) {
        return player.xuid && player.slot >= 0 && (player.team === 2 || player.team === 3);
    });
    const rosterByXuid = {};
    roster.forEach(function (player) {
        rosterByXuid[player.xuid] = player;
    });
    const speakers = encodedSpeakers.map(function (encoded) {
        let previousStart = 0;
        const intervals = encoded[2].split(",").filter(Boolean).map(function (pair) {
            const fields = pair.split(".");
            const start = previousStart + parseInt(fields[0], 36);
            previousStart = start;
            return [start, start + parseInt(fields[1], 36)];
        });
        let previousLocationTick = 0;
        const locations = encoded[3].split(",").filter(Boolean).map(function (pair) {
            const fields = pair.split(".");
            const tick = previousLocationTick + parseInt(fields[0], 36);
            previousLocationTick = tick;
            return [tick, parseInt(fields[1], 36)];
        });
        return {
            slot: encoded[0],
            xuid: encoded[1],
            intervals: intervals,
            locations: locations,
            panel: null,
        };
    });
    const controller = $.GetContextPanel();
    const inputTracksByXuid = {};
    encodedInputTracks.forEach(function (encoded) {
        let previousTick = 0;
        const changes = encoded[1].split(",").filter(Boolean).map(function (pair) {
            const fields = pair.split(".");
            const tick = previousTick + parseInt(fields[0], 36);
            previousTick = tick;
            return [tick, parseInt(fields[1], 36)];
        });
        inputTracksByXuid[String(encoded[0])] = changes;
    });

    function zigzagDecode(value) {
        return (value & 1) ? (-(value >> 1) - 1) : (value >> 1);
    }

    function decodeRadarTrack(raw) {
        if (!raw || !raw.length || raw.length < 4) {
            return null;
        }
        const mapName = String(raw[0] || "");
        const transformRaw = raw[1] || [];
        const stride = Number(raw[2]) || 0;
        const playersRaw = raw[3] || [];
        if (!mapName || stride <= 0 || !transformRaw.length || !playersRaw.length) {
            return null;
        }
        const transform = {
            pos_x: Number(transformRaw[0]),
            pos_y: Number(transformRaw[1]),
            scale: Number(transformRaw[2]) / 1000,
        };
        if (!isFinite(transform.pos_x) || !isFinite(transform.pos_y) || !transform.scale) {
            return null;
        }
        const players = playersRaw.map(function (encoded) {
            let previousX = 0;
            let previousY = 0;
            let previousYaw = 0;
            const samples = String(encoded[3] || "").split(",").filter(Boolean).map(function (token) {
                const fields = token.split(".");
                previousX += zigzagDecode(parseInt(fields[0], 36) || 0);
                previousY += zigzagDecode(parseInt(fields[1], 36) || 0);
                previousYaw += zigzagDecode(parseInt(fields[2], 36) || 0);
                const flags = parseInt(fields[3], 36) || 0;
                return {
                    x: previousX,
                    y: previousY,
                    yaw: previousYaw,
                    alive: (flags & 1) !== 0,
                    hasC4: (flags & 2) !== 0,
                    spottedByT: (flags & 4) !== 0,
                    spottedByCT: (flags & 8) !== 0,
                    // bit4 tracks live side across half-time swaps (roster team is static).
                    team: (flags & 16) !== 0 ? 3 : 2,
                };
            });
            return {
                xuid: String(encoded[0] || ""),
                colorSlot: Number(encoded[1]),
                startTick: parseInt(String(encoded[2] || "0"), 36) || 0,
                samples: samples,
                marker: null,
                arrow: null,
            };
        }).filter(function (player) {
            return player.xuid && player.samples.length;
        });
        if (!players.length) {
            return null;
        }
        const plantedRaw = raw[4] || [];
        const plantedBombs = (plantedRaw || []).map(function (row) {
            return {
                startTick: Number(row[0]) || 0,
                endTick: Number(row[1]) || 0,
                x: Number(row[2]) || 0,
                y: Number(row[3]) || 0,
            };
        }).filter(function (plant) {
            return plant.endTick >= plant.startTick;
        });
        const soundRaw = raw[5] || [[], ""];
        const soundXuids = (soundRaw[0] || []).map(function (xuid) { return String(xuid || ""); });
        let soundTick = 0;
        const sounds = String(soundRaw[1] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            soundTick += parseInt(fields[0], 36) || 0;
            const flags = parseInt(fields[4], 36) || 0;
            return {
                tick: soundTick,
                xuid: soundXuids[parseInt(fields[1], 36) || 0] || "",
                radius: parseInt(fields[2], 36) || 0,
                durationMs: parseInt(fields[3], 36) || 100,
                step: (flags & 1) !== 0,
                loud: (flags & 2) !== 0,
            };
        }).filter(function (sound) {
            return sound.xuid && sound.radius > 0;
        });
        const droppedRaw = raw[6] || [];
        const droppedBombs = (droppedRaw || []).map(function (row) {
            return {
                startTick: Number(row[0]) || 0,
                endTick: Number(row[1]) || 0,
                x: Number(row[2]) || 0,
                y: Number(row[3]) || 0,
            };
        }).filter(function (drop) {
            return drop.endTick >= drop.startTick;
        });
        const occlusionRaw = raw[7] || null;
        let occlusion = null;
        if (occlusionRaw && occlusionRaw.length >= 2) {
            const grid = Number(occlusionRaw[0]) || 0;
            const hex = String(occlusionRaw[1] || "");
            if (grid >= 8 && hex.length >= 2) {
                const bytes = [];
                for (let h = 0; h + 1 < hex.length; h += 2) {
                    bytes.push(parseInt(hex.substr(h, 2), 16) || 0);
                }
                occlusion = { grid: grid, bytes: bytes };
            }
        }
        return {
            mapName: mapName,
            transform: transform,
            stride: stride,
            players: players,
            plantedBombs: plantedBombs,
            sounds: sounds,
            droppedBombs: droppedBombs,
            occlusion: occlusion,
        };
    }

    const radarTrack = decodeRadarTrack(encodedRadar);

    function decodeKillFeedbackTrack(raw) {
        if (!raw || !raw.length || raw.length < 2) {
            return null;
        }
        const xuids = (raw[0] || []).map(function (xuid) { return String(xuid || ""); });
        let previousTick = 0;
        const events = String(raw[1] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            previousTick += parseInt(fields[0], 36) || 0;
            const flags = parseInt(fields[2], 36) || 0;
            return {
                tick: previousTick,
                attackerXuid: xuids[parseInt(fields[1], 36) || 0] || "",
                headshot: (flags & 1) !== 0,
                armor: (flags & 2) !== 0,
            };
        }).filter(function (event) {
            return event.attackerXuid && event.tick >= 0;
        });
        return events.length ? events : null;
    }

    const killFeedbackEvents = decodeKillFeedbackTrack(encodedKillFeedback);

    function decodeFlashBlindTrack(raw) {
        if (!raw || !raw.length || raw.length < 2) {
            return null;
        }
        const xuids = (raw[0] || []).map(function (xuid) { return String(xuid || ""); });
        let previousTick = 0;
        const events = String(raw[1] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            previousTick += parseInt(fields[0], 36) || 0;
            const durationTicks = parseInt(fields[1], 36) || 0;
            return {
                tick: previousTick,
                endTick: previousTick + Math.max(1, durationTicks),
                xuid: xuids[parseInt(fields[2], 36) || 0] || "",
            };
        }).filter(function (event) {
            return event.xuid && event.tick >= 0 && event.endTick > event.tick;
        });
        return events.length ? events : null;
    }

    const flashBlindEvents = decodeFlashBlindTrack(encodedFlashBlind);
    let unmuteAttempts = 0;
    let audiencePovXuid = "";
    let audienceMaskSignature = "";
    let audienceRefreshFrames = 0;
    let inputHud = null;
    let inputKeyPanels = [];
    let radarHud = null;
    let flashWashPanel = null;
    let flashTinnitusArmedTick = -1;
    let radarMapImage = null;
    let radarBombMarker = null;
    let radarBombIcon = null;
    let radarDroppedBombMarker = null;
    let radarDroppedBombIcon = null;
    let radarUnclipHud = null;
    let povRadarFx = null;
    let killFeedbackLastTick = -1;
    let killFeedbackCheatsReady = false;
    // Stock-ish radar intel timings (no public convar; matched to live feel).
    const RADAR_DEATH_ICON_SECONDS = 2.0;
    const RADAR_LAST_KNOWN_SECONDS = 1.5;
    const RADAR_DEATH_ICON_TICKS = Math.round(RADAR_DEATH_ICON_SECONDS * 64);
    const RADAR_LAST_KNOWN_TICKS = Math.round(RADAR_LAST_KNOWN_SECONDS * 64);
    // Last-known enemy radar intel: red ? after visual contact ends.
    const enemyIntelByXuid = {};
    // Death X markers for ally + enemy (stock map_death.vsvg).
    const deathIntelByXuid = {};
    // After the X times out, remember so we do not re-arm it every frame
    // while the corpse sample stays !alive (that bug made Xs permanent).
    const deathExpiredByXuid = {};
    let enemyIntelLastTick = -1;

    function currentPovXuid(state) {
        let xuid = String(GameStateAPI.GetHudPlayerXuid() || "");
        if ((!xuid || xuid === "0") && state && state.nSpectatingPlayerId >= 0) {
            xuid = String(
                GameStateAPI.GetPlayerXuidStringFromPlayerSlot(state.nSpectatingPlayerId) || "",
            );
        }
        return normalizeXuid(xuid);
    }

    function normalizeXuid(xuid) {
        const text = String(xuid || "").trim();
        if (!text || text === "0") {
            return "";
        }
        return text;
    }

    function sameXuid(a, b) {
        const left = normalizeXuid(a);
        const right = normalizeXuid(b);
        if (!left || !right) {
            return false;
        }
        if (left === right) {
            return true;
        }
        return left.length >= 8 && right.length >= 8
            && (left.indexOf(right) >= 0 || right.indexOf(left) >= 0);
    }

    function findRadarPlayerByXuid(xuid) {
        if (!radarTrack || !radarTrack.players) {
            return null;
        }
        for (let i = 0; i < radarTrack.players.length; i += 1) {
            if (sameXuid(radarTrack.players[i].xuid, xuid)) {
                return radarTrack.players[i];
            }
        }
        return null;
    }

    let teamResolveCacheTick = -1;
    let teamResolveCache = {};
    let swapCacheTick = -1;
    let swapCacheValue = false;

    function rosterTeamSwappedAt(tick) {
        // parse_player_info team is often end-of-demo; after half-time it disagrees
        // with live team_num packed into radar samples. Cache per ~1s of demo time.
        if (!radarTrack || !radarTrack.players || tick === undefined || tick === null) {
            return false;
        }
        const bucket = (tick / 64) | 0;
        if (bucket === swapCacheTick) {
            return swapCacheValue;
        }
        let compared = 0;
        let disagree = 0;
        for (let i = 0; i < radarTrack.players.length; i += 1) {
            const player = radarTrack.players[i];
            const rosterPlayer = rosterByXuid[normalizeXuid(player.xuid)]
                || rosterByXuid[String(player.xuid)];
            if (!rosterPlayer) {
                continue;
            }
            const sample = radarSampleAt(player, tick, radarTrack.stride);
            if (!sample || (sample.team !== 2 && sample.team !== 3)) {
                continue;
            }
            compared += 1;
            if (sample.team !== rosterPlayer.team) {
                disagree += 1;
            }
        }
        swapCacheTick = bucket;
        swapCacheValue = compared > 0 && disagree * 2 >= compared;
        return swapCacheValue;
    }

    function resolvePovTeam(povXuid, tick) {
        // Prefer live side from radar bit4 (tracks half swaps). Roster is a
        // static snapshot and will invert CT/T after half-time if used raw.
        const xuid = normalizeXuid(povXuid);
        if (!xuid) {
            return 0;
        }
        const bucket = tick === undefined || tick === null ? -1 : ((tick / 8) | 0);
        if (bucket === teamResolveCacheTick && teamResolveCache[xuid] !== undefined) {
            return teamResolveCache[xuid];
        }
        if (bucket !== teamResolveCacheTick) {
            teamResolveCacheTick = bucket;
            teamResolveCache = {};
        }

        let team = 0;
        const radarPlayer = findRadarPlayerByXuid(xuid);
        if (radarPlayer && tick !== undefined && tick !== null) {
            const sample = radarSampleAt(radarPlayer, tick, radarTrack.stride);
            if (sample && (sample.team === 2 || sample.team === 3)) {
                team = sample.team;
            }
        }
        if (!team) {
            try {
                if (typeof GameStateAPI.GetPlayerTeamNumber === "function") {
                    const live = Number(GameStateAPI.GetPlayerTeamNumber(xuid));
                    if (live === 2 || live === 3) {
                        team = live;
                    }
                }
            } catch (err) {}
        }
        if (!team) {
            let rosterPlayer = rosterByXuid[xuid];
            if (!rosterPlayer) {
                const keys = Object.keys(rosterByXuid);
                for (let i = 0; i < keys.length; i += 1) {
                    if (sameXuid(keys[i], xuid)) {
                        rosterPlayer = rosterByXuid[keys[i]];
                        break;
                    }
                }
            }
            if (rosterPlayer) {
                team = rosterTeamSwappedAt(tick) ? (rosterPlayer.team === 2 ? 3 : 2) : rosterPlayer.team;
            }
        }
        teamResolveCache[xuid] = team;
        return team;
    }

    function applyVoiceAudienceMask(low, high) {
        // Clear both halves first so a POV switch can never briefly retain the
        // previous team's speakers.
        GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices 0");
        GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices_h 0");
        if (low !== 0 || high !== 0) {
            GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices " + low);
            GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices_h " + high);
        }
    }

    function updateVoiceAudience(state) {
        const povXuid = currentPovXuid(state);
        const tick = state && typeof state.nTick === "number" ? state.nTick : 0;
        const povTeam = resolvePovTeam(povXuid, tick);
        const targetChanged = povXuid !== audiencePovXuid;
        audienceRefreshFrames -= 1;
        if (!targetChanged && audienceRefreshFrames > 0) {
            return povTeam;
        }

        let low = 0;
        let high = 0;
        if (povTeam === 2 || povTeam === 3) {
            const swapped = rosterTeamSwappedAt(tick);
            // Resolve runtime slots from XUIDs; map roster team through half-swap once.
            for (let slot = 0; slot < 64; slot += 1) {
                const slotXuid = normalizeXuid(
                    GameStateAPI.GetPlayerXuidStringFromPlayerSlot(slot) || "",
                );
                const slotPlayer = rosterByXuid[slotXuid];
                if (!slotPlayer) {
                    continue;
                }
                let slotTeam = slotPlayer.team;
                if (swapped) {
                    slotTeam = slotTeam === 2 ? 3 : 2;
                }
                if (slotTeam !== povTeam) {
                    continue;
                }
                if (slot < 32) {
                    low |= 1 << slot;
                } else {
                    high |= 1 << (slot - 32);
                }
            }
        }

        low |= 0;
        high |= 0;
        const signature = low + ":" + high;
        if (targetChanged || signature !== audienceMaskSignature) {
            applyVoiceAudienceMask(low, high);
            audienceMaskSignature = signature;
        }
        audiencePovXuid = povXuid;
        audienceRefreshFrames = 32;
        return povTeam;
    }

    function hudRootPanel() {
        let root = controller;
        while (root.GetParent()) {
            root = root.GetParent();
        }
        return root;
    }

    function forEachTeamCounterDescendant(panel, visit) {
        if (!panel || !panel.IsValid()) {
            return;
        }
        visit(panel);
        const count = panel.GetChildCount ? panel.GetChildCount() : 0;
        for (let index = 0; index < count; index += 1) {
            forEachTeamCounterDescendant(panel.GetChild(index), visit);
        }
    }

    function panelHasAnyClass(panel, classNames) {
        if (!panel || !panel.BHasClass) {
            return false;
        }
        for (let index = 0; index < classNames.length; index += 1) {
            if (panel.BHasClass(classNames[index])) {
                return true;
            }
        }
        return false;
    }

    function teamCounterAvatarIsDead(panel) {
        // Stock applies .dead on the avatar slot; forcing HP restore then fights
        // layout and makes .HTC__kill-flag skulls bounce vertically.
        let current = panel;
        let guard = 0;
        while (current && current.IsValid() && guard < 16) {
            try {
                if (current.BHasClass && current.BHasClass("dead")) {
                    return true;
                }
            } catch (err) {}
            const id = String(current.id || "");
            if (id === "TeamLargeCT" || id === "TeamLargeT" || id === "HudTeamCounter") {
                break;
            }
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return false;
    }

    function teamCounterPanelIsRestricted(panel) {
        if (!panel || !panel.IsValid()) {
            return false;
        }
        try {
            if (panel.BHasClass && panel.BHasClass("Invisible")) {
                return true;
            }
        } catch (err) {}
        try {
            if (panel.visible === false) {
                return true;
            }
        } catch (err2) {}
        return false;
    }

    function setTeamCounterPanelRestricted(panel, restricted) {
        if (!panel || !panel.IsValid()) {
            return;
        }
        // Never zero width/height — Panorama often cannot restore "" and bars stay gone.
        if (restricted) {
            if (teamCounterPanelIsRestricted(panel)) {
                return;
            }
            panel.visible = false;
            try {
                panel.style.opacity = "0";
                panel.style.visibility = "collapse";
            } catch (err) {}
            if (panel.AddClass) {
                panel.AddClass("Invisible");
            }
            return;
        }
        try {
            if (panel.BHasClass
                && panel.BHasClass("healthbar-container")
                && teamCounterAvatarIsDead(panel)) {
                // Dead ally: leave stock HP collapse alone so kill skulls don't jitter.
                if (panel.RemoveClass && panel.BHasClass("Invisible")) {
                    panel.RemoveClass("Invisible");
                }
                return;
            }
        } catch (errDead) {}
        if (!teamCounterPanelIsRestricted(panel)) {
            return;
        }
        panel.visible = true;
        try {
            panel.style.opacity = "1";
            panel.style.visibility = "visible";
        } catch (err2) {}
        if (panel.RemoveClass) {
            panel.RemoveClass("Invisible");
        }
    }

    function teamLargeSideOf(panel) {
        let current = panel;
        while (current && current.IsValid()) {
            const id = String(current.id || "");
            if (id === "TeamLargeCT") {
                return 3;
            }
            if (id === "TeamLargeT") {
                return 2;
            }
            current = current.GetParent ? current.GetParent() : null;
        }
        return 0;
    }

    function findHudTraverse(id) {
        const seeds = [controller, hudRootPanel()];
        try {
            if (typeof $ !== "undefined" && $.GetContextPanel) {
                seeds.push($.GetContextPanel());
            }
        } catch (err) {}
        const nativeRadar = findNativeRadar();
        if (nativeRadar) {
            seeds.push(nativeRadar);
        }
        const seen = {};
        for (let s = 0; s < seeds.length; s += 1) {
            let panel = seeds[s];
            let guard = 0;
            while (panel && panel.IsValid() && guard < 40) {
                const key = String(panel.id || "") + ":" + guard + ":" + s;
                if (!seen[key] && panel.FindChildTraverse) {
                    seen[key] = true;
                    const hit = panel.FindChildTraverse(id);
                    if (hit && hit.IsValid()) {
                        return hit;
                    }
                }
                panel = panel.GetParent ? panel.GetParent() : null;
                guard += 1;
            }
        }
        return null;
    }

    function findTeamCounterRoot() {
        // Prefer the panel tree that actually hosts top-bar HP/kits (may not be
        // under the demo-controller root).
        const ids = ["HudTeamCounter", "TeamCounter", "TeamLargeCT", "TeamLargeT"];
        for (let i = 0; i < ids.length; i += 1) {
            const hit = findHudTraverse(ids[i]);
            if (!hit || !hit.IsValid()) {
                continue;
            }
            if (ids[i] === "TeamLargeCT" || ids[i] === "TeamLargeT") {
                return hit.GetParent ? hit.GetParent() : hit;
            }
            return hit;
        }
        const seeds = [controller, hudRootPanel()];
        try {
            if (typeof $ !== "undefined" && $.GetContextPanel) {
                seeds.push($.GetContextPanel());
            }
        } catch (err) {}
        for (let s = 0; s < seeds.length; s += 1) {
            let panel = seeds[s];
            let guard = 0;
            while (panel && panel.IsValid() && guard < 40) {
                if (panel.FindChildrenWithClassTraverse) {
                    const hp = panel.FindChildrenWithClassTraverse("healthbar-container") || [];
                    if (hp.length >= 4) {
                        return panel;
                    }
                }
                panel = panel.GetParent ? panel.GetParent() : null;
                guard += 1;
            }
        }
        return hudRootPanel();
    }

    function hideDetailsUnder(side, hideDetails) {
        if (!side || !side.IsValid()) {
            return;
        }
        // Class toggle drives CSS; only traverse a few known classes (no full tree walk).
        if (side.AddClass && side.RemoveClass) {
            if (hideDetails) {
                side.AddClass("CS2InsightPovEnemy");
                side.RemoveClass("CS2InsightPovAlly");
            } else {
                side.AddClass("CS2InsightPovAlly");
                side.RemoveClass("CS2InsightPovEnemy");
            }
        }
        if (!side.FindChildrenWithClassTraverse) {
            return;
        }
        const enemyDetailClasses = [
            "healthbar-container",
            "AvatarL__C4",
            "AvatarL__DefuseKit",
        ];
        for (let i = 0; i < enemyDetailClasses.length; i += 1) {
            const kids = side.FindChildrenWithClassTraverse(enemyDetailClasses[i]) || [];
            for (let j = 0; j < kids.length; j += 1) {
                setTeamCounterPanelRestricted(kids[j], hideDetails);
            }
        }
    }

    function teamContainerAncestor(panel) {
        let current = panel;
        let guard = 0;
        while (current && current.IsValid() && guard < 24) {
            const id = String(current.id || "");
            if (id === "TeamLargeCT" || id === "TeamLargeT") {
                return current;
            }
            try {
                if (current.BHasClass
                    && (current.BHasClass("team__large_container--left")
                        || current.BHasClass("team__large_container--right")
                        || current.BHasClass("TeamLarge"))) {
                    return current;
                }
            } catch (err) {}
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return null;
    }

    function updateTeamCounterForPov(povTeam, povXuid, tick) {
        // Ally TeamLarge shows HP/C4; enemy side hidden. Live team follows radar bit4.
        const live = (povXuid && tick !== undefined && tick !== null)
            ? resolvePovTeam(povXuid, tick)
            : povTeam;
        if (live !== 2 && live !== 3) {
            return;
        }
        const root = findTeamCounterRoot();
        if (!root || !root.IsValid()) {
            return;
        }
        const teamCt = findHudTraverse("TeamLargeCT")
            || (root.FindChildTraverse ? root.FindChildTraverse("TeamLargeCT") : null);
        const teamT = findHudTraverse("TeamLargeT")
            || (root.FindChildTraverse ? root.FindChildTraverse("TeamLargeT") : null);
        const ally = live === 3 ? teamCt : teamT;
        const enemy = live === 3 ? teamT : teamCt;
        if (enemy && enemy.IsValid()) {
            hideDetailsUnder(enemy, true);
        }
        if (ally && ally.IsValid()) {
            hideDetailsUnder(ally, false);
        }
        // Hide money/guns on both sides once via class query (cheap).
        if (root.FindChildrenWithClassTraverse) {
            const equips = root.FindChildrenWithClassTraverse("equipinfo-root") || [];
            for (let i = 0; i < equips.length; i += 1) {
                setTeamCounterPanelRestricted(equips[i], true);
            }
        }
    }

    function normalizeHudHex(hex) {
        const text = String(hex || "").trim().toUpperCase();
        if (!text) {
            return "";
        }
        // #RGB / #RRGGBB / #RRGGBBAA / rgb(r,g,b)
        if (text.charAt(0) === "#") {
            let h = text.replace(/[^0-9A-F]/g, "");
            if (h.length === 3) {
                h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            }
            return h.slice(0, 6);
        }
        const rgb = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (rgb) {
            return [rgb[1], rgb[2], rgb[3]].map(function (part) {
                const n = Math.max(0, Math.min(255, Number(part) || 0));
                const s = n.toString(16).toUpperCase();
                return s.length < 2 ? ("0" + s) : s;
            }).join("");
        }
        return text.replace(/[^0-9A-F]/g, "").slice(0, 6);
    }

    function nearestColorSlot(hex) {
        const target = normalizeHudHex(hex);
        if (!target || target.length < 6) {
            return -1;
        }
        const tr = parseInt(target.slice(0, 2), 16);
        const tg = parseInt(target.slice(2, 4), 16);
        const tb = parseInt(target.slice(4, 6), 16);
        // White/#defaultColor is nearer to light-blue than yellow — never map it.
        if (tr > 230 && tg > 230 && tb > 230) {
            return -1;
        }
        if (tr < 25 && tg < 25 && tb < 25) {
            return -1;
        }
        // Damage-flash red on health UI.
        if (tr > 200 && tg < 90 && tb < 90) {
            return -1;
        }
        let best = -1;
        let bestDist = 999999;
        for (let i = 0; i < PLAYER_COLOR_HEX.length; i += 1) {
            const cand = normalizeHudHex(PLAYER_COLOR_HEX[i]);
            if (cand === target) {
                return i;
            }
            const cr = parseInt(cand.slice(0, 2), 16);
            const cg = parseInt(cand.slice(2, 4), 16);
            const cb = parseInt(cand.slice(4, 6), 16);
            const dist = (tr - cr) * (tr - cr) + (tg - cg) * (tg - cg) + (tb - cb) * (tb - cb);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        // Reject weak matches (e.g. random greys).
        if (bestDist > 14000) {
            return -1;
        }
        return best;
    }

    function povColorSlot(povXuid) {
        // Demo GetPlayerColor is often team cyan/yellow, NOT teammate color.
        // Prefer demo radar colorSlot (m_iCompTeammateColor).
        const want = normalizeXuid(povXuid);
        if (!want || !radarTrack || !radarTrack.players) {
            return -1;
        }
        let tracked = null;
        for (let i = 0; i < radarTrack.players.length; i += 1) {
            if (normalizeXuid(radarTrack.players[i].xuid) === want) {
                tracked = radarTrack.players[i];
                break;
            }
        }
        if (!tracked) {
            tracked = findRadarPlayerByXuid(want);
        }
        if (!tracked) {
            return -1;
        }
        const slot = Number(tracked.colorSlot);
        if (!isFinite(slot) || slot < 0 || slot >= PLAYER_COLOR_HEX.length) {
            return -1;
        }
        return slot;
    }

    function sampleHaTeammateSlot(host) {
        if (!host || !host.IsValid() || !host.FindChildrenWithClassTraverse) {
            return -1;
        }
        function slotFromPanel(panel, props) {
            if (!panel || !panel.IsValid()) {
                return -1;
            }
            for (let p = 0; p < props.length; p += 1) {
                try {
                    const slot = nearestColorSlot(panel.style[props[p]]);
                    if (slot >= 0) {
                        return slot;
                    }
                } catch (errRead) {}
            }
            return -1;
        }
        const iconClasses = [
            "hud-HA-icon--helmet",
            "hud-HA-icon--armor",
            "hud-HA-icon",
        ];
        for (let c = 0; c < iconClasses.length; c += 1) {
            const icons = host.FindChildrenWithClassTraverse(iconClasses[c]) || [];
            for (let i = 0; i < icons.length; i += 1) {
                const slot = slotFromPanel(icons[i], ["washColor", "color"]);
                if (slot >= 0) {
                    return slot;
                }
            }
        }
        const labels = host.FindChildrenWithClassTraverse("hud-HA-health_or_ammo-label") || [];
        for (let j = 0; j < labels.length; j += 1) {
            const slot = slotFromPanel(labels[j], ["color", "washColor"]);
            if (slot >= 0) {
                return slot;
            }
        }
        return -1;
    }

    function applyHaSlotClass(panel, slot) {
        if (!panel || !panel.IsValid() || !panel.AddClass || !panel.RemoveClass) {
            return;
        }
        for (let i = 0; i < PLAYER_COLOR_HEX.length; i += 1) {
            const name = "Ci" + i;
            if (slot >= 0 && i === slot) {
                panel.AddClass(name);
            } else {
                panel.RemoveClass(name);
            }
        }
    }

    function isAmmoProgressBar(bar) {
        // Only treat the clip ProgressBar as ammo. Do NOT match ids that merely
        // contain "Ammo" — HudHealthAmmoCenter would false-positive and skip HP.
        let current = bar;
        let guard = 0;
        while (current && current.IsValid() && guard < 14) {
            const id = String(current.id || "");
            if (id === "HudHealthAmmoCenter" || id === "CSGOHudHealthAmmoCenter") {
                return false;
            }
            if (id === "AmmoClipBar") {
                return true;
            }
            try {
                if (current.BHasClass) {
                    if (current.BHasClass("hud-WPN-ammo")
                        || current.BHasClass("hud-WPN-ammo-reserve")
                        || current.BHasClass("hud-WPN-main")) {
                        return true;
                    }
                }
            } catch (errAmmo) {}
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return false;
    }

    function isBottomHealthFill(bar) {
        // Must sit under the bottom HA strip (.hud-HA-bar / .hud-HA-health), not
        // teamcounter avatar bars, and not ammo.
        if (!bar || !bar.IsValid() || isAmmoProgressBar(bar)) {
            return false;
        }
        let current = bar;
        let guard = 0;
        while (current && current.IsValid() && guard < 16) {
            try {
                if (current.BHasClass) {
                    if (current.BHasClass("hud-HA-bar")
                        || current.BHasClass("hud-HA-health")
                        || current.BHasClass("hud-HA-main")
                        || current.BHasClass("hud-HA")) {
                        return true;
                    }
                }
            } catch (errHa) {}
            const id = String(current.id || "");
            if (id === "HudHealthAmmoCenter" || id === "CSGOHudHealthAmmoCenter") {
                return true;
            }
            if (id === "AmmoClipBar") {
                return false;
            }
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return false;
    }

    function paintHealthFillPanel(panel, color) {
        if (!panel || !panel.IsValid() || !color) {
            return;
        }
        const fill = color.length === 7 ? (color + "ff") : color;
        try {
            panel.style.washColor = "#ffffffff";
        } catch (errWash) {
            try {
                panel.style.washColor = "none";
            } catch (errNone) {}
        }
        try {
            panel.style.backgroundColor = fill;
        } catch (errBg) {
            try {
                panel.style.backgroundColor = color;
            } catch (errBg2) {}
        }
    }

    function collectHealthFillPanels(host) {
        const out = [];
        const seen = [];
        function add(panel) {
            if (!panel || !panel.IsValid() || !isBottomHealthFill(panel)) {
                return;
            }
            for (let s = 0; s < seen.length; s += 1) {
                if (seen[s] === panel) {
                    return;
                }
            }
            seen.push(panel);
            out.push(panel);
        }
        if (!host || !host.FindChildrenWithClassTraverse) {
            return out;
        }
        const lefts = host.FindChildrenWithClassTraverse("ProgressBarLeft") || [];
        for (let i = 0; i < lefts.length; i += 1) {
            add(lefts[i]);
        }
        const haBars = host.FindChildrenWithClassTraverse("hud-HA-bar") || [];
        for (let h = 0; h < haBars.length; h += 1) {
            const ha = haBars[h];
            if (!ha || !ha.IsValid()) {
                continue;
            }
            if (ha.FindChildrenWithClassTraverse) {
                const kids = ha.FindChildrenWithClassTraverse("ProgressBarLeft") || [];
                for (let k = 0; k < kids.length; k += 1) {
                    add(kids[k]);
                }
            }
            if (typeof ha.GetChildCount === "function" && typeof ha.GetChild === "function") {
                const n = ha.GetChildCount();
                for (let c = 0; c < n; c += 1) {
                    const child = ha.GetChild(c);
                    if (child && child.BHasClass && child.BHasClass("ProgressBarLeft")) {
                        add(child);
                    }
                }
            }
        }
        return out;
    }

    function resolvePovColorSlot(povXuid, state) {
        function tryXuid(raw) {
            const slot = povColorSlot(raw);
            return slot;
        }
        let slot = tryXuid(povXuid);
        if (slot >= 0) {
            return slot;
        }
        try {
            slot = tryXuid(GameStateAPI.GetHudPlayerXuid());
            if (slot >= 0) {
                return slot;
            }
        } catch (errHud) {}
        if (state && state.nSpectatingPlayerId >= 0) {
            const sid = Number(state.nSpectatingPlayerId);
            for (let r = 0; r < roster.length; r += 1) {
                if (Number(roster[r].slot) === sid) {
                    slot = tryXuid(roster[r].xuid);
                    if (slot >= 0) {
                        return slot;
                    }
                }
            }
            try {
                slot = tryXuid(
                    GameStateAPI.GetPlayerXuidStringFromPlayerSlot(sid) || "",
                );
                if (slot >= 0) {
                    return slot;
                }
            } catch (errSlot) {}
        }
        // Name match against radar xuids when SteamID formats disagree.
        if (!radarTrack || !radarTrack.players) {
            return -1;
        }
        const nameSeeds = [];
        function pushName(xuid) {
            const want = normalizeXuid(xuid);
            if (!want) {
                return;
            }
            try {
                const name = String(GameStateAPI.GetPlayerName(want) || "").trim().toLowerCase();
                if (name) {
                    nameSeeds.push(name);
                }
            } catch (errName) {}
        }
        pushName(povXuid);
        if (state && state.nSpectatingPlayerId >= 0) {
            try {
                pushName(GameStateAPI.GetPlayerXuidStringFromPlayerSlot(state.nSpectatingPlayerId));
            } catch (errSlotName) {}
        }
        if (!nameSeeds.length) {
            return -1;
        }
        for (let i = 0; i < radarTrack.players.length; i += 1) {
            const player = radarTrack.players[i];
            let name = "";
            try {
                name = String(GameStateAPI.GetPlayerName(player.xuid) || "").trim().toLowerCase();
            } catch (errPlayerName) {}
            if (!name) {
                continue;
            }
            for (let n = 0; n < nameSeeds.length; n += 1) {
                if (name === nameSeeds[n]) {
                    const namedSlot = Number(player.colorSlot);
                    if (isFinite(namedSlot) && namedSlot >= 0 && namedSlot < PLAYER_COLOR_HEX.length) {
                        return namedSlot;
                    }
                }
            }
        }
        return -1;
    }

    function fixPovHealthHudColor(povXuid, state) {
        const root = hudRootPanel();
        if (!root) {
            return;
        }
        // Prefer HA host, but fall back to full HUD root — demo ids vary and CSS
        // already proved .hud-HA-bar .ProgressBarLeft is the live fill.
        let host = null;
        if (root.FindChildTraverse) {
            host = root.FindChildTraverse("HudHealthAmmoCenter")
                || root.FindChildTraverse("CSGOHudHealthAmmoCenter");
        }
        if (!host || !host.IsValid()) {
            host = root;
        }
        let slot = resolvePovColorSlot(povXuid, state);
        if (slot < 0) {
            slot = sampleHaTeammateSlot(host);
        }
        if (slot < 0) {
            return;
        }
        const color = PLAYER_COLOR_HEX[slot];
        const bars = collectHealthFillPanels(host);
        for (let b = 0; b < bars.length; b += 1) {
            applyHaSlotClass(bars[b], slot);
            paintHealthFillPanel(bars[b], color);
        }
    }

    function tickTeamCounterHud() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.1, tickTeamCounterHud);
            return;
        }
        const povXuid = currentPovXuid(state);
        const povTeam = updateVoiceAudience(state);
        updateTeamCounterForPov(povTeam, povXuid, state.nTick);
        fixPovHealthHudColor(povXuid, state);
        // 10Hz is enough for top-bar HP; Schedule(0) was locking the client ~5 FPS.
        $.Schedule(0.1, tickTeamCounterHud);
    }

    function ensureDemoVoicesUnmuted() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.25, ensureDemoVoicesUnmuted);
            return;
        }

        let pending = false;
        roster.forEach(function (player) {
            if (!player.xuid || player.unmuted) {
                return;
            }
            try {
                if (GameStateAPI.IsSelectedPlayerMuted(player.xuid)) {
                    GameStateAPI.ToggleMute(player.xuid);
                }
                GameStateAPI.SetPlayerVoiceVolume(player.xuid, 1);
                player.unmuted = GameStateAPI.IsSelectedPlayerMuted(player.xuid) === false
                    && GameStateAPI.GetPlayerVoiceVolume(player.xuid) > 0;
            } catch (err) {
                player.unmuted = false;
            }
            pending = pending || !player.unmuted;
        });

        unmuteAttempts += 1;
        if (pending && unmuteAttempts < 30) {
            $.Schedule(0.5, ensureDemoVoicesUnmuted);
        }
    }

    function findVoicePanel() {
        let root = controller;
        while (root.GetParent()) {
            root = root.GetParent();
        }
        const status = root.FindChildTraverse("Status");
        return status && status.IsValid() ? status.FindChildTraverse("VoicePanel") : null;
    }

    function flashBlindAt(xuid, tick) {
        if (!flashBlindEvents || !xuid) {
            return null;
        }
        const want = normalizeXuid(xuid);
        if (!want) {
            return null;
        }
        let best = null;
        for (let i = 0; i < flashBlindEvents.length; i += 1) {
            const event = flashBlindEvents[i];
            if (tick < event.tick) {
                break;
            }
            if (tick < event.endTick && sameXuid(event.xuid, want)) {
                if (!best || event.endTick > best.endTick) {
                    best = event;
                }
            }
        }
        return best;
    }

    function flashWashOpacity(blind, tick) {
        if (!blind) {
            return 0;
        }
        const start = blind.tick | 0;
        const end = blind.endTick | 0;
        const span = Math.max(1, end - start);
        let t = (Number(tick) - start) / span;
        if (t < 0) {
            t = 0;
        }
        if (t > 1) {
            t = 1;
        }
        // Degree comes from demo blind_duration (encoded as duration ticks).
        // Glancing flash → low peak; full-face → peak ~1.
        const peak = Math.min(1, span / FLASH_FULL_DURATION_TICKS);
        // Stronger flash lingers nearer white (lower power); weak fades quicker.
        const fadePower = 2.4 - 1.2 * peak;
        return peak * Math.pow(1 - t, fadePower);
    }

    function ensureFlashWash(root) {
        if (!root) {
            return null;
        }
        // Legacy binary cover / pliers debug from older builds — keep inert.
        const legacyIds = ["CS2InsightFlashCover", "CS2InsightPliersDebug"];
        for (let i = 0; i < legacyIds.length; i += 1) {
            const legacy = root.FindChildTraverse(legacyIds[i]);
            if (legacy && legacy.IsValid()) {
                legacy.visible = false;
                try {
                    legacy.style.opacity = "0";
                } catch (errLegacy) {}
            }
        }
        let wash = flashWashPanel;
        if (!wash || !wash.IsValid()) {
            wash = root.FindChildTraverse("CS2InsightFlashWash");
        }
        if (!wash || !wash.IsValid()) {
            wash = $.CreatePanel("Panel", root, "CS2InsightFlashWash");
        }
        wash.hittest = false;
        wash.style.width = "100%";
        wash.style.height = "100%";
        wash.style.horizontalAlign = "center";
        wash.style.verticalAlign = "center";
        wash.style.backgroundColor = "#ffffffff";
        wash.style.zIndex = "30000";
        try {
            if (wash.GetParent() !== root) {
                wash.SetParent(root);
            }
            const count = root.GetChildCount ? root.GetChildCount() : 0;
            if (count > 0 && typeof root.MoveChildAfter === "function") {
                const last = root.GetChild(count - 1);
                if (last && last !== wash) {
                    root.MoveChildAfter(wash, last);
                }
            }
        } catch (errOrder) {}
        flashWashPanel = wash;
        return wash;
    }

    function updateFlashWash(blind, tick) {
        const root = hudRootPanel();
        const wash = ensureFlashWash(root);
        if (!wash || !wash.IsValid()) {
            return;
        }
        const opacity = flashWashOpacity(blind, tick);
        if (opacity <= 0.01) {
            wash.visible = false;
            try {
                wash.style.opacity = "0";
            } catch (errHide) {}
            return;
        }
        wash.visible = true;
        try {
            wash.style.opacity = String(opacity.toFixed(3));
        } catch (errOp) {}
    }

    function hideStockDefuserChrome(root) {
        // Hide stock defuser/C4 chrome. Never DeleteAsync stock panels — that
        // crashes the client when the engine still holds references.
        if (!root || !root.FindChildTraverse) {
            return;
        }
        const ids = [
            "RI_BombDefuserPackage",
            "RI_DefuserPackage",
            "DefuserIconDropped",
            "DefuserIconPackage",
            "CreateBombPack",
        ];
        for (let i = 0; i < ids.length; i += 1) {
            const panel = root.FindChildTraverse(ids[i]);
            if (!panel || !panel.IsValid()) {
                continue;
            }
            panel.visible = false;
            try {
                panel.style.opacity = "0.0";
                panel.style.visibility = "collapse";
            } catch (errStyle) {}
        }
    }

    function flashTinnitusEventForBlind(blind) {
        if (!blind) {
            return FLASH_TINNITUS_MEDIUM;
        }
        const durationTicks = Math.max(1, (blind.endTick | 0) - (blind.tick | 0));
        // ~64 tick/s GOTV: Short <1.5s, Long >=3s.
        if (durationTicks < 96) {
            return FLASH_TINNITUS_SHORT;
        }
        if (durationTicks >= 192) {
            return FLASH_TINNITUS_LONG;
        }
        return FLASH_TINNITUS_MEDIUM;
    }

    function playFlashTinnitus(blind) {
        ensureKillFeedbackCheats();
        const soundEvent = flashTinnitusEventForBlind(blind);
        try {
            GameInterfaceAPI.ConsoleCommand("snd_sos_start_soundevent " + soundEvent);
        } catch (errTinnitus) {}
    }

    function tickFlashBlindHud() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.1, tickFlashBlindHud);
            return;
        }
        const povXuid = currentPovXuid(state);
        const blind = flashBlindAt(povXuid, state.nTick);
        updateFlashWash(blind, state.nTick);
        if (blind && flashTinnitusArmedTick !== blind.tick) {
            flashTinnitusArmedTick = blind.tick;
            playFlashTinnitus(blind);
        }
        if (!blind) {
            flashTinnitusArmedTick = -1;
        }
        $.Schedule(0.05, tickFlashBlindHud);
    }

    function worldInPovView(povSample, worldX, worldY, halfFovDeg) {
        if (!povSample) {
            return false;
        }
        const dx = Number(worldX) - Number(povSample.x);
        const dy = Number(worldY) - Number(povSample.y);
        if (!isFinite(dx) || !isFinite(dy)) {
            return false;
        }
        if (dx * dx + dy * dy < 1) {
            return true;
        }
        // CS yaw 0 = +X (east), 90 = +Y (north). atan2(dy, dx) matches.
        const targetYaw = Math.atan2(dy, dx) * (180 / Math.PI);
        let delta = ((targetYaw - Number(povSample.yaw) + 540) % 360) - 180;
        const half = halfFovDeg == null ? POV_VIEW_HALF_FOV_DEG : halfFovDeg;
        return Math.abs(delta) <= half;
    }

    function worldDist2D(ax, ay, bx, by) {
        const dx = Number(bx) - Number(ax);
        const dy = Number(by) - Number(ay);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function occlusionCellBlocked(occlusion, gx, gy) {
        if (!occlusion || !occlusion.bytes) {
            return false;
        }
        const grid = occlusion.grid | 0;
        if (gx < 0 || gy < 0 || gx >= grid || gy >= grid) {
            return true;
        }
        const index = gy * grid + gx;
        const byte = occlusion.bytes[index >> 3] || 0;
        return ((byte >> (7 - (index & 7))) & 1) !== 0;
    }

    function worldRadarOccluded(fromX, fromY, toX, toY) {
        // Best-effort 2D LOS via radar overview edges (not true BSP traces).
        const occlusion = radarTrack && radarTrack.occlusion;
        const transform = radarTrack && radarTrack.transform;
        if (!occlusion || !transform || !transform.scale) {
            return false;
        }
        const grid = occlusion.grid | 0;
        const a = worldToRadarPercent(fromX, fromY, transform);
        const b = worldToRadarPercent(toX, toY, transform);
        const gx0 = Math.floor((a.x / 100) * grid);
        const gy0 = Math.floor((a.y / 100) * grid);
        const gx1 = Math.floor((b.x / 100) * grid);
        const gy1 = Math.floor((b.y / 100) * grid);
        const steps = Math.max(Math.abs(gx1 - gx0), Math.abs(gy1 - gy0), 1) * 2;
        let streak = 0;
        let maxStreak = 0;
        for (let i = 0; i <= steps; i += 1) {
            const t = i / steps;
            if (t < 0.08 || t > 0.92) {
                streak = 0;
                continue;
            }
            const gx = Math.round(gx0 + (gx1 - gx0) * t);
            const gy = Math.round(gy0 + (gy1 - gy0) * t);
            if (occlusionCellBlocked(occlusion, gx, gy)) {
                streak += 1;
                if (streak > maxStreak) {
                    maxStreak = streak;
                }
            } else {
                streak = 0;
            }
        }
        return maxStreak >= 2;
    }

    function ctCanSeeDroppedBomb(povSample, dropX, dropY) {
        if (!povSample) {
            return false;
        }
        const dist = worldDist2D(povSample.x, povSample.y, dropX, dropY);
        if (!(dist <= POV_C4_MAX_VIEW_DIST)) {
            return false;
        }
        if (!worldInPovView(povSample, dropX, dropY, POV_VIEW_HALF_FOV_DEG)) {
            return false;
        }
        if (worldRadarOccluded(povSample.x, povSample.y, dropX, dropY)) {
            return false;
        }
        return true;
    }

    function pinVoiceNotices(voicePanel, activeRowCount, notice, row) {
        if (!voicePanel || !voicePanel.IsValid() || !notice || !notice.IsValid()) {
            return;
        }
        // Stock VoicePanel reserves tall empty space; row0 at y=0 sits far above money.
        // Shrink to active rows and bottom-align so notices stay flush above money.
        const rows = Math.max(1, activeRowCount | 0);
        try {
            voicePanel.style.verticalAlign = "bottom";
            voicePanel.style.height = (rows * VOICE_NOTICE_ROW_HEIGHT) + "px";
            voicePanel.style.overflow = "noclip";
        } catch (errPanel) {}
        try {
            notice.style.transitionProperty = "none";
            notice.style.position = "0px " + (row * VOICE_NOTICE_ROW_HEIGHT) + "px 0px";
        } catch (errNotice) {}
    }

    function createClassedPanel(type, parent, id, className) {
        const panel = $.CreatePanel(type, parent, id);
        panel.AddClass(className);
        return panel;
    }

    function findHudRoot() {
        let root = controller;
        while (root.GetParent()) {
            root = root.GetParent();
        }
        return root;
    }

    function styleKey(panel, active) {
        panel.style.backgroundColor = active ? "#12cfaee8" : "#071015c9";
        panel.style.border = active ? "2px solid #a4fff0" : "1px solid #8aa3ad88";
        panel.style.color = active ? "#ffffffff" : "#edf6f9e8";
        panel.style.boxShadow = active
            ? "fill #19f5c466 0px 0px 14px 0px"
            : "fill #00000099 0px 2px 7px 0px";
    }

    function createInputKey(parent, spec, index) {
        const key = $.CreatePanel("Label", parent, "CS2InsightInputKey" + index);
        key.text = spec[0];
        key.hittest = false;
        key.style.position = spec[1] + "px " + spec[2] + "px 0px";
        key.style.width = spec[3] + "px";
        key.style.height = spec[4] + "px";
        key.style.fontSize = spec[5] + "px";
        key.style.fontWeight = "bold";
        key.style.textAlign = "center";
        key.style.verticalAlign = "center";
        key.style.paddingTop = spec[6] + "px";
        key.style.borderRadius = "5px";
        key.style.transitionProperty = "background-color, border, color, box-shadow";
        key.style.transitionDuration = "0.025s";
        styleKey(key, false);
        return key;
    }

    function ensureInputHud() {
        if (inputHud && inputHud.IsValid()) {
            return inputHud;
        }
        const root = findHudRoot();
        inputHud = root.FindChildTraverse("CS2InsightInputHud");
        if (inputHud && inputHud.IsValid()) {
            return inputHud;
        }

        inputHud = $.CreatePanel("Panel", root, "CS2InsightInputHud");
        inputHud.hittest = false;
        inputHud.style.width = "396px";
        inputHud.style.height = "144px";
        inputHud.style.horizontalAlign = "center";
        inputHud.style.verticalAlign = "bottom";
        inputHud.style.marginBottom = "132px";
        inputHud.style.zIndex = "1000";

        const specs = [
            ["SHIFT", 0, 0, 74, 50, 16, 12, 6, false],
            ["CTRL", 0, 56, 74, 50, 17, 11, 5, false],
            ["W", 138, 0, 50, 50, 24, 8, 0, false],
            ["A", 82, 56, 50, 50, 24, 8, 1, false],
            ["S", 138, 56, 50, 50, 24, 8, 2, false],
            ["D", 194, 56, 50, 50, 24, 8, 3, false],
            ["R", 194, 0, 50, 50, 24, 8, 7, true],
            ["SPACE", 82, 112, 162, 32, 14, 5, 4, false],
            ["M1", 264, 0, 58, 144, 18, 52, 8, false],
            ["M2", 338, 0, 58, 144, 18, 52, 9, false],
        ];
        inputKeyPanels = specs.map(function (spec, index) {
            const panel = createInputKey(inputHud, spec, index);
            const onlyWhenActive = Boolean(spec[8]);
            panel.visible = !onlyWhenActive;
            return {
                panel: panel,
                bit: spec[7],
                onlyWhenActive: onlyWhenActive,
            };
        });
        return inputHud;
    }

    function inputMaskAt(changes, tick) {
        let low = 0;
        let high = changes.length - 1;
        let found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (changes[middle][0] <= tick) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (found < 0) {
            return 0;
        }
        let mask = changes[found][1];
        // Keep single-tick jump/reload/fire/scope transitions visible for four demo
        // ticks without introducing a wall-clock that would desync after goto.
        const stickyMask = (1 << 4) | (1 << 7) | (1 << 8) | (1 << 9);
        for (let index = found; index >= 0 && changes[index][0] >= tick - 3; index -= 1) {
            mask |= changes[index][1] & stickyMask;
        }
        return mask;
    }

    function updateInputHud() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            if (inputHud && inputHud.IsValid()) {
                inputHud.visible = false;
            }
            $.Schedule(0.1, updateInputHud);
            return;
        }

        let xuid = currentPovXuid(state);
        let changes = inputTracksByXuid[xuid];
        if (!changes) {
            if (inputHud && inputHud.IsValid()) {
                inputHud.visible = false;
            }
            $.Schedule(0, updateInputHud);
            return;
        }

        const panel = ensureInputHud();
        panel.visible = true;
        const mask = inputMaskAt(changes, state.nTick);
        inputKeyPanels.forEach(function (key) {
            const active = Boolean(mask & (1 << key.bit));
            key.panel.visible = !key.onlyWhenActive || active;
            styleKey(key.panel, active);
        });
        $.Schedule(0, updateInputHud);
    }

    function playerColorHex(xuid, colorSlot) {
        // Prefer demo colorSlot: demo/GOTV GetPlayerColor often returns team
        // yellow/cyan for everyone, which looks like the stock all-yellow/all-blue radar.
        if (colorSlot >= 0 && colorSlot < PLAYER_COLOR_HEX.length) {
            return PLAYER_COLOR_HEX[colorSlot];
        }
        const live = GameStateAPI.GetPlayerColor(xuid);
        if (live) {
            return live;
        }
        return "#d7dee7";
    }

    function allyDeathColorHex(colorSlot) {
        // Dead players: GameStateAPI.GetPlayerColor often returns team yellow/cyan.
        // Always use the demo colorSlot for ally death Xs.
        if (colorSlot >= 0 && colorSlot < PLAYER_COLOR_HEX.length) {
            return PLAYER_COLOR_HEX[colorSlot];
        }
        return "#d7dee7";
    }

    function worldToRadarPercent(x, y, transform) {
        const mapX = (x - transform.pos_x) / transform.scale;
        const mapY = (transform.pos_y - y) / transform.scale;
        return {
            x: (mapX / RADAR_MAP_SIZE) * 100,
            y: (mapY / RADAR_MAP_SIZE) * 100,
        };
    }

    function yawToCssRotation(yawDegrees) {
        // CS yaw 0 = +X (east), 90 = +Y (north). Radar Y is flipped, so north is up.
        return 90 - (Number(yawDegrees) || 0);
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function lerpAngle(a, b, t) {
        let delta = ((b - a + 540) % 360) - 180;
        return a + delta * t;
    }

    function radarSampleAt(player, tick, stride) {
        const samples = player.samples;
        if (!samples.length) {
            return null;
        }
        const offset = tick - player.startTick;
        if (offset <= 0) {
            const first = samples[0];
            return {
                x: first.x,
                y: first.y,
                yaw: first.yaw,
                alive: first.alive,
                hasC4: first.hasC4,
                spottedByT: first.spottedByT,
                spottedByCT: first.spottedByCT,
                team: first.team,
            };
        }
        const exact = offset / stride;
        const index = Math.floor(exact);
        if (index >= samples.length - 1) {
            const last = samples[samples.length - 1];
            return {
                x: last.x,
                y: last.y,
                yaw: last.yaw,
                alive: last.alive,
                hasC4: last.hasC4,
                spottedByT: last.spottedByT,
                spottedByCT: last.spottedByCT,
                team: last.team,
            };
        }
        const t = exact - index;
        const a = samples[index];
        const b = samples[index + 1];
        return {
            x: lerp(a.x, b.x, t),
            y: lerp(a.y, b.y, t),
            yaw: lerpAngle(a.yaw, b.yaw, t),
            alive: a.alive,
            hasC4: a.hasC4,
            spottedByT: a.spottedByT,
            spottedByCT: a.spottedByCT,
            team: a.team || 0,
        };
    }

    function findNativeRadar() {
        const root = findHudRoot();
        const radar = root.FindChildTraverse("HudRadar");
        return radar && radar.IsValid() ? radar : null;
    }

    function hideLegacyCustomRadar() {
        const root = findHudRoot();
        const legacy = root.FindChildTraverse("CS2InsightRadarHud");
        // Only remove the old root-level screenshot radar, not the overlay we parent
        // under the native map transform.
        if (legacy && legacy.IsValid() && legacy.GetParent() === root) {
            legacy.DeleteAsync(0.0);
        }
    }

    function panelIsVisible(panel) {
        if (!panel || !panel.IsValid()) {
            return false;
        }
        try {
            if (panel.visible === false) {
                return false;
            }
        } catch (err) {
            // Some panels may not expose visible consistently.
        }
        return true;
    }

    function resolveMapTransformHost(nativeRadar) {
        // Stock radar paints the overview texture into these transform panels and
        // applies always_centered / scale / rotate there. Markers must live here
        // in absolute overview UV space so each player stays at their own map
        // position instead of being re-projected through the POV.
        const roundTf = nativeRadar.FindChildTraverse("Radar__Round--InnerTransform");
        const squareTf = nativeRadar.FindChildTraverse("Radar__Square--InnerTransform");
        const squareRoot = nativeRadar.FindChildTraverse("Radar__Square");
        const roundRoot = nativeRadar.FindChildTraverse("Radar__Round");
        if (squareTf && squareTf.IsValid() && panelIsVisible(squareRoot)) {
            return squareTf;
        }
        if (roundTf && roundTf.IsValid() && panelIsVisible(roundRoot)) {
            return roundTf;
        }
        return roundTf || squareTf || nativeRadar.FindChildTraverse("Radar") || nativeRadar;
    }

    function hideNativeRadarPlayerIcons(nativeRadar) {
        // Only hide stock player icon packages. Never touch DirectionArrow (rim
        // facing pointer), native RI_PlayerSoundContainer, map transforms, bomb
        // zones, or the place-name label. Sound visualization belongs to CS2.

        function hideIfNativePlayerIcon(child) {
            if (!child || !child.IsValid()) {
                return;
            }
            const id = String(child.id || "");
            if (
                id === "CS2InsightRadarHud" ||
                id === "CS2InsightRadarUnclip" ||
                id.indexOf("CS2Insight") === 0 ||
                id === "DirectionArrow" ||
                id === "Radar__Round" ||
                id === "Radar__Square" ||
                id.indexOf("BombZone") === 0 ||
                id.indexOf("HZone") === 0
            ) {
                return;
            }
            // Always suppress stock bomb/defuser chrome — we draw our own C4.
            if (
                id === "RI_BombDefuserPackage" ||
                id === "RI_DefuserPackage" ||
                id === "DroppedBomb" ||
                id === "DefuserIconDropped" ||
                id === "DefuserIconPackage"
            ) {
                child.visible = false;
                return;
            }
            let isPlayerIcons = false;
            try {
                isPlayerIcons = child.BHasClass && child.BHasClass("PlayerIcons");
            } catch (err) {
                isPlayerIcons = false;
            }
            if (isPlayerIcons || id.indexOf("PlayerIcon") === 0) {
                child.visible = false;
            }
        }

        const radar = nativeRadar.FindChildTraverse("Radar") || nativeRadar;
        const roots = [radar];
        const roundTf = nativeRadar.FindChildTraverse("Radar__Round--InnerTransform");
        const squareTf = nativeRadar.FindChildTraverse("Radar__Square--InnerTransform");
        if (roundTf) {
            roots.push(roundTf);
        }
        if (squareTf) {
            roots.push(squareTf);
        }
        for (let r = 0; r < roots.length; r += 1) {
            const root = roots[r];
            if (!root || !root.IsValid() || !root.GetChildCount) {
                continue;
            }
            const count = root.GetChildCount();
            for (let index = 0; index < count; index += 1) {
                hideIfNativePlayerIcon(root.GetChild(index));
            }
        }

        if (radar.FindChildrenWithClassTraverse) {
            const packs = radar.FindChildrenWithClassTraverse("PlayerIcons") || [];
            for (let i = 0; i < packs.length; i += 1) {
                const pack = packs[i];
                const id = String(pack.id || "");
                if (id.indexOf("CS2Insight") === 0) {
                    continue;
                }
                pack.visible = false;
            }
        }

        const rim = nativeRadar.FindChildTraverse("DirectionArrow");
        if (rim && rim.IsValid()) {
            rim.visible = true;
        }

        hideStockDefuserChrome(hudRootPanel());
        // Nested stock bomb/defuser packages survive the shallow child walk.
        const stockChromeIds = [
            "RI_BombDefuserPackage",
            "RI_DefuserPackage",
            "DroppedBomb",
            "DefuserIconDropped",
            "DefuserIconPackage",
            "CreateBombPack",
        ];
        for (let s = 0; s < stockChromeIds.length; s += 1) {
            const chrome = nativeRadar.FindChildTraverse(stockChromeIds[s]);
            if (chrome && chrome.IsValid()) {
                chrome.visible = false;
                try {
                    chrome.style.opacity = "0.0";
                    chrome.style.visibility = "collapse";
                } catch (errChrome) {}
            }
        }
    }

    function unclipRadarForSoundRings(nativeRadar) {
        // Player layer sits outside Round--Inner so rings can paint past the green
        // circle. Keep #Radar clip:rect (outer frame). Never clear Inner border-radius.
        const ids = [
            "Radar__Round",
            "Radar__Square",
            "CS2InsightRadarHud",
        ];
        for (let i = 0; i < ids.length; i += 1) {
            const panel = nativeRadar.FindChildTraverse(ids[i]);
            if (!panel || !panel.IsValid() || !panel.style) {
                continue;
            }
            panel.style.overflow = "noclip";
        }
        if (radarHud && radarHud.IsValid() && radarHud.style) {
            radarHud.style.overflow = "noclip";
        }
    }

    function resolveRadarChromeParent(nativeRadar) {
        // Round/Square root: outside Inner circle clip, inside #Radar outer clip.
        const squareRoot = nativeRadar.FindChildTraverse("Radar__Square");
        const roundRoot = nativeRadar.FindChildTraverse("Radar__Round");
        if (squareRoot && squareRoot.IsValid() && panelIsVisible(squareRoot)) {
            return squareRoot;
        }
        if (roundRoot && roundRoot.IsValid()) {
            return roundRoot;
        }
        return nativeRadar.FindChildTraverse("Radar") || nativeRadar;
    }

    function ensureRadarLayerOrder(chrome) {
        // Bottom: map Inner. Middle: player hud. Top: circle/square border.
        const inner = chrome.FindChildTraverse("Radar__Round--Inner")
            || chrome.FindChildTraverse("Radar__Square--Inner");
        if (inner && inner.IsValid() && inner.style) {
            inner.style.zIndex = "1";
        }
        if (radarHud && radarHud.IsValid() && radarHud.style) {
            radarHud.style.zIndex = "50";
        }
        const border = chrome.FindChildTraverse("Radar__Round--Border")
            || chrome.FindChildTraverse("Radar__Square--Border");
        if (border && border.IsValid() && border.style) {
            border.style.zIndex = "100";
        }
    }

    function syncPlayerLayerToMapHost(layer, host, chrome) {
        // Same UV % space as InnerTransform, but not clipped by Inner border-radius.
        if (!layer || !layer.IsValid() || !host || !host.IsValid()) {
            return;
        }
        layer.style.overflow = "noclip";
        layer.style.flowChildren = "none";
        layer.style.zIndex = "50";
        layer.style.width = "100%";
        layer.style.height = "100%";
        layer.style.horizontalAlign = "center";
        layer.style.verticalAlign = "center";
        layer.style.x = "0px";
        layer.style.y = "0px";
        try {
            const tr = host.style ? host.style.transform : null;
            if (tr !== null && tr !== undefined && String(tr).length > 0) {
                layer.style.transform = String(tr);
            }
            const origin = host.style ? host.style.transformOrigin : null;
            layer.style.transformOrigin = origin ? String(origin) : "50% 50%";
        } catch (err) {}
        if (chrome && chrome.IsValid() && chrome.style) {
            chrome.style.overflow = "noclip";
        }
    }

    function ensureRadarUnclipHud(nativeRadar) {
        // Same parent as stock RI_PlayerSoundContainer: #Radar (outside Inner
        // border-radius). Position rings/frustum from the POV marker's laid-out
        // pixel offset so always_centered stays correct without copying C++ transforms.
        const radar = nativeRadar.FindChildTraverse("Radar") || nativeRadar;
        if (!radar || !radar.IsValid()) {
            return null;
        }
        if (radarUnclipHud && radarUnclipHud.IsValid() && radarUnclipHud.GetParent() === radar) {
            radarUnclipHud.style.overflow = "noclip";
            return radarUnclipHud;
        }
        let existing = radar.FindChildTraverse("CS2InsightRadarUnclip");
        if (existing && existing.IsValid()) {
            if (existing.GetParent() !== radar) {
                try { existing.SetParent(radar); } catch (err) {}
            }
            radarUnclipHud = existing;
        } else {
            radarUnclipHud = $.CreatePanel("Panel", radar, "CS2InsightRadarUnclip");
        }
        radarUnclipHud.hittest = false;
        radarUnclipHud.style.width = "100%";
        radarUnclipHud.style.height = "100%";
        radarUnclipHud.style.horizontalAlign = "left";
        radarUnclipHud.style.verticalAlign = "top";
        radarUnclipHud.style.overflow = "noclip";
        radarUnclipHud.style.flowChildren = "none";
        radarUnclipHud.style.zIndex = "80";
        return radarUnclipHud;
    }

    function markerCenterInRadarPx(marker, radar, percent) {
        if (!marker || !marker.IsValid() || !radar || !radar.IsValid()) {
            return null;
        }
        // Prefer window-space delta (includes C++ radar transforms).
        try {
            if (typeof marker.GetPositionWithinWindow === "function"
                && typeof radar.GetPositionWithinWindow === "function") {
                const m = marker.GetPositionWithinWindow();
                const r = radar.GetPositionWithinWindow();
                if (m && r && isFinite(m.x) && isFinite(m.y) && isFinite(r.x) && isFinite(r.y)) {
                    return { x: m.x - r.x, y: m.y - r.y };
                }
            }
        } catch (err) {}
        const offset = panelOffsetInAncestor(marker, radar);
        if (offset && (offset.ok || offset.x !== 0 || offset.y !== 0)) {
            return { x: offset.x, y: offset.y };
        }
        // UV percent → Radar px via InnerTransform's laid-out box.
        if (!percent) {
            return null;
        }
        const native = findNativeRadar();
        const host = native ? resolveMapTransformHost(native) : null;
        if (!host || !host.IsValid()) {
            return null;
        }
        const w = host.actuallayoutwidth || 0;
        const h = host.actuallayoutheight || 0;
        if (w <= 1 || h <= 1) {
            return null;
        }
        const hostOff = panelOffsetInAncestor(host, radar);
        return {
            x: hostOff.x + (percent.x / 100) * w,
            y: hostOff.y + (percent.y / 100) * h,
        };
    }

    function panelOffsetInAncestor(panel, ancestor) {
        let x = 0;
        let y = 0;
        let current = panel;
        let guard = 0;
        while (current && current.IsValid() && current !== ancestor && guard < 24) {
            x += typeof current.actualx === "number" ? current.actualx : 0;
            y += typeof current.actualy === "number" ? current.actualy : 0;
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return { x: x, y: y, ok: current === ancestor };
    }

    function ensureRadarUnclipHud(nativeRadar) {
        const radar = nativeRadar.FindChildTraverse("Radar") || nativeRadar;
        if (!radar || !radar.IsValid()) {
            return null;
        }
        if (radarUnclipHud && radarUnclipHud.IsValid() && radarUnclipHud.GetParent() === radar) {
            radarUnclipHud.style.overflow = "noclip";
            return radarUnclipHud;
        }
        let existing = radar.FindChildTraverse("CS2InsightRadarUnclip");
        if (existing && existing.IsValid()) {
            if (existing.GetParent() !== radar) {
                try { existing.SetParent(radar); } catch (err) {}
            }
            radarUnclipHud = existing;
        } else {
            radarUnclipHud = $.CreatePanel("Panel", radar, "CS2InsightRadarUnclip");
        }
        radarUnclipHud.hittest = false;
        radarUnclipHud.style.width = "100%";
        radarUnclipHud.style.height = "100%";
        radarUnclipHud.style.horizontalAlign = "left";
        radarUnclipHud.style.verticalAlign = "top";
        radarUnclipHud.style.overflow = "noclip";
        radarUnclipHud.style.flowChildren = "none";
        radarUnclipHud.style.zIndex = "40";
        return radarUnclipHud;
    }

    function ensurePovRadarFx(nativeRadar) {
        const unclip = ensureRadarUnclipHud(nativeRadar);
        if (!unclip) {
            return null;
        }
        if (povRadarFx
            && povRadarFx.anchor && povRadarFx.anchor.IsValid()
            && povRadarFx.anchor.GetParent() === unclip
            && povRadarFx.frustum && povRadarFx.frustum.IsValid()) {
            return povRadarFx;
        }

        const anchor = $.CreatePanel("Panel", unclip, "CS2InsightPovFxAnchor");
        anchor.hittest = false;
        anchor.style.width = "1px";
        anchor.style.height = "1px";
        anchor.style.horizontalAlign = "left";
        anchor.style.verticalAlign = "top";
        anchor.style.overflow = "noclip";
        anchor.style.flowChildren = "none";
        anchor.style.zIndex = "42";

        const rotated = $.CreatePanel("Panel", anchor, "CS2InsightPovFxRotated");
        rotated.hittest = false;
        rotated.style.width = "100px";
        rotated.style.height = "100px";
        rotated.style.x = "-50px";
        rotated.style.y = "-50px";
        rotated.style.transformOrigin = "50% 50%";
        rotated.style.flowChildren = "none";
        rotated.style.overflow = "noclip";

        const frustum = $.CreatePanel("Image", rotated, "CS2InsightUnclipFrustum");
        frustum.hittest = false;
        frustum.SetImage("s2r://panorama/images/icons/ui/map_view_angle.vsvg");
        frustum.style.height = "64px";
        frustum.style.width = "128px";
        frustum.style.horizontalAlign = "center";
        frustum.style.y = "-12px";
        frustum.style.opacity = "0.08";
        frustum.style.washColor = "#ffffffff";
        frustum.visible = false;

        povRadarFx = {
            anchor: anchor,
            rotated: rotated,
            frustum: frustum,
        };
        return povRadarFx;
    }

    function mapPercentToRadarPx(percent, nativeRadar) {
        const host = resolveMapTransformHost(nativeRadar);
        const radar = nativeRadar.FindChildTraverse("Radar") || nativeRadar;
        if (!host || !host.IsValid() || !radar || !radar.IsValid()) {
            return null;
        }
        const w = host.actuallayoutwidth || 0;
        const h = host.actuallayoutheight || 0;
        if (w <= 1 || h <= 1) {
            return null;
        }
        const offset = panelOffsetInAncestor(host, radar);
        return {
            x: offset.x + (percent.x / 100) * w,
            y: offset.y + (percent.y / 100) * h,
            pxPerMap: w / RADAR_MAP_SIZE,
            ok: offset.ok,
        };
    }

    function prepareNativeRadarHost() {
        const nativeRadar = findNativeRadar();
        if (!nativeRadar) {
            return null;
        }
        hideNativeRadarPlayerIcons(nativeRadar);
        return resolveMapTransformHost(nativeRadar);
    }

    function ensureRadarMarker(player, parent, index) {
        if (player.marker && player.marker.IsValid() && player.marker.GetParent() === parent
            && player.enemyPip && player.enemyPip.IsValid()
            && player.enemyGhost && player.enemyGhost.IsValid()
            && player.deathIcon && player.deathIcon.IsValid()
            && player.frustum && player.frustum.IsValid()) {
            return player.marker;
        }
        if (player.marker && player.marker.IsValid()) {
            try { player.marker.DeleteAsync(0.0); } catch (err) {}
        }
        player.marker = null;
        player.facingRoot = null;
        player.rotated = null;
        player.frustum = null;
        player.facing = null;
        player.pip = null;
        player.c4Icon = null;
        player.enemyPip = null;
        player.enemyGhost = null;
        player.deathIcon = null;

        // Mirror stock PlayerIcons packaging. Frustum stays on the marker in
        // InnerTransform percent space and inherits the native radar transform.
        const marker = $.CreatePanel("Panel", parent, "CS2InsightRadarPlayer" + index);
        marker.hittest = false;
        marker.AddClass("PlayerIcons");
        marker.style.width = "1px";
        marker.style.height = "1px";
        marker.style.horizontalAlign = "left";
        marker.style.verticalAlign = "top";
        marker.style.zIndex = "20";
        marker.style.overflow = "noclip";
        marker.style.flowChildren = "none";

        const rotated = $.CreatePanel("Panel", marker, "PI_FirstRotated");
        rotated.hittest = false;
        rotated.style.width = "100px";
        rotated.style.height = "100px";
        rotated.style.x = "-50px";
        rotated.style.y = "-50px";
        rotated.style.transformOrigin = "50% 50%";
        rotated.style.flowChildren = "none";
        rotated.style.overflow = "noclip";

        const frustum = $.CreatePanel("Image", rotated, "CS2InsightViewFrustum");
        frustum.hittest = false;
        frustum.SetImage("s2r://panorama/images/icons/ui/map_view_angle.vsvg");
        frustum.style.height = "64px";
        frustum.style.width = "128px";
        frustum.style.horizontalAlign = "center";
        frustum.style.y = "-12px";
        frustum.style.opacity = "0.08";
        frustum.style.washColor = "#ffffffff";
        frustum.visible = false;

        const pip = $.CreatePanel("Image", rotated, "CS2InsightOnMap");
        pip.hittest = false;
        pip.AddClass("PI_OnMap");
        pip.SetImage("s2r://panorama/images/hud/radar/icon-on-map_png.vtex");
        pip.style.width = "11px";
        pip.style.height = "11px";
        pip.style.horizontalAlign = "center";
        pip.style.verticalAlign = "center";
        pip.style.zIndex = "2";
        pip.style.imgShadow = "0px 0px 1px 1.0 #000000AA";

        const facing = $.CreatePanel("Image", rotated, "CS2InsightFacingTip");
        facing.hittest = false;
        facing.SetImage("s2r://panorama/images/hud/radar/icon_direction_indicator.vsvg");
        facing.style.height = "20px";
        facing.style.width = "11px";
        facing.style.horizontalAlign = "center";
        facing.style.y = "32px";
        facing.style.x = "0px";
        facing.style.zIndex = "4";
        facing.style.washColor = "#ffffffff";
        try {
            facing.SetScaling("stretch-to-fit-preserve-aspect");
        } catch (err) {
            // Older Panorama builds may not expose SetScaling.
        }

        const c4 = $.CreatePanel("Image", marker, "CS2InsightCarrierC4");
        c4.hittest = false;
        c4.SetImage("s2r://panorama/images/hud/radar/c4_sml_png.vtex");
        c4.style.width = "16px";
        c4.style.height = "12px";
        c4.style.marginLeft = "-8px";
        c4.style.marginTop = "-6px";
        c4.style.zIndex = "6";
        c4.style.imgShadow = "0px 0px 2px 2 #000000";
        c4.visible = false;

        const enemyPip = $.CreatePanel("Image", marker, "CS2InsightEnemyOnMap");
        enemyPip.hittest = false;
        enemyPip.SetImage("s2r://panorama/images/hud/radar/icon-enemy-on-map_png.vtex");
        enemyPip.style.width = "14px";
        enemyPip.style.height = "14px";
        enemyPip.style.marginLeft = "-7px";
        enemyPip.style.marginTop = "-7px";
        enemyPip.style.zIndex = "7";
        enemyPip.style.opacity = "1.0";
        enemyPip.style.visibility = "visible";
        enemyPip.style.washColor = "#ff1919FF";
        enemyPip.style.brightness = "1.35";
        enemyPip.style.imgShadow = "0px 0px 1px 0.75 #810000";
        enemyPip.visible = false;

        const enemyGhost = $.CreatePanel("Image", marker, "CS2InsightEnemyGhost");
        enemyGhost.hittest = false;
        enemyGhost.SetImage("s2r://panorama/images/hud/radar/icon-enemy-ghost_png.vtex");
        enemyGhost.style.width = "9px";
        enemyGhost.style.height = "15px";
        enemyGhost.style.marginLeft = "-4px";
        enemyGhost.style.marginTop = "-8px";
        enemyGhost.style.zIndex = "8";
        enemyGhost.style.opacity = "0.95";
        enemyGhost.style.washColor = "#ff1919FF";
        enemyGhost.style.brightness = "1.4";
        enemyGhost.visible = false;

        const deathIcon = $.CreatePanel("Image", marker, "CS2InsightDeathIcon");
        deathIcon.hittest = false;
        deathIcon.SetImage("s2r://panorama/images/icons/ui/map_death.vsvg");
        deathIcon.style.width = "19px";
        deathIcon.style.height = "19px";
        deathIcon.style.marginLeft = "-9px";
        deathIcon.style.marginTop = "-9px";
        deathIcon.style.zIndex = "9";
        deathIcon.style.horizontalAlign = "left";
        deathIcon.style.verticalAlign = "top";
        deathIcon.visible = false;

        player.marker = marker;
        player.facingRoot = rotated;
        player.rotated = rotated;
        player.frustum = frustum;
        player.facing = facing;
        player.pip = pip;
        player.c4Icon = c4;
        player.enemyPip = enemyPip;
        player.enemyGhost = enemyGhost;
        player.deathIcon = deathIcon;
        return marker;
    }

    function ensureRadarHud() {
        // Keep player markers on InnerTransform so they inherit C++ map
        // pan/zoom (chrome sibling lost that transform and drifted off-map).
        hideLegacyCustomRadar();
        const host = prepareNativeRadarHost();
        if (!host) {
            return null;
        }
        if (radarHud && radarHud.IsValid() && radarHud.GetParent() === host) {
            radarHud.style.overflow = "noclip";
            radarHud.style.zIndex = "15";
            return radarHud;
        }
        const nativeRadar = findNativeRadar();
        radarHud = host.FindChildTraverse("CS2InsightRadarHud")
            || (nativeRadar && nativeRadar.FindChildTraverse
                ? nativeRadar.FindChildTraverse("CS2InsightRadarHud")
                : null);
        if (radarHud && radarHud.IsValid()) {
            if (radarHud.GetParent() !== host) {
                try { radarHud.SetParent(host); } catch (err) {}
            }
        } else {
            radarHud = $.CreatePanel("Panel", host, "CS2InsightRadarHud");
            radarHud.hittest = false;
            radarMapImage = null;
            radarTrack.players.forEach(function (player, index) {
                ensureRadarMarker(player, radarHud, index);
            });
        }
        radarHud.style.width = "100%";
        radarHud.style.height = "100%";
        radarHud.style.horizontalAlign = "center";
        radarHud.style.verticalAlign = "center";
        radarHud.style.zIndex = "15";
        radarHud.style.overflow = "noclip";
        radarHud.style.flowChildren = "none";
        try {
            // Empty string throws "Failed to parse style value for transform"
            // and aborts the rest of huddemocontroller.ts.
            radarHud.style.transform = "none";
        } catch (err) {}
        radarHud.style.x = "0px";
        radarHud.style.y = "0px";
        return radarHud;
    }

    function updateRadarHud() {
        if (!radarTrack) {
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state) {
            if (radarHud && radarHud.IsValid()) {
                radarHud.visible = false;
            }
            $.Schedule(0.1, updateRadarHud);
            return;
        }

        const hud = ensureRadarHud();
        if (!hud) {
            $.Schedule(0.1, updateRadarHud);
            return;
        }
        const povXuid = currentPovXuid(state);
        const povTeam = resolvePovTeam(povXuid, state.nTick);
        const tick = state.nTick;
        hud.visible = true;

        let povSample = null;
        radarTrack.players.forEach(function (player) {
            if (String(player.xuid) === String(povXuid)) {
                povSample = radarSampleAt(player, tick, radarTrack.stride);
            }
        });

        // Seek / round rewind clears stale last-known / death marks.
        if (enemyIntelLastTick >= 0 && tick + 64 < enemyIntelLastTick) {
            Object.keys(enemyIntelByXuid).forEach(function (key) {
                delete enemyIntelByXuid[key];
            });
            Object.keys(deathIntelByXuid).forEach(function (key) {
                delete deathIntelByXuid[key];
            });
            Object.keys(deathExpiredByXuid).forEach(function (key) {
                delete deathExpiredByXuid[key];
            });
        }
        enemyIntelLastTick = tick;

        radarTrack.players.forEach(function (player, index) {
            const rosterPlayer = rosterByXuid[player.xuid];
            const playerTeam = resolvePovTeam(player.xuid, tick);
            const sameTeam = povTeam !== 0 && playerTeam === povTeam;
            const marker = ensureRadarMarker(player, hud, index);
            const sample = radarSampleAt(player, tick, radarTrack.stride);
            if (!sample || !rosterPlayer || povTeam === 0) {
                marker.visible = false;
                return;
            }

            const intelKey = String(player.xuid);
            // Capture death position once when alive → dead.
            if (sample.alive) {
                delete deathIntelByXuid[intelKey];
                delete deathExpiredByXuid[intelKey];
            } else if (!deathExpiredByXuid[intelKey] && !deathIntelByXuid[intelKey]) {
                deathIntelByXuid[intelKey] = {
                    x: sample.x,
                    y: sample.y,
                    tick: tick,
                    sameTeam: sameTeam,
                    team: playerTeam,
                    colorSlot: player.colorSlot,
                    xuid: player.xuid,
                };
            }
            const death = deathIntelByXuid[intelKey];
            const showDeath = !!death && (tick - death.tick) <= RADAR_DEATH_ICON_TICKS;
            if (death && !showDeath) {
                delete deathIntelByXuid[intelKey];
                deathExpiredByXuid[intelKey] = true;
            }

            // Native-like reveal: red dot while POV side has contact; red ? briefly
            // at last contact (stock-ish ~1.5s — ours used to linger until death).
            const spottedForPov = (povTeam === 2 && sample.spottedByT)
                || (povTeam === 3 && sample.spottedByCT);
            const showEnemy = (!sameTeam) && sample.alive && spottedForPov;
            if (showEnemy) {
                enemyIntelByXuid[intelKey] = {
                    x: sample.x,
                    y: sample.y,
                    tick: tick,
                };
            } else if (!sample.alive || sameTeam) {
                delete enemyIntelByXuid[intelKey];
            }
            const intel = enemyIntelByXuid[intelKey];
            const showGhost = (!sameTeam) && sample.alive && !showEnemy && !!intel
                && (tick - intel.tick) <= RADAR_LAST_KNOWN_TICKS;
            if (intel && !showGhost && !showEnemy) {
                delete enemyIntelByXuid[intelKey];
            }

            if ((!sameTeam && !showEnemy && !showGhost && !showDeath)
                || (sameTeam && !sample.alive && !showDeath)) {
                marker.visible = false;
                if (player.enemyPip && player.enemyPip.IsValid()) {
                    player.enemyPip.visible = false;
                }
                if (player.enemyGhost && player.enemyGhost.IsValid()) {
                    player.enemyGhost.visible = false;
                }
                if (player.deathIcon && player.deathIcon.IsValid()) {
                    player.deathIcon.visible = false;
                }
                return;
            }

            const drawX = showDeath ? death.x : (showGhost ? intel.x : sample.x);
            const drawY = showDeath ? death.y : (showGhost ? intel.y : sample.y);
            const percent = worldToRadarPercent(drawX, drawY, radarTrack.transform);
            const isPov = String(player.xuid) === String(povXuid);
            const color = playerColorHex(player.xuid, player.colorSlot);
            const cssYaw = yawToCssRotation(sample.yaw);

            marker.visible = true;
            marker.style.position = percent.x + "% " + percent.y + "% 0px";
            marker.style.zIndex = isPov ? "25" : (showDeath ? "23" : (showEnemy ? "22" : (showGhost ? "21" : "20")));
            marker.style.opacity = "1.0";
            marker.style.overflow = "noclip";

            if (player.rotated && player.rotated.IsValid()) {
                player.rotated.style.transform = "rotateZ(" + cssYaw + "deg)";
                player.rotated.style.overflow = "noclip";
                // Enemies only need pip/ghost/death; hide teammate chrome.
                player.rotated.visible = sameTeam && sample.alive && !showDeath;
            }
            const carrying = sameTeam && sample.alive && sample.hasC4 && !showDeath;
            if (player.frustum && player.frustum.IsValid()) {
                player.frustum.visible = sameTeam && sample.alive && isPov && !showDeath;
                if (isPov) {
                    player.frustum.style.washColor = "#ffffffff";
                    player.frustum.style.opacity = "0.08";
                }
            }
            if (player.pip && player.pip.IsValid()) {
                // Stock: CreateBombPack replaces the colored pip while carrying;
                // DirectionalIndicator stays on PI_FirstRotated.
                player.pip.visible = sameTeam && sample.alive && !carrying && !showDeath;
                player.pip.style.washColor = sample.alive ? color : "#6d7680";
                // Same size as teammates so stock DirectionalIndicator (y:32) seats
                // on the pip nose — larger POV pip made the tip look glued-on.
                player.pip.style.width = "11px";
                player.pip.style.height = "11px";
                player.pip.style.brightness = isPov ? "1.15" : "1.0";
            }
            if (player.facing && player.facing.IsValid()) {
                // Keep the small facing tip while carrying C4 (stock behavior).
                player.facing.visible = sameTeam && sample.alive && !showDeath;
                player.facing.style.washColor = "#ffffffff";
                player.facing.style.height = "20px";
                player.facing.style.width = "11px";
                player.facing.style.y = "32px";
                player.facing.style.x = "0px";
                player.facing.style.horizontalAlign = "center";
            }
            if (player.c4Icon && player.c4Icon.IsValid()) {
                player.c4Icon.visible = carrying;
                if (carrying) {
                    player.c4Icon.style.washColor = color;
                }
            }
            if (player.enemyPip && player.enemyPip.IsValid()) {
                player.enemyPip.visible = showEnemy && !showDeath;
                if (showEnemy) {
                    player.enemyPip.style.width = "14px";
                    player.enemyPip.style.height = "14px";
                    player.enemyPip.style.opacity = "1.0";
                    player.enemyPip.style.visibility = "visible";
                    player.enemyPip.style.washColor = "#ff1919FF";
                    player.enemyPip.style.brightness = "1.35";
                }
            }
            if (player.enemyGhost && player.enemyGhost.IsValid()) {
                player.enemyGhost.visible = showGhost && !showDeath;
                if (showGhost) {
                    player.enemyGhost.style.opacity = "0.95";
                    player.enemyGhost.style.visibility = "visible";
                    player.enemyGhost.style.washColor = "#ff1919FF";
                    player.enemyGhost.style.brightness = "1.4";
                }
            }
            if (player.deathIcon && player.deathIcon.IsValid()) {
                player.deathIcon.visible = showDeath;
                if (showDeath) {
                    // Allies: per-player colorSlot. Enemies: stock red.
                    player.deathIcon.style.washColor = death.sameTeam
                        ? allyDeathColorHex(death.colorSlot)
                        : "#ff1919FF";
                    player.deathIcon.style.opacity = "0.9";
                    player.deathIcon.style.visibility = "visible";
                }
            }
        });

        try {
            updatePlantedBombMarker(hud, tick, povTeam, povXuid);
            const nativeRadar = findNativeRadar();
            if (nativeRadar) {
                hideNativeRadarPlayerIcons(nativeRadar);
                updateRadarCombatBorder(nativeRadar, tick, povXuid);
            }
        } catch (radarErr) {
            // Never let FX/teamcounter kill the radar loop (native team dots return).
        }
        $.Schedule(0, updateRadarHud);
    }

    function updateRadarCombatBorder(nativeRadar, tick, povXuid) {
        // Live CS2 thickens the round/square radar rim while the local player fires.
        if (!nativeRadar || !nativeRadar.IsValid()) {
            return;
        }
        let firing = false;
        const changes = inputTracksByXuid[String(povXuid)];
        if (changes && changes.length) {
            // Bit 8 = M1 / fire (same sticky window as the input HUD).
            firing = Boolean(inputMaskAt(changes, tick) & (1 << 8));
        }
        if (!firing) {
            const sounds = findActivePovSounds(tick, povXuid);
            for (let i = 0; i < sounds.length; i += 1) {
                if (!sounds[i].step && sounds[i].radius >= 800) {
                    firing = true;
                    break;
                }
            }
        }
        const width = firing ? "3px" : "1px";
        const ids = ["Radar__Round--Border", "Radar__Square--Border"];
        for (let i = 0; i < ids.length; i += 1) {
            const border = nativeRadar.FindChildTraverse(ids[i]);
            if (!border || !border.IsValid() || !border.style) {
                continue;
            }
            border.style.borderWidth = width;
        }
    }

    function findActivePovSounds(tick, povXuid) {
        // Live HUD can stack two radii (e.g. footstep + gun). Prefer distinct
        // radii: one loud/land, one thinner step/weapon when both overlap.
        const sounds = (radarTrack && radarTrack.sounds) || [];
        if (!povXuid || !sounds.length) {
            return [];
        }
        const tickRate = Math.max(1, Number(radarTrack.stride) * 8);
        const windowStart = tick - tickRate;
        let lo = 0;
        let hi = sounds.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sounds[mid].tick < windowStart) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        const active = [];
        for (let index = lo; index < sounds.length; index += 1) {
            const sound = sounds[index];
            if (sound.tick > tick) {
                break;
            }
            if (String(sound.xuid) !== String(povXuid)) {
                continue;
            }
            const endTick = sound.tick + Math.max(1, Math.round((sound.durationMs / 1000) * tickRate));
            if (tick > endTick) {
                continue;
            }
            active.push(sound);
        }
        if (!active.length) {
            return [];
        }
        active.sort(function (a, b) {
            if (a.tick !== b.tick) {
                return b.tick - a.tick;
            }
            if (a.loud !== b.loud) {
                return a.loud ? -1 : 1;
            }
            return b.radius - a.radius;
        });
        const picked = [active[0]];
        for (let i = 1; i < active.length; i += 1) {
            const candidate = active[i];
            if (Math.abs(candidate.radius - picked[0].radius) < 150) {
                continue;
            }
            picked.push(candidate);
            break;
        }
        return picked;
    }

    function hidePovRadarFx() {
        if (!povRadarFx) {
            return;
        }
        if (povRadarFx.anchor && povRadarFx.anchor.IsValid()) {
            povRadarFx.anchor.visible = false;
        }
        if (povRadarFx.frustum && povRadarFx.frustum.IsValid()) {
            povRadarFx.frustum.visible = false;
        }
    }

    function updatePovUnclipFx(nativeRadar, tick, povXuid, povSample, povTeam) {
        // This helper owns only the custom POV viewing frustum. Sound circles are
        // rendered exclusively by CS2's native RI_PlayerSoundContainer.
        radarTrack.players.forEach(function (player) {
            if (player.frustum && player.frustum.IsValid()) {
                player.frustum.visible = false;
            }
        });

        const fx = ensurePovRadarFx(nativeRadar);
        if (!fx) {
            hidePovRadarFx();
            return;
        }
        if (!povSample || !povSample.alive || !povXuid) {
            hidePovRadarFx();
            return;
        }

        const percent = worldToRadarPercent(povSample.x, povSample.y, radarTrack.transform);
        const pos = mapPercentToRadarPx(percent, nativeRadar);
        if (!pos) {
            hidePovRadarFx();
            return;
        }

        const cssYaw = yawToCssRotation(povSample.yaw);
        fx.anchor.visible = true;
        fx.anchor.style.x = pos.x + "px";
        fx.anchor.style.y = pos.y + "px";
        fx.anchor.style.position = "0px 0px 0px";
        if (fx.rotated && fx.rotated.IsValid()) {
            fx.rotated.style.transform = "rotateZ(" + cssYaw + "deg)";
            fx.rotated.visible = true;
        }
        if (fx.frustum && fx.frustum.IsValid()) {
            fx.frustum.visible = true;
            fx.frustum.style.washColor = "#ffffffff";
            fx.frustum.style.opacity = "0.08";
        }

    }

    function ensurePlantedBombMarker(parent) {
        // Drop legacy large bomb_c4 / static red-ring markers from older builds.
        if (radarBombMarker && radarBombMarker.IsValid()) {
            const legacyRing = radarBombMarker.FindChildTraverse
                ? radarBombMarker.FindChildTraverse("CS2InsightPlantedRing")
                : null;
            const legacyBig = radarBombMarker.FindChildTraverse
                ? radarBombMarker.FindChildTraverse("CS2InsightPlantedC4")
                : null;
            let rebuild = false;
            if (legacyRing && legacyRing.IsValid()) {
                rebuild = true;
            }
            // Old builds used 24px bomb_c4.vsvg; live combat uses CreateBombPack size.
            if (legacyBig && legacyBig.IsValid() && legacyBig.style
                && String(legacyBig.style.width || "") === "24px") {
                rebuild = true;
            }
            if (rebuild) {
                try { radarBombMarker.DeleteAsync(0.0); } catch (err) {}
                radarBombMarker = null;
                radarBombIcon = null;
            }
        }
        if (radarBombMarker && radarBombMarker.IsValid() && radarBombMarker.GetParent() === parent
            && radarBombIcon && radarBombIcon.IsValid()) {
            return radarBombMarker;
        }
        const marker = $.CreatePanel("Panel", parent, "CS2InsightRadarBomb");
        marker.hittest = false;
        marker.style.width = "1px";
        marker.style.height = "1px";
        marker.style.horizontalAlign = "left";
        marker.style.verticalAlign = "top";
        marker.style.zIndex = "30";
        marker.style.overflow = "noclip";

        // Live planted look (fig.4): small c4_sml + PlantedBombAnimateRed img-shadow
        // breathing — not the large bomb_c4.vsvg / circular #PlantedBomb pulse.
        const icon = $.CreatePanel("Image", marker, "CS2InsightPlantedC4");
        icon.hittest = false;
        icon.SetImage("s2r://panorama/images/hud/radar/c4_sml_png.vtex");
        icon.AddClass("PlantedBombAnimateRed");
        icon.style.width = "16px";
        icon.style.height = "12px";
        icon.style.marginLeft = "-8px";
        icon.style.marginTop = "-6px";
        icon.style.horizontalAlign = "left";
        icon.style.verticalAlign = "top";
        icon.style.zIndex = "2";
        icon.style.imgShadow = "0px 0px 1px 1 #71060666";

        radarBombMarker = marker;
        radarBombIcon = icon;
        return marker;
    }

    function plantedBombAt(tick) {
        const plants = (radarTrack && radarTrack.plantedBombs) || [];
        for (let index = 0; index < plants.length; index += 1) {
            const plant = plants[index];
            if (tick >= plant.startTick && tick <= plant.endTick) {
                return plant;
            }
        }
        return null;
    }

    function updatePlantedBombMarker(hud, tick, povTeam, povXuid) {
        const plant = plantedBombAt(tick);
        if (!plant) {
            if (radarBombMarker && radarBombMarker.IsValid()) {
                radarBombMarker.visible = false;
            }
        } else {
            const marker = ensurePlantedBombMarker(hud);
            const percent = worldToRadarPercent(plant.x, plant.y, radarTrack.transform);
            marker.visible = true;
            marker.style.position = percent.x + "% " + percent.y + "% 0px";
        }
        updateDroppedBombMarker(hud, tick, povTeam, povXuid);
    }

    function droppedBombAt(tick) {
        const drops = (radarTrack && radarTrack.droppedBombs) || [];
        for (let index = 0; index < drops.length; index += 1) {
            const drop = drops[index];
            if (tick >= drop.startTick && tick <= drop.endTick) {
                return drop;
            }
        }
        return null;
    }

    function ensureDroppedBombMarker(parent) {
        if (radarDroppedBombMarker && radarDroppedBombMarker.IsValid()
            && radarDroppedBombMarker.GetParent() === parent
            && radarDroppedBombIcon && radarDroppedBombIcon.IsValid()) {
            return radarDroppedBombMarker;
        }
        if (radarDroppedBombMarker && radarDroppedBombMarker.IsValid()) {
            try { radarDroppedBombMarker.DeleteAsync(0.0); } catch (err) {}
        }
        const marker = $.CreatePanel("Panel", parent, "CS2InsightDroppedBomb");
        marker.hittest = false;
        marker.style.width = "1px";
        marker.style.height = "1px";
        marker.style.horizontalAlign = "left";
        marker.style.verticalAlign = "top";
        marker.style.zIndex = "29";
        marker.style.overflow = "noclip";

        // Stock dropped pulse ring (#DroppedBomb) + CreateBombPack glyph.
        const ring = $.CreatePanel("Panel", marker, "CS2InsightDroppedRing");
        ring.hittest = false;
        ring.AddClass("DroppedBomb");
        ring.style.width = "110px";
        ring.style.height = "110px";
        ring.style.marginLeft = "-55px";
        ring.style.marginTop = "-55px";
        ring.style.zIndex = "1";

        const icon = $.CreatePanel("Image", marker, "CS2InsightDroppedC4");
        icon.hittest = false;
        icon.SetImage("s2r://panorama/images/hud/radar/c4_sml_png.vtex");
        icon.style.width = "16px";
        icon.style.height = "12px";
        icon.style.marginLeft = "-8px";
        icon.style.marginTop = "-6px";
        icon.style.zIndex = "2";
        icon.style.imgShadow = "0px 0px 2px 2 black";
        icon.style.washColor = "#ffffffff";

        radarDroppedBombMarker = marker;
        radarDroppedBombIcon = icon;
        return marker;
    }

    function anyoneCarryingBomb(tick) {
        if (!radarTrack || !radarTrack.players) {
            return false;
        }
        for (let index = 0; index < radarTrack.players.length; index += 1) {
            const sample = radarSampleAt(radarTrack.players[index], tick, radarTrack.stride);
            if (sample && sample.hasC4) {
                return true;
            }
        }
        return false;
    }

    function updateDroppedBombMarker(hud, tick, povTeam, povXuid) {
        // Live CS2: T always sees ground C4. CT only with POV FOV + range +
        // best-effort radar-edge occlusion (no BSP wallhack ping).
        if (plantedBombAt(tick) || anyoneCarryingBomb(tick)) {
            if (radarDroppedBombMarker && radarDroppedBombMarker.IsValid()) {
                radarDroppedBombMarker.visible = false;
            }
            return;
        }
        const drop = droppedBombAt(tick);
        if (!drop) {
            if (radarDroppedBombMarker && radarDroppedBombMarker.IsValid()) {
                radarDroppedBombMarker.visible = false;
            }
            return;
        }
        if (povTeam === 3) {
            const povPlayer = findRadarPlayerByXuid(povXuid);
            const povSample = povPlayer ? radarSampleAt(povPlayer, tick, radarTrack.stride) : null;
            if (!ctCanSeeDroppedBomb(povSample, drop.x, drop.y)) {
                if (radarDroppedBombMarker && radarDroppedBombMarker.IsValid()) {
                    radarDroppedBombMarker.visible = false;
                }
                return;
            }
        }
        const marker = ensureDroppedBombMarker(hud);
        const percent = worldToRadarPercent(drop.x, drop.y, radarTrack.transform);
        marker.visible = true;
        marker.style.position = percent.x + "% " + percent.y + "% 0px";
        // T sees white ground C4; CT sees red.
        const wash = (povTeam === 3) ? "#ff1919FF" : "#ffffffff";
        const ringColor = (povTeam === 3) ? "#ff1919" : "#ffffff";
        if (radarDroppedBombIcon && radarDroppedBombIcon.IsValid() && radarDroppedBombIcon.style) {
            radarDroppedBombIcon.style.washColor = wash;
        }
        const ring = marker.FindChildTraverse
            ? marker.FindChildTraverse("CS2InsightDroppedRing")
            : null;
        if (ring && ring.IsValid() && ring.style) {
            try { ring.style.borderColor = ringColor; } catch (err) {}
        }
    }

    function ensureNotice(speaker, index, voicePanel) {
        if (speaker.panel && speaker.panel.IsValid() && speaker.panel.GetParent() === voicePanel) {
            return speaker.panel;
        }
        const notice = createClassedPanel(
            "Panel",
            voicePanel,
            "CS2InsightDemoVoice" + index,
            "VoiceNotice",
        );
        notice.AddClass("Hidden");
        notice.AddClass("Looping");
        notice.AddClass("DynamicAvatar");
        notice.hittest = false;

        const sound = createClassedPanel("Panel", notice, "", "SoundAnim");
        createClassedPanel("Panel", sound, "", "SpeakerIcon");
        createClassedPanel("Panel", sound, "", "SoundIcon1");
        createClassedPanel("Panel", sound, "", "SoundIcon2");
        createClassedPanel("Panel", sound, "", "SoundIcon3");

        const avatarPanel = createClassedPanel("Panel", notice, "", "AvatarPanel");
        createClassedPanel("Panel", avatarPanel, "", "AvatarBG");
        const avatar = createClassedPanel(
            "CSGOAvatarImage",
            avatarPanel,
            "SteamAvatar",
            "SteamAvatar",
        );
        createClassedPanel("Panel", avatarPanel, "", "Skull");
        const label = createClassedPanel("Label", notice, "VoiceText", "VoiceText");
        label.style.width = "fit-children";
        const locationLabel = createClassedPanel("Label", notice, "VoiceLocation", "VoiceText");
        locationLabel.style.width = "fit-children";
        locationLabel.style.color = "#a7d44cff";

        const xuid = speaker.xuid || GameStateAPI.GetPlayerXuidStringFromPlayerSlot(speaker.slot);
        if (xuid) {
            avatar.PopulateFromSteamID(xuid);
            const color = GameStateAPI.GetPlayerColor(xuid);
            if (color) {
                label.style.color = color;
            }
        } else {
            avatar.PopulateFromPlayerSlot(speaker.slot);
        }
        speaker.panel = notice;
        return notice;
    }

    function isSpeaking(intervals, tick) {
        let low = 0;
        let high = intervals.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const interval = intervals[middle];
            if (tick < interval[0]) {
                high = middle - 1;
            } else if (tick > interval[1]) {
                low = middle + 1;
            } else {
                return true;
            }
        }
        return false;
    }

    function locationAt(locations, tick) {
        let low = 0;
        let high = locations.length - 1;
        let found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (locations[middle][0] <= tick) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return found >= 0 ? locationTokens[locations[found][1]] : "";
    }

    function ensureKillFeedbackCheats() {
        if (killFeedbackCheatsReady) {
            return;
        }
        // snd_sos_start_soundevent is cheat-gated; POV demos already launch -insecure.
        GameInterfaceAPI.ConsoleCommand("sv_cheats 1");
        killFeedbackCheatsReady = true;
    }

    function playKillFeedbackEvent(event) {
        if (!event) {
            return;
        }
        ensureKillFeedbackCheats();
        let soundEvent = KILL_FEEDBACK_EVENT_BODY;
        if (event.headshot) {
            soundEvent = event.armor ? KILL_FEEDBACK_EVENT_HS_ARMOR : KILL_FEEDBACK_EVENT_HS;
        } else if (event.armor) {
            soundEvent = KILL_FEEDBACK_EVENT_BODY_ARMOR;
        }
        GameInterfaceAPI.ConsoleCommand("snd_sos_start_soundevent " + soundEvent);
    }

    function updateKillFeedback() {
        if (!killFeedbackEvents) {
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.1, updateKillFeedback);
            return;
        }
        const tick = state.nTick;
        const prev = killFeedbackLastTick;
        if (prev >= 0 && tick > prev && (tick - prev) <= KILL_FEEDBACK_CATCHUP_TICKS) {
            const povXuid = currentPovXuid(state);
            if (povXuid && povXuid !== "0") {
                for (let i = 0; i < killFeedbackEvents.length; i += 1) {
                    const event = killFeedbackEvents[i];
                    if (event.tick <= prev) {
                        continue;
                    }
                    if (event.tick > tick) {
                        break;
                    }
                    if (event.attackerXuid === povXuid) {
                        playKillFeedbackEvent(event);
                    }
                }
            }
        }
        killFeedbackLastTick = tick;
        $.Schedule(0, updateKillFeedback);
    }

    function update() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            speakers.forEach(function (speaker) {
                if (speaker.panel && speaker.panel.IsValid()) {
                    speaker.panel.AddClass("Hidden");
                }
            });
            $.Schedule(0.1, update);
            return;
        }

        const povTeam = updateVoiceAudience(state);
        const voicePanel = findVoicePanel();
        if (!voicePanel || !voicePanel.IsValid()) {
            speakers.forEach(function (speaker) {
                if (speaker.panel && speaker.panel.IsValid()) {
                    speaker.panel.AddClass("Hidden");
                }
            });
            $.Schedule(0.1, update);
            return;
        }

        const activeRows = {};
        let activeRowCount = 0;
        speakers.forEach(function (speaker, index) {
            const speakerPlayer = rosterByXuid[speaker.xuid];
            const sameTeam = povTeam !== 0 && speakerPlayer
                && resolvePovTeam(speaker.xuid, state.nTick) === povTeam;
            if (sameTeam
                && isSpeaking(speaker.intervals, state.nTick)
                && activeRowCount < MAX_VISIBLE_VOICE_NOTICES) {
                activeRows[index] = activeRowCount;
                activeRowCount += 1;
            }
        });

        speakers.forEach(function (speaker, index) {
            const row = activeRows[index];
            const active = row !== undefined;
            if (!active && (!speaker.panel || !speaker.panel.IsValid())) {
                return;
            }
            const notice = ensureNotice(speaker, index, voicePanel);
            if (active) {
                pinVoiceNotices(voicePanel, activeRowCount, notice, row);
                const xuid = speaker.xuid || GameStateAPI.GetPlayerXuidStringFromPlayerSlot(speaker.slot);
                const name = xuid ? GameStateAPI.GetPlayerName(xuid) : "";
                notice.FindChildTraverse("VoiceText").text = name || ("Player " + (speaker.slot + 1));
                const locationToken = locationAt(speaker.locations, state.nTick);
                const localizedLocation = locationToken ? $.Localize("#" + locationToken) : "";
                notice.FindChildTraverse("VoiceLocation").text = localizedLocation
                    ? "@ " + localizedLocation
                    : "";
            }
            notice.SetHasClass("Hidden", !active);
        });
        $.Schedule(0.05, update);
    }

    $.Schedule(0, ensureDemoVoicesUnmuted);
    $.Schedule(0, update);
    $.Schedule(0, updateInputHud);
    $.Schedule(0, tickTeamCounterHud);
    $.Schedule(0, tickFlashBlindHud);
    if (radarTrack) {
        $.Schedule(0, updateRadarHud);
    }
    if (killFeedbackEvents) {
        $.Schedule(0, updateKillFeedback);
    }
})();
