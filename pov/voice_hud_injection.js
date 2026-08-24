/*__CS2_INSIGHT_INJECTION_BEGIN__*/
// Injected into the stock Panorama huddemocontroller script in
// pov_voice_template.vpk. demo_voice_hud.py replaces only the bounded payload
// between the two marker comments before installing the package. The payload
// contains [location tokens, voice speakers, exact svc_UserCmd input tracks,
// SteamID/slot/team roster, reserved slots, radar track at index 8,
// kill/HS attacker-feedback cues at index 9, flash-blind intervals at index 10,
// reconstructed team radio at index 11, advanced-playback menu data at index 12].
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
    const encodedRadio = packed[11] || null;
    const encodedAdvancedPlayback = packed[12] || null;
    const PLAYER_COLOR_HEX = ["#88CEF5", "#009E80", "#F1E441", "#E6802A", "#BD2C96"];
    const RADAR_MAP_SIZE = 1024;
    const POV_RADAR_SCALE = 0.4;
    // CHudRadar keeps ten player-sound slots (indices 0..9).
    const MAX_POV_SOUND_RINGS = 10;
    const KILL_FEEDBACK_CATCHUP_TICKS = 128;
    const MAX_VISIBLE_VOICE_NOTICES = 3;
    const VOICE_NOTICE_ROW_HEIGHT = 22;
    // Native VoicePanel starts at y=182 and each voice row is 22px tall. Keep
    // the reconstructed message stack permanently one row above that baseline;
    // speaker activity must never move this message lane.
    const RADIO_PANEL_Y_OFFSET = 182 + VOICE_NOTICE_ROW_HEIGHT;
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
    // Stock game_sounds_ui confirmation layer (sounds/player/kill_doof_01.vsnd).
    // Play it alongside every body/headshot feedback event, never instead of it.
    const KILL_CONFIRMATION_EVENT = "UI.KillCard.1";
    // Flash tinnitus SOS events (duration bands match stock Flashbang.Ring.*).
    const FLASH_TINNITUS_SHORT = "Flashbang.Ring.Short";
    const FLASH_TINNITUS_MEDIUM = "Flashbang.Ring.Medium";
    const FLASH_TINNITUS_LONG = "Flashbang.Ring.Long";
    // CS flash client state: ~94 ms build-up, then a full-white / squared fade
    // based on the *remaining* time and a three-second certainty threshold.
    // The demo duration is already the server-merged overlap state.
    const FLASH_BUILD_UP_SECONDS = (255 / 45) / 60;
    const FLASH_CERTAIN_BLIND_SECONDS = 3;
    const FLASH_PAYLOAD_VERSION = 2;
    const FLASH_STATE_CLEAR = 1;
    // Rendering cadence only: flash timing and strength remain demo-tick based.
    // Raise active washes to ~60Hz so opacity changes do not arrive in 20Hz steps.
    const FLASH_ACTIVE_REFRESH_SECONDS = 0.016;
    const FLASH_IDLE_REFRESH_SECONDS = 0.05;
    // Normal playback advances only a few ticks per 20Hz sample. A larger jump
    // means demo_gototick moved to a new highlight segment.
    const TRANSIENT_HUD_TICK_JUMP_THRESHOLD = 64;
    // Keep transient Insight overlays hidden briefly after the pre-record pause
    // is released while CS2 completes its deferred HUD rebuild.
    const TRANSIENT_HUD_RESUME_GRACE_TICKS = 32;
    // A paused demo_gototick does not reliably emit PanoramaGameTimeJumpEvent.
    // Recording then runs spec_player shortly after demo_resume, which can
    // republish the seek-stale match alert. Keep the alert suppressed through
    // that rebuild window, then hand visibility back to CS2 once its native
    // state machine is stably hidden.
    const STOCK_HUD_ALERT_SUPPRESS_CLASS = "CS2InsightPausedSeekSuppress";
    const STOCK_HUD_ALERT_RESUME_GRACE_TICKS = 128;
    const STOCK_HUD_ALERT_HIDDEN_STABLE_FRAMES = 10;
    const RADIO_PAYLOAD_VERSION = 2;
    // Current CS2 hudvoicestatus.vcss: AlertNoticeLifetime is 15.5s. The
    // ShowAndHide animation fades over 0-5%, holds through 90%, then fades to
    // zero at 95% before the notice panel is reclaimed at 100%.
    const RADIO_MESSAGE_SECONDS = 15.5;
    const RADIO_FADE_IN_END = 0.05;
    const RADIO_FADE_OUT_START = 0.90;
    const RADIO_FADE_OUT_END = 0.95;
    const RADIO_ACTIVE_REFRESH_SECONDS = 0.016;
    const RADIO_IDLE_REFRESH_SECONDS = 0.05;
    // CCSGO_HudVoiceStatus constructs AlertPanel1..16 for chat, radio, and
    // server notices. POV mode replaces that entire lower-left message stream;
    // only those stock rows are hidden (voice speaker notices remain native).
    const NATIVE_VOICE_ALERT_PANEL_COUNT = 16;
    const MAX_VISIBLE_RADIO_MESSAGES = 10;
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

    function annotateContinuousStepSounds(sounds, tickRate) {
        // Stock player_sound footsteps are discrete 0.5s events, but the step
        // flag makes their radar presentation a continuous state. Merge events
        // whose authored lifetimes touch. Repeated rows extend one steady ring;
        // when the cadence ends the ring ends on that final state tick, without
        // retaining the authored audio lifetime as a visual release tail.
        const grouped = {};
        sounds.forEach(function (sound) {
            if (!sound.step) {
                return;
            }
            const key = String(sound.xuid) + ":" + String(sound.radius);
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(sound);
        });
        const cadenceFloorTicks = Math.max(1, Math.round(tickRate * 0.125));
        const releaseTicks = 0;
        Object.keys(grouped).forEach(function (key) {
            const rows = grouped[key];
            let chainStart = 0;
            while (chainStart < rows.length) {
                let chainEnd = chainStart;
                let hasFootstepCadence = false;
                while (chainEnd + 1 < rows.length) {
                    const current = rows[chainEnd];
                    const next = rows[chainEnd + 1];
                    const durationTicks = Math.max(
                        1,
                        Math.round((current.durationMs / 1000) * tickRate),
                    );
                    const gap = next.tick - current.tick;
                    if (gap > durationTicks) {
                        break;
                    }
                    if (gap >= cadenceFloorTicks) {
                        hasFootstepCadence = true;
                    }
                    chainEnd += 1;
                }
                if (hasFootstepCadence) {
                    const first = rows[chainStart];
                    const last = rows[chainEnd];
                    const stateId = ["step", key, first.tick].join(":");
                    for (let index = chainStart; index <= chainEnd; index += 1) {
                        rows[index].stepStateId = stateId;
                        rows[index].stepStateEndTick = last.tick + releaseTicks;
                    }
                }
                chainStart = chainEnd + 1;
            }
        });
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
        const nativeSoundComplete = Number(soundRaw[2] || 0) === 1;
        let soundTick = 0;
        const sounds = String(soundRaw[1] || "").split(",").filter(Boolean).map(function (token, soundIndex) {
            const fields = token.split(".");
            soundTick += parseInt(fields[0], 36) || 0;
            const flags = parseInt(fields[4], 36) || 0;
            return {
                id: "sound-" + soundIndex,
                tick: soundTick,
                xuid: soundXuids[parseInt(fields[1], 36) || 0] || "",
                radius: parseInt(fields[2], 36) || 0,
                durationMs: parseInt(fields[3], 36) || 100,
                step: (flags & 1) !== 0,
                loud: (flags & 2) !== 0,
                combatOnly: (flags & 4) !== 0,
            };
        }).filter(function (sound) {
            return sound.xuid && sound.radius > 0;
        });
        annotateContinuousStepSounds(sounds, Math.max(1, stride * 8));
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
            nativeSoundComplete: nativeSoundComplete,
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
        const tickRate = Math.max(1, Number(raw[2] || 64000) / 1000);
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
                reward: Math.max(0, parseInt(fields[3], 36) || 0),
                type: "cash",
                tickRate: tickRate,
            };
        }).filter(function (event) {
            return event.attackerXuid && event.tick >= 0;
        });
        return events.length ? { events: events, tickRate: tickRate } : null;
    }

    const killFeedbackTrack = decodeKillFeedbackTrack(encodedKillFeedback);
    const killFeedbackEvents = killFeedbackTrack ? killFeedbackTrack.events : null;

    function decodeFlashBlindTrack(raw) {
        if (!raw || !raw.length || raw.length < 2) {
            return null;
        }
        const xuids = (raw[0] || []).map(function (xuid) { return String(xuid || ""); });
        const version = Number(raw[2] || 1);
        const tickRate = Math.max(1, Number(raw[3] || 64000) / 1000);
        let previousTick = 0;
        const events = String(raw[1] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            previousTick += parseInt(fields[0], 36) || 0;
            const durationTicks = parseInt(fields[1], 36) || 0;
            const flags = version >= FLASH_PAYLOAD_VERSION
                ? (parseInt(fields[3], 36) || 0)
                : 0;
            const maxAlpha = version >= FLASH_PAYLOAD_VERSION
                ? Math.max(0, Math.min(255, parseInt(fields[4], 36) || 0))
                : 255;
            return {
                tick: previousTick,
                durationTicks: Math.max(0, durationTicks),
                xuid: xuids[parseInt(fields[2], 36) || 0] || "",
                clear: (flags & FLASH_STATE_CLEAR) !== 0,
                maxAlpha: maxAlpha,
            };
        }).filter(function (event) {
            return event.xuid
                && event.tick >= 0
                && (event.clear || event.durationTicks > 0);
        });
        return events.length ? {
            events: events,
            tickRate: tickRate,
            version: version,
        } : null;
    }

    const flashBlindTrack = decodeFlashBlindTrack(encodedFlashBlind);
    const flashBlindEvents = flashBlindTrack ? flashBlindTrack.events : null;

    function decodeRadioTrack(raw) {
        if (!raw || raw.length < 7 || Number(raw[6] || 0) < RADIO_PAYLOAD_VERSION) {
            return null;
        }
        const xuids = (raw[0] || []).map(function (xuid) { return String(xuid || ""); });
        const locations = (raw[1] || []).map(function (token) { return String(token || ""); });
        const texts = (raw[3] || []).map(function (row) {
            return {
                name: row && row.length ? String(row[0] || "") : "",
                text: row && row.length > 1 ? String(row[1] || "") : "",
            };
        });
        const tickRate = Math.max(1, Number(raw[5] || 64000) / 1000);
        let previousRadioTick = 0;
        const events = String(raw[2] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            previousRadioTick += parseInt(fields[0], 36) || 0;
            return {
                tick: previousRadioTick,
                xuid: xuids[parseInt(fields[1], 36) || 0] || "",
                kind: parseInt(fields[2], 36) || 0,
                location: locations[parseInt(fields[3], 36) || 0] || "",
                team: parseInt(fields[4], 36) || 0,
                type: "radio",
                tickRate: tickRate,
            };
        }).filter(function (event) {
            return event.xuid && event.tick >= 0 && event.team >= 2 && event.team <= 3;
        });
        let previousMessageTick = 0;
        const messages = String(raw[4] || "").split(",").filter(Boolean).map(function (token) {
            const fields = token.split(".");
            previousMessageTick += parseInt(fields[0], 36) || 0;
            const kind = parseInt(fields[1], 36) || 0;
            const text = texts[parseInt(fields[5], 36) || 0] || { name: "", text: "" };
            return {
                tick: previousMessageTick,
                messageKind: kind,
                xuid: xuids[parseInt(fields[2], 36) || 0] || "",
                team: parseInt(fields[3], 36) || 0,
                teamOnly: Boolean((parseInt(fields[4], 36) || 0) & 1),
                name: text.name,
                message: text.text,
                type: kind === 0 ? "chat" : "server",
                tickRate: tickRate,
            };
        }).filter(function (event) {
            return event.tick >= 0 && (event.type === "server" || event.message);
        });
        // The packed stream is already tick-ordered. Do not re-sort equal-tick
        // rows by XUID: CS2 displays radio messages in arrival order, including
        // two teammates throwing utility during the same server tick.
        return events.length || messages.length ? {
            events: events,
            messages: messages,
            tickRate: tickRate,
            version: Number(raw[6] || 0),
        } : null;
    }

    // Radio is an optional enhancement. A malformed platform event payload or
    // an older Panorama runtime must never abort this shared controller before
    // the established POV radar/input/flash schedules are registered.
    const radioTrack = (function safelyDecodeRadioTrack() {
        try {
            return decodeRadioTrack(encodedRadio);
        } catch (errRadioDecode) {
            return null;
        }
    })();

    function decodeAdvancedPlayback(raw) {
        if (!raw || !Array.isArray(raw) || Number(raw[0] || 0) !== 1) {
            return null;
        }
        const tickRate = Math.max(1, Number(raw[1] || 64000) / 1000);
        const encodedPlayers = Array.isArray(raw[2]) ? raw[2] : [];
        const details = Array.isArray(raw[3]) ? raw[3] : [""];
        const players = encodedPlayers.map(function (row, index) {
            return {
                xuid: normalizeXuid(row && row[0]),
                name: String(row && row[1] || ""),
                team: Number(row && row[2] || 0),
                parserSlot: Number(row && row[3] || index),
                index: index,
            };
        }).filter(function (player) {
            return player.xuid && (player.team === 2 || player.team === 3);
        });
        if (!players.length) {
            return null;
        }
        const byXuid = {};
        const eventsByXuid = {};
        let maximumEventTick = 0;
        players.forEach(function (player) {
            byXuid[player.xuid] = player;
            eventsByXuid[player.xuid] = [];
        });
        let previousTick = 0;
        String(raw[4] || "").split(",").filter(Boolean).forEach(function (token) {
            const fields = token.split(".");
            if (fields.length < 6) {
                return;
            }
            previousTick += parseInt(fields[0], 36) || 0;
            maximumEventTick = Math.max(maximumEventTick, previousTick);
            const type = parseInt(fields[1], 36) || 0;
            const actorIndex = (parseInt(fields[2], 36) || 0) - 1;
            const targetIndex = (parseInt(fields[3], 36) || 0) - 1;
            const detail = String(details[parseInt(fields[4], 36) || 0] || "");
            const flags = parseInt(fields[5], 36) || 0;
            const actor = actorIndex >= 0 ? players[actorIndex] : null;
            const target = targetIndex >= 0 ? players[targetIndex] : null;
            if (type === 0) {
                if (actor && eventsByXuid[actor.xuid]) {
                    eventsByXuid[actor.xuid].push({
                        tick: previousTick,
                        type: "kill",
                        detail: detail,
                        peerXuid: target ? target.xuid : "",
                        flags: flags,
                    });
                }
                if (target && eventsByXuid[target.xuid]) {
                    eventsByXuid[target.xuid].push({
                        tick: previousTick,
                        type: "death",
                        detail: detail,
                        peerXuid: actor ? actor.xuid : "",
                        flags: flags,
                    });
                }
            } else if (type === 1 && actor && eventsByXuid[actor.xuid]) {
                eventsByXuid[actor.xuid].push({
                    tick: previousTick,
                    type: "utility",
                    detail: detail,
                    peerXuid: "",
                    flags: flags,
                });
            }
        });
        const rounds = (Array.isArray(raw[6]) ? raw[6] : []).map(function (row, index) {
            const number = Math.max(1, Number(row && row[0] || (index + 1)));
            const start = Math.max(0, Number(row && row[1] || 0));
            const end = Math.max(start, Number(row && row[2] || start));
            return { number: number, start: start, end: end };
        }).filter(function (round) {
            return isFinite(round.number) && isFinite(round.start) && isFinite(round.end);
        });
        return {
            tickRate: tickRate,
            totalTick: Math.max(1, Number(raw[5] || 0), maximumEventTick),
            players: players,
            byXuid: byXuid,
            eventsByXuid: eventsByXuid,
            rounds: rounds,
        };
    }

    const advancedPlayback = (function safelyDecodeAdvancedPlayback() {
        try {
            return decodeAdvancedPlayback(encodedAdvancedPlayback);
        } catch (errAdvancedDecode) {
            return null;
        }
    })();
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
    let transientHudLastTick = -1;
    let transientHudSuppressUntilTick = -1;
    let stockHudAlertPanel = null;
    let stockHudAlertSeekSuppressActive = false;
    let stockHudAlertResumeTick = -1;
    let stockHudAlertHiddenStableFrames = 0;
    let radioHud = null;
    let overheadNativeCvarApplyAttempts = 0;
    let overheadNativeCvarRetryFrames = 0;
    let radioHistoryPanel = null;
    let radioHistoryRows = [];
    let nativeVoiceAlertPanels = [];
    let nativeChatHistoryText = null;
    let radioLastTick = -1;
    let radioEpochTick = -1;
    let advancedMenu = null;
    let advancedEdgeTrigger = null;
    let advancedMenuVisible = false;
    let advancedMenuHoverGeneration = 0;
    let advancedSelectedXuid = "";
    let advancedEventFilter = "all";
    let advancedEventPage = 0;
    let advancedViewMode = 5;
    let advancedPovVisualsEnabled = true;
    let advancedSpecOperation = null;
    let advancedMenuTickLabel = null;
    let advancedPlayerListPanel = null;
    let advancedEventListPanel = null;
    let advancedEventPagerLabel = null;
    let advancedProgressFill = null;
    let advancedProgressTrack = null;
    let advancedProgressSlider = null;
    let advancedProgressLabel = null;
    let advancedTickInput = null;
    let advancedPlayPauseButton = null;
    let advancedRoundLabel = null;
    let advancedRoundInput = null;
    let advancedPinButton = null;
    let advancedNumericPad = null;
    let advancedNumericEntry = null;
    let advancedNumericSubmit = null;
    let advancedMenuPinned = true;
    let advancedNativeMessagesRestored = false;
    let advancedNativeRadarRestored = false;
    let advancedNativeOverheadRestored = false;
    let advancedMenuDragging = false;
    let advancedMenuDragStartCursor = null;
    let advancedMenuDragStartPosition = null;
    let advancedMenuDragGhost = null;
    let advancedRoundIntervals = advancedPlayback && advancedPlayback.rounds
        ? advancedPlayback.rounds.slice()
        : [];
    let advancedNativeDemoUiCommandAttempts = 0;
    const advancedProfileButtons = {};
    const advancedVoiceButtons = {};
    const advancedFilterButtons = {};
    const advancedOptionButtons = {};
    const advancedOptionLabels = {};
    let advancedVoicePolicy = "team";
    let advancedPlayerTeamSignature = "";
    const advancedCustomVoiceXuids = {};
    const advancedRestrictedTeamCounterPanels = [];
    const advancedModifiedTeamSides = [];
    const advancedModifiedHealthPanels = [];
    const advancedQuickOptions = {
        xray: false,
        radar: true,
        overhead: true,
    };
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

    function advancedPovVisualsActive() {
        return !advancedPlayback || advancedPovVisualsEnabled;
    }

    function runtimeSlotForXuid(xuid) {
        const wanted = normalizeXuid(xuid);
        if (!wanted) {
            return -1;
        }
        for (let slot = 0; slot < 64; slot += 1) {
            let slotXuid = "";
            try {
                slotXuid = normalizeXuid(GameStateAPI.GetPlayerXuidStringFromPlayerSlot(slot) || "");
            } catch (errSlot) {}
            if (sameXuid(slotXuid, wanted)) {
                return slot;
            }
        }
        return -1;
    }

    function advancedVoiceAllows(xuid, povTeam, tick) {
        if (!advancedPlayback || advancedVoicePolicy === "team") {
            return povTeam !== 0 && resolvePovTeam(xuid, tick) === povTeam;
        }
        if (advancedVoicePolicy === "all") {
            return true;
        }
        if (advancedVoicePolicy === "mute") {
            return false;
        }
        return Boolean(advancedCustomVoiceXuids[normalizeXuid(xuid)]);
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
        if ((povTeam === 2 || povTeam === 3) || (advancedPlayback && advancedVoicePolicy !== "team")) {
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
                const allowed = advancedPlayback
                    ? advancedVoiceAllows(slotXuid, povTeam, tick)
                    : slotTeam === povTeam;
                if (!allowed) {
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
        const signature = (advancedPlayback ? advancedVoicePolicy : "team")
            + ":" + low + ":" + high;
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
            if (advancedPlayback && advancedRestrictedTeamCounterPanels.indexOf(panel) < 0) {
                advancedRestrictedTeamCounterPanels.push(panel);
            }
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

    function restoreAdvancedTeamCounterPanels() {
        for (let index = advancedRestrictedTeamCounterPanels.length - 1; index >= 0; index -= 1) {
            const panel = advancedRestrictedTeamCounterPanels[index];
            if (panel && panel.IsValid()) {
                setTeamCounterPanelRestricted(panel, false);
            }
        }
        advancedRestrictedTeamCounterPanels.length = 0;
        for (let sideIndex = advancedModifiedTeamSides.length - 1; sideIndex >= 0; sideIndex -= 1) {
            const side = advancedModifiedTeamSides[sideIndex];
            if (!side || !side.IsValid()) {
                continue;
            }
            try {
                side.RemoveClass("CS2InsightPovEnemy");
                side.RemoveClass("CS2InsightPovAlly");
            } catch (errClass) {}
        }
        advancedModifiedTeamSides.length = 0;
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

    function currentStockHudAlertPanel() {
        const alertText = findHudTraverse("AlertText");
        const resolved = alertText && alertText.IsValid() && alertText.GetParent
            ? alertText.GetParent()
            : null;
        if (resolved && resolved.IsValid()) {
            stockHudAlertPanel = resolved;
        } else if (!stockHudAlertPanel || !stockHudAlertPanel.IsValid()) {
            stockHudAlertPanel = null;
        }
        return stockHudAlertPanel;
    }

    function nativeStockHudAlertIsHidden(panel) {
        if (!panel || !panel.IsValid()) {
            return false;
        }
        try {
            return panel.BHasClass("AlertHidden")
                && !panel.BHasClass("AlertVisible")
                && !panel.BHasClass("FlashAnim")
                && !panel.BHasClass("HideFlash");
        } catch (errClass) {
            return false;
        }
    }

    function armStockHudAlertSeekSuppress(state, tick) {
        stockHudAlertSeekSuppressActive = true;
        stockHudAlertResumeTick = state && state.bIsPaused ? -1 : tick;
        stockHudAlertHiddenStableFrames = 0;
    }

    function updateStockHudAlertSeekSuppress(state, tick) {
        if (!stockHudAlertSeekSuppressActive) {
            return;
        }

        // Re-resolve after spec_player: CS2 can replace the native alert panel.
        const panel = currentStockHudAlertPanel();
        if (panel && panel.IsValid()) {
            try { panel.AddClass(STOCK_HUD_ALERT_SUPPRESS_CLASS); } catch (errAdd) {}
        }

        if (state.bIsPaused) {
            stockHudAlertHiddenStableFrames = 0;
            return;
        }
        if (stockHudAlertResumeTick < 0) {
            stockHudAlertResumeTick = tick;
        }
        if (tick < stockHudAlertResumeTick + STOCK_HUD_ALERT_RESUME_GRACE_TICKS) {
            stockHudAlertHiddenStableFrames = 0;
            return;
        }

        stockHudAlertHiddenStableFrames = nativeStockHudAlertIsHidden(panel)
            ? stockHudAlertHiddenStableFrames + 1
            : 0;
        if (stockHudAlertHiddenStableFrames < STOCK_HUD_ALERT_HIDDEN_STABLE_FRAMES) {
            return;
        }

        try { panel.RemoveClass(STOCK_HUD_ALERT_SUPPRESS_CLASS); } catch (errRemove) {}
        stockHudAlertSeekSuppressActive = false;
        stockHudAlertResumeTick = -1;
        stockHudAlertHiddenStableFrames = 0;
    }

    function watchDemoTimeJumps() {
        const state = controller.GetDemoControllerState();
        if (state && isFinite(Number(state.nTick))) {
            const tick = Number(state.nTick);
            const jumped = transientHudLastTick >= 0
                && (tick + 2 < transientHudLastTick
                    || tick - transientHudLastTick > TRANSIENT_HUD_TICK_JUMP_THRESHOLD);
            if (jumped) {
                // A full demo seek can replay the recorded mp_forcecamera=1
                // NetSetConVar. Re-arm the native TeamID override afterwards.
                overheadNativeCvarApplyAttempts = 0;
                overheadNativeCvarRetryFrames = 0;
                if (radioTrack) {
                    radioEpochTick = tick;
                }
                transientHudSuppressUntilTick = Math.max(
                    transientHudSuppressUntilTick,
                    tick + TRANSIENT_HUD_RESUME_GRACE_TICKS,
                );
                armStockHudAlertSeekSuppress(state, tick);
            }

            // The executor deliberately pauses at the exact segment start before
            // StartRecord/ResumeRecord. Reset reconstructed radio while paused;
            // the short tick grace covers CS2's deferred first resumed frames.
            if (state.bIsPaused) {
                if (radioTrack) {
                    radioEpochTick = tick;
                }
                transientHudSuppressUntilTick = Math.max(
                    transientHudSuppressUntilTick,
                    tick + TRANSIENT_HUD_RESUME_GRACE_TICKS,
                );
            }
            updateStockHudAlertSeekSuppress(state, tick);
            transientHudLastTick = tick;
        }
        $.Schedule(0.016, watchDemoTimeJumps);
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
            if (advancedPlayback && advancedModifiedTeamSides.indexOf(side) < 0) {
                advancedModifiedTeamSides.push(side);
            }
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
        if (advancedPlayback && advancedModifiedHealthPanels.indexOf(panel) < 0) {
            advancedModifiedHealthPanels.push(panel);
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
        const povTeam = updateVoiceAudience(state);
        if (!advancedPovVisualsActive()) {
            restoreAdvancedTeamCounterPanels();
            restoreAdvancedHealthPanels();
            $.Schedule(0.1, tickTeamCounterHud);
            return;
        }
        const povXuid = currentPovXuid(state);
        updateTeamCounterForPov(povTeam, povXuid, state.nTick);
        // Leave the native health fill untouched in both recording POV and
        // Advanced playback. Runtime wash/background writes override CS2's
        // damage, low-health, and post-plant states and can preserve a color
        // inherited from a VPK class after switching HUD profiles.
        // 10Hz is enough for top-bar HP; Schedule(0) was locking the client ~5 FPS.
        $.Schedule(0.1, tickTeamCounterHud);
    }

    function firstChildWithClass(panel, className) {
        if (!panel || !panel.IsValid() || !panel.FindChildrenWithClassTraverse) {
            return null;
        }
        const children = panel.FindChildrenWithClassTraverse(className) || [];
        for (let index = 0; index < children.length; index += 1) {
            if (children[index] && children[index].IsValid()) {
                return children[index];
            }
        }
        return null;
    }

    function forceNativePlayerOverheadCvars() {
        // Keep this inside the injected Panorama script as well as the backend
        // cfg. A long-running backend may still have the old Python constants,
        // and cl_drawhud_force_teamid_overhead=1 is the native bypass for
        // cl_draw_only_deathnotices in CCSGO_HudReticle.
        const commands = [
            "cl_draw_only_deathnotices false",
            "mp_forcecamera 0",
            "cl_drawhud_force_teamid_overhead 1",
            "cl_teamid_overhead_mode 3",
            "cl_teamid_overhead_colors_show 1",
            "cl_teamid_overhead_fade_near_crosshair 0",
            "cl_teamid_overhead_maxdist 9999",
            "cl_teamid_overhead_maxdist_spec 9999",
        ];
        for (let index = 0; index < commands.length; index += 1) {
            try {
                GameInterfaceAPI.ConsoleCommand(commands[index]);
            } catch (err) {}
        }
        overheadNativeCvarApplyAttempts += 1;
        overheadNativeCvarRetryFrames = 10;
    }

    function localizedPlayerOverheadValue(playerPanel, token) {
        try {
            const localized = String($.Localize(token, playerPanel) || "").trim();
            if (!localized
                || localized === token
                || localized.indexOf("{s:") >= 0
                || localized.indexOf("{d:") >= 0
                || localized.indexOf("%s") >= 0) {
                return "";
            }
            return localized;
        } catch (err) {
            return "";
        }
    }

    function normalizedOverheadName(value) {
        return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function buildOverheadXuidByName() {
        const lookup = {};
        for (let slot = 0; slot < 64; slot += 1) {
            let xuid = "";
            let name = "";
            try {
                xuid = normalizeXuid(GameStateAPI.GetPlayerXuidStringFromPlayerSlot(slot) || "");
                name = xuid ? normalizedOverheadName(GameStateAPI.GetPlayerName(xuid)) : "";
            } catch (err) {}
            if (xuid && name && lookup[name] === undefined) {
                lookup[name] = xuid;
            }
        }
        return lookup;
    }

    function overheadPanelXuid(playerPanel, xuidByName) {
        const nameLabel = firstChildWithClass(playerPanel, "playerid__name");
        if (!nameLabel || !nameLabel.IsValid()) {
            return "";
        }
        const name = normalizedOverheadName(nameLabel.text);
        return name ? (xuidByName[name] || "") : "";
    }

    function playerMoneyOverheadValue(playerPanel, xuidByName) {
        const xuid = overheadPanelXuid(playerPanel, xuidByName);
        if (xuid) {
            try {
                const value = Number(GameStateAPI.GetPlayerMoney(xuid));
                if (isFinite(value) && value >= 0) {
                    return Math.floor(value);
                }
            } catch (err) {}
        }
        const localized = localizedPlayerOverheadValue(
            playerPanel,
            "#Panorama_HUD_playerid_overhead_money",
        );
        const digits = String(localized).replace(/[^0-9]/g, "");
        const parsed = Number(digits);
        // An unset player_money variable localizes to a bare "$". Never
        // mistake that empty value for a real zero-dollar balance.
        return digits && isFinite(parsed) ? parsed : null;
    }

    function playerOverheadTeam(playerPanel) {
        try {
            if (playerPanel.BHasClass("playerid--team-t")) {
                return 2;
            }
            if (playerPanel.BHasClass("playerid--team-ct")) {
                return 3;
            }
        } catch (err) {}
        return 0;
    }

    function setPlayerOverheadContentVisible(playerPanel, visible) {
        const content = firstChildWithClass(playerPanel, "playerid__content_parent")
            || firstChildWithClass(playerPanel, "playerid__content");
        if (!content || !content.IsValid()) {
            return;
        }
        content.visible = visible;
        try {
            content.style.visibility = visible ? "visible" : "collapse";
        } catch (err) {}
    }

    function setNativePlayerEconomy(playerPanel, money) {
        if (!playerPanel || !playerPanel.FindChildrenWithClassTraverse) {
            return;
        }
        if (playerPanel._insightOriginalMoneyClass === undefined) {
            try {
                playerPanel._insightOriginalMoneyClass = playerPanel.HasClass("money");
                playerPanel._insightOriginalNormalHealthClass = playerPanel.HasClass("normal-health");
                playerPanel._insightOriginalLowHealthClass = playerPanel.HasClass("low-health");
            } catch (errOriginalClasses) {}
        }
        const active = money !== null;
        const text = active ? ("$" + money) : "";
        try {
            // Stock hudreticle.vcss does not color money through Label.color.
            // Native CCSGO_HudReticle puts `money` on the pooled player panel,
            // which selects rgb(177, 224, 136) through wash-color. The health
            // state classes have team-colored selectors with higher specificity,
            // so clear them while this label is being used for economy only.
            playerPanel.SetHasClass("money", active);
            if (active) {
                playerPanel.SetHasClass("normal-health", false);
                playerPanel.SetHasClass("low-health", false);
            }
        } catch (err) {}
        if (active && playerPanel.SetDialogVariableInt) {
            try {
                playerPanel.SetDialogVariableInt("player_money", money);
            } catch (err) {}
        }
        const labels = playerPanel.FindChildrenWithClassTraverse("playerid__extrainfo") || [];
        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index];
            if (!label || !label.IsValid()) {
                continue;
            }
            if (label._insightOriginalOverheadText === undefined) {
                label._insightOriginalOverheadText = String(label.text || "");
                label._insightOriginalOverheadVisible = Boolean(label.visible);
                try {
                    label._insightOriginalOverheadVisibility = label.style.visibility;
                    label._insightOriginalOverheadColor = label.style.color;
                } catch (errOriginalStyle) {}
            }
            // Reuse the native extra-info label instead of creating a wide
            // custom panel. Its engine-owned layout stays centered on the
            // player's world-to-screen anchor at every distance.
            label.text = text;
            label.visible = active;
            try {
                label.style.visibility = active ? "visible" : "collapse";
                // Keep the label's source color neutral so the stock `.money`
                // wash-color is the sole tint, exactly as in the live HUD.
                label.style.color = "white";
            } catch (err) {}
        }
    }

    function updatePlayerOverheadInfo(playerPanel, xuidByName) {
        setNativePlayerEconomy(
            playerPanel,
            playerMoneyOverheadValue(playerPanel, xuidByName),
        );
    }

    function restoreNativePlayerEconomy(playerPanel) {
        if (!playerPanel || !playerPanel.IsValid()) {
            return;
        }
        try {
            playerPanel.SetHasClass("money", Boolean(playerPanel._insightOriginalMoneyClass));
            if (playerPanel._insightOriginalNormalHealthClass !== undefined) {
                playerPanel.SetHasClass(
                    "normal-health",
                    Boolean(playerPanel._insightOriginalNormalHealthClass),
                );
            }
            if (playerPanel._insightOriginalLowHealthClass !== undefined) {
                playerPanel.SetHasClass(
                    "low-health",
                    Boolean(playerPanel._insightOriginalLowHealthClass),
                );
            }
        } catch (errClass) {}
        if (!playerPanel.FindChildrenWithClassTraverse) {
            return;
        }
        const labels = playerPanel.FindChildrenWithClassTraverse("playerid__extrainfo") || [];
        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index];
            if (!label || !label.IsValid()) {
                continue;
            }
            if (label._insightOriginalOverheadText !== undefined) {
                label.text = label._insightOriginalOverheadText;
            }
            if (label._insightOriginalOverheadVisible !== undefined) {
                label.visible = Boolean(label._insightOriginalOverheadVisible);
            }
            try {
                label.style.visibility = label._insightOriginalOverheadVisibility || null;
                label.style.color = label._insightOriginalOverheadColor || null;
            } catch (errStyle) {}
        }
    }

    function updateOverheadInfoHud() {
        const state = controller.GetDemoControllerState();
        if (!advancedPovVisualsActive()) {
            const nativeIds = findHudTraverse("VisiblePlayerIDs");
            if (nativeIds && nativeIds.IsValid() && nativeIds.FindChildrenWithClassTraverse) {
                const nativePanels = nativeIds.FindChildrenWithClassTraverse("playerid") || [];
                nativePanels.forEach(function (panel) {
                    if (panel && panel.IsValid()) {
                        if (!advancedNativeOverheadRestored) {
                            // Clear Insight's POV-only money label once, then
                            // return the panel to CS2. Re-clearing this label at
                            // 10 Hz prevented native DEMO HUD details from being
                            // populated and left only the player name visible.
                            restoreNativePlayerEconomy(panel);
                            setPlayerOverheadContentVisible(panel, true);
                        }
                        if (!advancedQuickOptions.overhead) {
                            setPlayerOverheadContentVisible(panel, false);
                        }
                    }
                });
                if (advancedQuickOptions.overhead) {
                    advancedNativeOverheadRestored = true;
                }
            }
            $.Schedule(0.1, updateOverheadInfoHud);
            return;
        }
        advancedNativeOverheadRestored = false;
        if (advancedPlayback && !advancedQuickOptions.overhead) {
            const nativeIds = findHudTraverse("VisiblePlayerIDs");
            if (nativeIds && nativeIds.IsValid() && nativeIds.FindChildrenWithClassTraverse) {
                const nativePanels = nativeIds.FindChildrenWithClassTraverse("playerid") || [];
                nativePanels.forEach(function (panel) {
                    if (panel && panel.IsValid()) {
                        setPlayerOverheadContentVisible(panel, false);
                    }
                });
            }
            $.Schedule(0.1, updateOverheadInfoHud);
            return;
        }
        // Reapply a few times after the demo state becomes live. This covers
        // launch cfg/user-config ordering without spamming the console forever.
        if (state && overheadNativeCvarApplyAttempts < 4) {
            if (overheadNativeCvarRetryFrames <= 0) {
                forceNativePlayerOverheadCvars();
            } else {
                overheadNativeCvarRetryFrames -= 1;
            }
        }
        const visiblePlayerIds = findHudTraverse("VisiblePlayerIDs");
        if (visiblePlayerIds
            && visiblePlayerIds.IsValid()
            && visiblePlayerIds.FindChildrenWithClassTraverse) {
            const playerPanels = visiblePlayerIds.FindChildrenWithClassTraverse("playerid") || [];
            const povTeam = state
                ? resolvePovTeam(currentPovXuid(state), state.nTick)
                : 0;
            const xuidByName = buildOverheadXuidByName();
            for (let index = 0; index < playerPanels.length; index += 1) {
                const playerPanel = playerPanels[index];
                if (playerPanel && playerPanel.IsValid()) {
                    const panelTeam = playerOverheadTeam(playerPanel);
                    const visible = povTeam === 0 || panelTeam === 0 || panelTeam === povTeam;
                    setPlayerOverheadContentVisible(playerPanel, visible);
                    if (visible) {
                        updatePlayerOverheadInfo(playerPanel, xuidByName);
                    }
                }
            }
        }
        // Match the native player-ID update cadence without creating a frame loop.
        $.Schedule(0.1, updateOverheadInfoHud);
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
        let state = null;
        for (let i = 0; i < flashBlindEvents.length; i += 1) {
            const event = flashBlindEvents[i];
            if (tick < event.tick) {
                break;
            }
            if (!sameXuid(event.xuid, want)) {
                continue;
            }
            if (event.clear) {
                state = null;
                continue;
            }
            const wasActive = Boolean(state && event.tick < state.endTick);
            state = {
                // Latest update tick drives one tinnitus cue per actual hit.
                tick: event.tick,
                startTick: wasActive ? state.startTick : event.tick,
                endTick: event.tick + event.durationTicks,
                durationTicks: event.durationTicks,
                maxAlpha: wasActive
                    ? Math.max(state.maxAlpha, event.maxAlpha)
                    : event.maxAlpha,
                // RecvProxy_FlashTime only starts build-up from an inactive state.
                // Any overlapping update ends an in-progress build-up immediately.
                buildUp: !wasActive,
            };
        }
        if (!state || tick >= state.endTick) {
            return null;
        }
        return state;
    }

    function flashWashOpacity(blind, tick) {
        if (!blind) {
            return 0;
        }
        const tickRate = flashBlindTrack ? flashBlindTrack.tickRate : 64;
        const alpha = Math.max(0, Math.min(1, Number(blind.maxAlpha) / 255));
        const durationSeconds = Math.max(1 / tickRate, blind.durationTicks / tickRate);
        const strength = alpha * Math.min(
            1,
            Math.pow(durationSeconds / FLASH_CERTAIN_BLIND_SECONDS, 2),
        );
        const elapsedSeconds = Math.max(0, (Number(tick) - blind.startTick) / tickRate);

        let white;
        let screenshot;
        if (blind.buildUp && elapsedSeconds < FLASH_BUILD_UP_SECONDS) {
            const phase = Math.max(0, Math.min(1, elapsedSeconds / FLASH_BUILD_UP_SECONDS));
            white = alpha * phase;
            screenshot = phase;
        } else {
            const remainingSeconds = Math.max(0, (blind.endTick - Number(tick)) / tickRate);
            white = alpha * Math.min(
                1,
                Math.pow(remainingSeconds / FLASH_CERTAIN_BLIND_SECONDS, 2),
            );
            screenshot = Math.max(0, Math.min(1, remainingSeconds / durationSeconds));
        }

        // CS draws the captured flash frame four times. The demo does not retain
        // that client-only texture, so convert its linear alpha into an equivalent
        // HUD occlusion, scaled by the authored flash strength. Native world flash
        // remains below this topmost Panorama compensation layer.
        const afterimage = strength * (1 - Math.pow(1 - screenshot, 4));
        let cover = 1 - (1 - white) * (1 - afterimage);
        if (cover >= 0.995) {
            cover = 1;
        } else if (cover <= 0.002) {
            cover = 0;
        }
        return Math.max(0, Math.min(1, cover));
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
        if (!blind) {
            wash.visible = false;
            try {
                wash.style.opacity = "0";
            } catch (errHide) {}
            return;
        }
        const opacity = Math.max(0, Math.min(1, flashWashOpacity(blind, tick)));
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
        if (!advancedPovVisualsActive()) {
            updateFlashWash(null, state && isFinite(Number(state.nTick)) ? Number(state.nTick) : 0);
            flashTinnitusArmedTick = -1;
            $.Schedule(FLASH_IDLE_REFRESH_SECONDS, tickFlashBlindHud);
            return;
        }
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
        $.Schedule(
            blind ? FLASH_ACTIVE_REFRESH_SECONDS : FLASH_IDLE_REFRESH_SECONDS,
            tickFlashBlindHud,
        );
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
        if (!advancedPovVisualsActive()) {
            if (inputHud && inputHud.IsValid()) {
                inputHud.visible = false;
            }
            $.Schedule(0.1, updateInputHud);
            return;
        }
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
        advancedNativeRadarRestored = false;
        // Only hide stock player icon packages. Never touch DirectionArrow (rim
        // facing pointer), native RI_PlayerSoundContainer, map transforms, bomb
        // zones, or the place-name label. Sound visibility is selected explicitly
        // in updatePovSoundRings instead of being an accidental PlayerIcons side effect.
        const nativeSoundRoot = nativeRadar.FindChildTraverse("RI_PlayerSoundContainer");

        function belongsToNativeSoundRoot(panel) {
            if (!radarTrack.nativeSoundComplete || !nativeSoundRoot || !nativeSoundRoot.IsValid()) {
                return false;
            }
            let current = panel;
            let guard = 0;
            while (current && current.IsValid() && guard < 16) {
                if (current === nativeSoundRoot) {
                    return true;
                }
                current = current.GetParent ? current.GetParent() : null;
                guard += 1;
            }
            return false;
        }

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
                id === "RI_PlayerSoundContainer" ||
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
                if (id.indexOf("CS2Insight") === 0 || belongsToNativeSoundRoot(pack)) {
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
        // Mirror stock RI_PlayerSoundContainer: a full #Radar-sized sibling of
        // Round--Inner, so POV effects are bounded only by #Radar's outer clip.
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
        const currentSoundRingsValid = povRadarFx
            && Array.isArray(povRadarFx.soundRings)
            && povRadarFx.soundRings.length === MAX_POV_SOUND_RINGS
            && povRadarFx.soundRings.every(function (ring) {
                return ring && ring.IsValid();
            });
        if (povRadarFx
            && povRadarFx.anchor && povRadarFx.anchor.IsValid()
            && povRadarFx.anchor.GetParent() === unclip
            && povRadarFx.frustum && povRadarFx.frustum.IsValid()
            && currentSoundRingsValid) {
            if (!Array.isArray(povRadarFx.soundSlotKeys)
                || povRadarFx.soundSlotKeys.length !== MAX_POV_SOUND_RINGS) {
                povRadarFx.soundSlotKeys = povRadarFx.soundRings.map(function () { return ""; });
            }
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

        function makeSoundRing(id) {
            const ring = $.CreatePanel("Panel", anchor, id);
            ring.hittest = false;
            ring.AddClass("PlayerSound");
            ring.AddClass("hud-colorize-wash");
            ring.style.borderRadius = "50% / 50%";
            ring.style.horizontalAlign = "left";
            ring.style.verticalAlign = "top";
            ring.style.overflow = "noclip";
            ring.style.zIndex = "81";
            ring.visible = false;
            return ring;
        }

        const soundRings = [];
        for (let soundIndex = 0; soundIndex < MAX_POV_SOUND_RINGS; soundIndex += 1) {
            soundRings.push(makeSoundRing("CS2InsightPovSoundRing" + (soundIndex || "")));
        }
        povRadarFx = {
            anchor: anchor,
            rotated: rotated,
            frustum: frustum,
            soundRings: soundRings,
            soundSlotKeys: soundRings.map(function () { return ""; }),
            // Retain aliases used by older injected-template diagnostics.
            soundRing: soundRings[0],
            soundRing2: soundRings[1],
        };
        return povRadarFx;
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

    function restoreNativeRadarForAdvancedSpectator() {
        if (advancedNativeRadarRestored) {
            return;
        }
        const nativeRadar = findNativeRadar();
        if (!nativeRadar || !nativeRadar.IsValid()) {
            return;
        }
        if (nativeRadar.FindChildrenWithClassTraverse) {
            const packs = nativeRadar.FindChildrenWithClassTraverse("PlayerIcons") || [];
            packs.forEach(function (panel) {
                if (panel && panel.IsValid() && String(panel.id || "").indexOf("CS2Insight") !== 0) {
                    panel.visible = true;
                }
            });
        }
        ["RI_BombDefuserPackage", "RI_DefuserPackage"].forEach(function (id) {
            const panel = nativeRadar.FindChildTraverse(id);
            if (panel && panel.IsValid()) {
                // Restore the stock package host. Its individual children are
                // stateful and must not all be forced visible together.
                panel.visible = true;
                try {
                    panel.style.opacity = null;
                    panel.style.visibility = null;
                } catch (errStyle) {}
            }
        });
        [
            "DroppedBomb",
            "DefuserIconDropped",
            "DefuserIconPackage",
            "CreateBombPack",
        ].forEach(function (id) {
            const panel = nativeRadar.FindChildTraverse(id);
            if (panel && panel.IsValid()) {
                // POV mode collapsed these children. Clear those inline styles,
                // keep the first restored frame hidden, and let CHudRadar show
                // only the child matching the current bomb/defuser state. This
                // prevents the giant blue defuser glyph seen after hot-switch.
                panel.visible = false;
                try {
                    panel.style.opacity = null;
                    panel.style.visibility = null;
                } catch (errStyle) {}
            }
        });
        setNativeSoundRingsVisible(nativeRadar, true);
        advancedNativeRadarRestored = true;
    }

    function updateRadarHud() {
        if (!radarTrack) {
            return;
        }
        const spectatorAllPlayers = Boolean(
            advancedPlayback && !advancedPovVisualsEnabled,
        );
        if (advancedPlayback && !advancedQuickOptions.radar) {
            if (radarHud && radarHud.IsValid()) {
                radarHud.visible = false;
            }
            if (radarUnclipHud && radarUnclipHud.IsValid()) {
                radarUnclipHud.visible = false;
            }
            restoreNativeRadarForAdvancedSpectator();
            $.Schedule(0.1, updateRadarHud);
            return;
        }
        if (spectatorAllPlayers) {
            // DEMO HUD must use CS2's own spectator radar: it already supplies
            // CT/T colors and the native 1-5 numbers when the demo profile
            // applies the square, non-rotating observer radar convars.
            if (radarHud && radarHud.IsValid()) {
                radarHud.visible = false;
            }
            if (radarUnclipHud && radarUnclipHud.IsValid()) {
                radarUnclipHud.visible = false;
            }
            restoreNativeRadarForAdvancedSpectator();
            $.Schedule(0.1, updateRadarHud);
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
        if (radarUnclipHud && radarUnclipHud.IsValid()) {
            radarUnclipHud.visible = true;
        }

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
                // Draw the POV cone in #Radar's unclipped sibling layer below.
                player.frustum.visible = false;
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
                updatePovUnclipFx(nativeRadar, tick, povXuid, povSample, povTeam);
                updatePovSoundRings(nativeRadar, tick, povXuid, povSample);
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
            const sounds = findActivePovSounds(tick, povXuid, true);
            for (let i = 0; i < sounds.length; i += 1) {
                if (sounds[i].combatOnly) {
                    firing = true;
                    break;
                }
                // Backward compatibility for payloads built before the
                // combatOnly flag: their synthetic gun rows started at 1400u.
                // Knife Slash/Hit layers are 800/1000u and stay excluded.
                if (!sounds[i].step && sounds[i].radius >= 1400) {
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

    function findActivePovSounds(tick, povXuid, includeCombatOnly) {
        // Native CHudRadar owns ten event slots. Radius is geometry, not event
        // identity for transient sounds. Repeated step events are one continuous
        // state and must reuse one ring instead of stacking additive pulses.
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
        const activeSteps = {};
        for (let index = lo; index < sounds.length; index += 1) {
            const sound = sounds[index];
            if (sound.tick > tick) {
                break;
            }
            if (String(sound.xuid) !== String(povXuid)) {
                continue;
            }
            if (sound.combatOnly && !includeCombatOnly) {
                continue;
            }
            const endTick = sound.stepStateEndTick !== undefined
                ? Number(sound.stepStateEndTick)
                : sound.tick + Math.max(1, Math.round((sound.durationMs / 1000) * tickRate));
            if (tick > endTick) {
                continue;
            }
            if (sound.step) {
                const stepKey = String(sound.stepStateId || (
                    "step:" + String(sound.xuid) + ":" + String(sound.radius)
                ));
                const previous = activeSteps[stepKey];
                if (!previous || sound.tick > previous.tick) {
                    activeSteps[stepKey] = sound;
                }
            } else {
                active.push(sound);
            }
        }
        Object.keys(activeSteps).forEach(function (key) {
            active.push(activeSteps[key]);
        });
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
        return active.slice(0, MAX_POV_SOUND_RINGS);
    }

    function setNativeSoundRingsVisible(nativeRadar, visible) {
        if (!nativeRadar || !nativeRadar.IsValid()) {
            return;
        }
        const soundRoot = nativeRadar.FindChildTraverse("RI_PlayerSoundContainer");
        if (soundRoot && soundRoot.IsValid()) {
            soundRoot.visible = Boolean(visible);
        }
    }

    function hideInsightSoundRings() {
        if (!povRadarFx || !Array.isArray(povRadarFx.soundRings)) {
            return;
        }
        povRadarFx.soundRings.forEach(function (ring) {
            if (ring && ring.IsValid()) {
                ring.visible = false;
                ring._insightSoundKey = "";
                ring.RemoveClass("player-sound-max");
            }
        });
        povRadarFx.soundSlotKeys = povRadarFx.soundRings.map(function () { return ""; });
    }

    function povSoundKey(sound) {
        if (!sound) {
            return "";
        }
        if (sound.step) {
            return String(sound.stepStateId || [
                "step",
                sound.xuid,
                sound.radius,
            ].join(":"));
        }
        return String(sound.id || [
            sound.tick,
            sound.xuid,
            sound.radius,
            sound.durationMs,
        ].join(":"));
    }

    function assignPovSoundsToSlots(fx, active) {
        const assignments = new Array(fx.soundRings.length);
        const used = new Array(active.length);
        const previousKeys = Array.isArray(fx.soundSlotKeys) ? fx.soundSlotKeys : [];

        // Keep every still-active event on its prior panel so a newly arriving
        // event can retrigger even when it has exactly the same radius.
        for (let slot = 0; slot < assignments.length; slot += 1) {
            const previousKey = String(previousKeys[slot] || "");
            if (!previousKey) {
                continue;
            }
            for (let soundIndex = 0; soundIndex < active.length; soundIndex += 1) {
                if (!used[soundIndex] && povSoundKey(active[soundIndex]) === previousKey) {
                    assignments[slot] = active[soundIndex];
                    used[soundIndex] = true;
                    break;
                }
            }
        }
        for (let soundIndex = 0; soundIndex < active.length; soundIndex += 1) {
            if (used[soundIndex]) {
                continue;
            }
            for (let slot = 0; slot < assignments.length; slot += 1) {
                if (!assignments[slot]) {
                    assignments[slot] = active[soundIndex];
                    used[soundIndex] = true;
                    break;
                }
            }
        }
        fx.soundSlotKeys = assignments.map(povSoundKey);
        return assignments;
    }

    function nativeRadarCenteredScale() {
        // Insight starts POV playback with cl_radar_scale 0.4. Keep custom
        // geometry on that same invariant instead of following later console/UI
        // changes that only mutate the stock map transform.
        return POV_RADAR_SCALE;
    }

    function nativeRadarIconScale(centeredScale) {
        // CHudRadar applies this scale to the complete PlayerIcons package after
        // sizing PlayerSound/ViewFrustrum. This is the exact client expression:
        // min + clamp(radarScale, 0, 1) * (1.25 - min).
        let minimum = 0.6;
        try {
            if (GameInterfaceAPI.GetSettingFloat) {
                const configured = Number(GameInterfaceAPI.GetSettingFloat("cl_radar_icon_scale_min"));
                if (isFinite(configured) && configured >= 0) {
                    minimum = configured;
                }
            } else if (GameInterfaceAPI.GetSettingString) {
                const configuredString = Number(GameInterfaceAPI.GetSettingString("cl_radar_icon_scale_min"));
                if (isFinite(configuredString) && configuredString >= 0) {
                    minimum = configuredString;
                }
            }
        } catch (errSetting) {}
        const radarScale = Math.max(0, Math.min(1, Number(centeredScale) || 0));
        return minimum + radarScale * (1.25 - minimum);
    }

    function paintPovSoundRingOnAnchor(ring, anchor, diamPx, sound, maxed, tick, tickRate) {
        if (!ring || !ring.IsValid()) {
            return;
        }
        if (!anchor || !anchor.IsValid() || !sound || !(diamPx > 0)) {
            ring.visible = false;
            ring._insightSoundKey = "";
            return;
        }
        try {
            if (ring.GetParent() !== anchor) {
                ring.SetParent(anchor);
            }
        } catch (err) {
            ring.visible = false;
            return;
        }
        const half = diamPx / 2;
        const soundKey = povSoundKey(sound);
        const retriggered = ring._insightSoundKey !== soundKey;
        ring._insightSoundKey = soundKey;
        ring.visible = true;
        ring.style.width = diamPx + "px";
        ring.style.height = diamPx + "px";
        // The anchor is the shared center of #Radar and the forced
        // cl_radar_always_centered POV marker, outside Round--Inner's clip.
        ring.style.position = "0px 0px 0px";
        ring.style.marginLeft = (-half) + "px";
        ring.style.marginTop = (-half) + "px";
        const durationTicks = Math.max(1, Math.round((sound.durationMs / 1000) * tickRate));
        const progress = Math.max(0, Math.min(1, (tick - sound.tick) / durationTicks));
        // Stock .PlayerSound has no opacity animation. The step flag denotes a
        // steady state; only transient knife/reload/jump pulses use our fade.
        ring.style.opacity = sound.step
            ? "1"
            : String(Math.max(0.45, 1 - progress * 0.55));
        // Keep the stock thin stroke for every radius. Compact 98u pulses gain
        // visibility from the layout minimum, not from a heavier/brighter rim.
        ring.style.border = "1px solid #ffffff40";
        ring.style.brightness = retriggered ? "1.2" : "1";
        let hasMaxClass = false;
        try {
            hasMaxClass = Boolean(ring.BHasClass && ring.BHasClass("player-sound-max"));
        } catch (errClass) {}
        if (maxed && !hasMaxClass) {
            ring.AddClass("player-sound-max");
        } else if (!maxed && hasMaxClass) {
            ring.RemoveClass("player-sound-max");
        }
    }

    function updatePovSoundRings(nativeRadar, tick, povXuid, povSample) {
        // nativeSoundComplete describes the event source, not Panorama playback.
        // Some GOTV demos retain a perfect player_sound table but CS2 does not
        // instantiate visible RI_PlayerSoundContainer children while spectating the
        // recording. Replay the exact native radius/duration rows through panels
        // carrying CS2's PlayerSound classes; stripped demos use synthesized rows.
        // Suppress the stock root to avoid doubled rings on builds that do replay it.
        setNativeSoundRingsVisible(nativeRadar, false);
        unclipRadarForSoundRings(nativeRadar);
        const fx = ensurePovRadarFx(nativeRadar);
        if (!fx || !povSample || !povSample.alive || !povXuid) {
            hideInsightSoundRings();
            return;
        }
        fx.anchor.visible = true;
        fx.anchor.style.position = "50% 50% 0px";
        const active = findActivePovSounds(tick, povXuid, false);
        const assigned = assignPovSoundsToSlots(fx, active);
        const radarFrame = nativeRadar.FindChildTraverse("Radar") || nativeRadar;
        const frameWidth = radarFrame && radarFrame.IsValid()
            ? (radarFrame.actuallayoutwidth || 0)
            : 0;
        const frameHeight = radarFrame && radarFrame.IsValid()
            ? (radarFrame.actuallayoutheight || frameWidth)
            : frameWidth;
        const maxClassThreshold = Math.max(0, Math.min(frameWidth, frameHeight) * 0.5 * 0.98);
        const centeredScale = nativeRadarCenteredScale();
        const iconScale = nativeRadarIconScale(centeredScale);
        function ringLayout(sound) {
            if (!sound) {
                return { diameter: 0, maxed: false };
            }
            // Native first rounds the unscaled PlayerSound panel radius to an
            // integer, then scales the whole PlayerIcons package.
            const panelRadius = Math.floor(
                (Math.max(0, Number(sound.radius) || 0) / radarTrack.transform.scale)
                    * centeredScale,
            );
            // The authored 98u jump/reload pulse is smaller than the POV icon
            // on high-scale overviews (about 7px rendered radius on dust2).
            // Preserve its small-circle identity, but expose enough rim beyond
            // the 11px marker for the event to remain visible.
            const visualPanelRadius = Number(sound.radius) <= 120
                ? Math.max(12, panelRadius)
                : panelRadius;
            return {
                diameter: 2 * Math.max(0, visualPanelRadius) * iconScale,
                // Native CHudRadar sets player-sound-max when the ring radius
                // reaches the current radar boundary (98% tolerance).
                maxed: maxClassThreshold > 0 && panelRadius >= maxClassThreshold,
            };
        }
        for (let soundIndex = 0; soundIndex < fx.soundRings.length; soundIndex += 1) {
            const sound = assigned[soundIndex] || null;
            const layout = ringLayout(sound);
            paintPovSoundRingOnAnchor(
                fx.soundRings[soundIndex],
                fx.anchor,
                layout.diameter,
                sound,
                layout.maxed,
                tick,
                Math.max(1, Number(radarTrack.stride) * 8),
            );
        }
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
        hideInsightSoundRings();
    }

    function updatePovUnclipFx(nativeRadar, tick, povXuid, povSample, povTeam) {
        // This helper owns the custom POV viewing frustum. It shares the
        // unclipped #Radar-center anchor with sound circles.
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

        const cssYaw = yawToCssRotation(povSample.yaw);
        fx.anchor.visible = true;
        fx.anchor.style.position = "50% 50% 0px";
        if (fx.rotated && fx.rotated.IsValid()) {
            // With a rotating, always-centered radar the POV always points up.
            // If the user disabled radar rotation, retain the world-yaw cone.
            let radarRotates = true;
            try {
                if (GameInterfaceAPI.GetSettingString) {
                    const setting = String(GameInterfaceAPI.GetSettingString("cl_radar_rotate") || "1").toLowerCase();
                    radarRotates = setting !== "0" && setting !== "false";
                }
            } catch (errSetting) {}
            const iconScale = nativeRadarIconScale(nativeRadarCenteredScale());
            // Native scales the complete PlayerIcons package around the player
            // origin. Resizing ViewFrustrum itself moves the SVG tip off-center.
            fx.rotated.style.transform = "rotateZ(" + (radarRotates ? 0 : cssYaw)
                + "deg) scale3d(" + iconScale + ", " + iconScale + ", 1)";
            fx.rotated.visible = true;
        }
        if (fx.frustum && fx.frustum.IsValid()) {
            fx.frustum.visible = true;
            fx.frustum.style.width = "128px";
            fx.frustum.style.height = "64px";
            fx.frustum.style.y = "-12px";
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

    function radioTeamColor(team) {
        // client.dll ChatColor(3): team-colored names in chat/radio notices.
        if (team === 3) {
            return "#a2c6ff";
        }
        return team === 2 ? "#ffdf93" : "#ffffff";
    }

    function voiceTeamColor(team) {
        // CCSGO_HudVoiceStatus uses a slightly stronger team color whenever a
        // competitive teammate marker is available.
        if (team === 3) {
            return "#729bdd";
        }
        return team === 2 ? "#e0b756" : "#ffffff";
    }

    function radioPlayerColor(xuid) {
        const slot = povColorSlot(xuid);
        if (slot >= 0 && slot < PLAYER_COLOR_HEX.length) {
            return PLAYER_COLOR_HEX[slot];
        }
        return "";
    }

    function localizedRadioMessage(kind) {
        const tokens = [
            "#SFUI_TitlesTXT_Smoke_in_the_hole",
            "#SFUI_TitlesTXT_Flashbang_in_the_hole",
            "#SFUI_TitlesTXT_Fire_in_the_hole",
            "#SFUI_TitlesTXT_Molotov_in_the_hole",
            "#SFUI_TitlesTXT_Incendiary_in_the_hole",
            "#SFUI_TitlesTXT_Decoy_in_the_hole",
            "#Cstrike_TitlesTXT_Planting_Bomb",
            "#Cstrike_TitlesTXT_Defusing_Bomb",
        ];
        const fallback = [
            "Smoke!",
            "Flashbang!",
            "HE Grenade!",
            "Molotov!",
            "Incendiary!",
            "Decoy!",
            "Planting!",
            "Defusing!",
        ];
        const index = Math.max(0, Math.min(tokens.length - 1, Number(kind) || 0));
        let message = "";
        try { message = String($.Localize(tokens[index]) || ""); } catch (errLocalize) {}
        // Stock radio strings carry one leading legacy control-color byte. The
        // custom HTML Label applies the same palette through font spans.
        message = message.replace(/[\x00-\x1f]/g, "").trim();
        if (!message || message === tokens[index]) {
            message = fallback[index];
        }
        return message;
    }

    function radioMessageColor(kind) {
        // csgo_english.txt prefixes the corresponding tokens with Source chat
        // colors: 05 olive, 0B blue, 0F light-red, 10 gold, and 08 grey.
        const colors = [
            "#9abf45",
            "#5fa8e6",
            "#ef6a6a",
            "#efae42",
            "#efae42",
            "#b9c0c5",
            "#efae42",
            "#efae42",
        ];
        const index = Math.max(0, Math.min(colors.length - 1, Number(kind) || 0));
        return colors[index];
    }

    function escapeRadioHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function radioHtmlSpan(color, value) {
        return "<font color='" + color + "'>" + escapeRadioHtml(value) + "</font>";
    }

    function teammateMarkerHtml(xuid) {
        const color = radioPlayerColor(xuid);
        // client.dll localizes #CSGO_Competitive_Dot to U+25CF. U+2022 is a
        // materially smaller Stratum glyph and caused the Insight mismatch.
        return color ? radioHtmlSpan(color, "● ") : "";
    }

    function lowerLeftPlayerName(event) {
        let name = "";
        if (event && event.xuid) {
            try { name = String(GameStateAPI.GetPlayerName(event.xuid) || ""); } catch (errName) {}
        }
        return name || String(event && event.name || "") || "Player";
    }

    function radioEventHtml(event) {
        const team = event.team;
        const name = lowerLeftPlayerName(event);

        let location = "";
        if (event.location) {
            try { location = String($.Localize("#" + event.location) || ""); } catch (errLoc) {}
            if (!location || location === "#" + event.location) {
                location = event.location;
            }
        }

        // Mirrors current Game_radio_location:
        // " %s4\x03%s1\x04﹫%s2\x01: %s3". Keep the compact native ﹫ glyph
        // and one HTML Label line so font metrics do not drift between segments.
        let line = " ";
        line += radioHtmlSpan(radioTeamColor(team), team === 3 ? "[CT] " : "[T] ");
        line += teammateMarkerHtml(event.xuid);
        line += radioHtmlSpan(radioTeamColor(team), name);
        if (location) {
            line += radioHtmlSpan("#40ff40", "﹫" + location);
        }
        line += radioHtmlSpan("#edf3f6", ": ");
        line += radioHtmlSpan(radioMessageColor(event.kind), localizedRadioMessage(event.kind));
        return line;
    }

    function chatEventHtml(event) {
        const team = Number(event.team) || 0;
        const prefix = event.teamOnly
            ? (team === 3 ? "[CT] " : "[T] ")
            : "[ALL] ";
        let line = radioHtmlSpan("#edf3f6", prefix);
        line += teammateMarkerHtml(event.xuid);
        line += radioHtmlSpan(radioTeamColor(team), lowerLeftPlayerName(event));
        line += radioHtmlSpan("#edf3f6", " : " + String(event.message || ""));
        return line;
    }

    function teammateNoticeText(event) {
        const name = lowerLeftPlayerName(event);
        let language = "";
        try { language = String($.Language() || "").toLowerCase(); } catch (errLanguage) {}
        const chinese = language.indexOf("schinese") >= 0
            || language.indexOf("tchinese") >= 0
            || language.indexOf("chinese") >= 0;
        if (Number(event.messageKind) === 1) {
            return chinese ? name + " 攻击了一名队友" : name + " attacked a teammate";
        }
        if (Number(event.messageKind) === 2) {
            return chinese ? name + " 击杀了一名队友" : name + " killed a teammate";
        }
        const message = String(event.message || "");
        if (message.charAt(0) === "#") {
            try {
                const localized = String($.Localize(message) || "");
                if (localized && localized !== message) {
                    return localized;
                }
            } catch (errLocalize) {}
        }
        return message;
    }

    function serverEventHtml(event) {
        return radioHtmlSpan("#ef5252", teammateNoticeText(event));
    }

    function cashAwardEventHtml(event) {
        let message = "";
        const token = "#Player_Cash_Award_Killed_Enemy_Generic";
        try { message = String($.Localize(token) || ""); } catch (errLocalize) {}
        if (!message || message === token) {
            message = " Award for neutralizing an enemy: \x06+$%s1\x01";
        }
        message = message.replace(/%s1/g, String(Math.max(0, Number(event.reward) || 0)));

        let color = "#edf3f6";
        let segment = "";
        const spans = [];
        function flushSegment() {
            if (segment) {
                spans.push(radioHtmlSpan(color, segment));
                segment = "";
            }
        }
        for (let index = 0; index < message.length; index += 1) {
            const code = message.charCodeAt(index);
            if (code > 0 && code < 0x20) {
                flushSegment();
                color = code === 0x06 ? "#8df05d" : "#edf3f6";
            } else {
                segment += message.charAt(index);
            }
        }
        flushSegment();
        return spans.join("");
    }

    function lowerLeftEventHtml(event) {
        if (!event) {
            return "";
        }
        if (event.type === "cash") {
            return cashAwardEventHtml(event);
        }
        if (event.type === "chat") {
            return chatEventHtml(event);
        }
        if (event.type === "server") {
            return serverEventHtml(event);
        }
        return radioEventHtml(event);
    }

    function nativeVoiceAlertPanel(index) {
        const cached = nativeVoiceAlertPanels[index] || null;
        if (cached && cached.IsValid()) {
            return cached;
        }
        const resolved = findHudTraverse("AlertPanel" + (index + 1));
        nativeVoiceAlertPanels[index] = resolved && resolved.IsValid()
            ? resolved
            : null;
        return nativeVoiceAlertPanels[index];
    }

    function suppressNativeLowerLeft() {
        if (!advancedPovVisualsActive()) {
            // Undo Insight's inline overrides once, then leave the native
            // alert/chat panels entirely to CS2. Reapplying opacity/visible on
            // every refresh kept expired Console lines alive indefinitely.
            if (!advancedNativeMessagesRestored) {
                for (let restoreIndex = 0; restoreIndex < NATIVE_VOICE_ALERT_PANEL_COUNT; restoreIndex += 1) {
                    const restorePanel = nativeVoiceAlertPanel(restoreIndex);
                    if (restorePanel && restorePanel.IsValid()) {
                        try { restorePanel.style.opacity = null; } catch (errRestoreOpacity) {}
                        try { restorePanel.style.visibility = null; } catch (errRestoreVisibility) {}
                    }
                }
                if (!nativeChatHistoryText || !nativeChatHistoryText.IsValid()) {
                    nativeChatHistoryText = findHudTraverse("ChatHistoryText");
                }
                if (nativeChatHistoryText && nativeChatHistoryText.IsValid()) {
                    try { nativeChatHistoryText.style.opacity = null; } catch (errChatOpacity) {}
                    try { nativeChatHistoryText.style.visibility = null; } catch (errChatVisibility) {}
                    nativeChatHistoryText.visible = true;
                }
                advancedNativeMessagesRestored = true;
            }
            $.Schedule(RADIO_IDLE_REFRESH_SECONDS, suppressNativeLowerLeft);
            return;
        }
        advancedNativeMessagesRestored = false;
        for (let index = 0; index < NATIVE_VOICE_ALERT_PANEL_COUNT; index += 1) {
            const panel = nativeVoiceAlertPanel(index);
            if (!panel || !panel.IsValid()) {
                continue;
            }
            // Do not change stock animation classes or layout. Opacity is
            // reapplied because the engine recycles this fixed panel pool.
            panel.style.opacity = "0";
            panel.hittest = false;
        }
        if (!nativeChatHistoryText || !nativeChatHistoryText.IsValid()) {
            nativeChatHistoryText = findHudTraverse("ChatHistoryText");
        }
        if (nativeChatHistoryText && nativeChatHistoryText.IsValid()) {
            nativeChatHistoryText.style.opacity = "0";
            nativeChatHistoryText.hittest = false;
            nativeChatHistoryText.visible = false;
        }
        $.Schedule(RADIO_IDLE_REFRESH_SECONDS, suppressNativeLowerLeft);
    }

    function ensureRadioHud() {
        const root = hudRootPanel();
        if (!root) {
            return null;
        }
        // ChatHistory's ancestors collapse whenever the engine has no live
        // message, so the reconstructed radio needs an independent host. Match
        // current HudVoiceStatus's 560px alert slot. This independent host is
        // already inside the HUD safe-zone transform, so only AlertText's 8px
        // left padding is needed; reapplying ChatContainer/ChatFG left insets
        // produced the visibly shifted ~50px Insight baseline. It does not,
        // however, inherit HudVoiceStatus's vertical layout origin, so use the
        // fixed stock message lane rather than reacting to active voice rows.
        if (radioHud && radioHud.IsValid() && radioHud.GetParent() === root) {
            radioHud.style.marginBottom = RADIO_PANEL_Y_OFFSET + "px";
            return radioHud;
        }
        if (radioHud && radioHud.IsValid()) {
            try { radioHud.DeleteAsync(0.0); } catch (errDelete) {}
        }
        const hud = $.CreatePanel("Panel", root, "CS2InsightRadioHud");
        hud.hittest = false;
        hud.style.width = "560px";
        hud.style.height = "300px";
        hud.style.horizontalAlign = "left";
        hud.style.verticalAlign = "bottom";
        hud.style.marginLeft = "0px";
        hud.style.marginBottom = RADIO_PANEL_Y_OFFSET + "px";
        hud.style.zIndex = "25000";
        hud.style.overflow = "noclip";

        const history = $.CreatePanel("Panel", hud, "CS2InsightRadioHistoryText");
        history.hittest = false;
        history.style.width = "100%";
        // Stock #ChatHistoryText fills the 327px history slot but vertically
        // aligns its contents to the bottom. Keep a full-height anchor, then
        // bottom-align a fit-children row stack inside it. Flowing rows directly
        // in this full-height panel starts them at the top and is visibly too
        // high at 16:9.
        history.style.height = "100%";
        history.style.verticalAlign = "bottom";
        history.style.overflow = "noclip";

        const rowStack = $.CreatePanel("Panel", history, "CS2InsightRadioRows");
        rowStack.hittest = false;
        rowStack.style.width = "100%";
        rowStack.style.height = "fit-children";
        rowStack.style.verticalAlign = "bottom";
        rowStack.style.paddingLeft = "8px";
        rowStack.style.paddingRight = "0px";
        rowStack.style.paddingTop = "0px";
        rowStack.style.paddingBottom = "0px";
        rowStack.style.flowChildren = "down";
        rowStack.style.overflow = "noclip";

        radioHistoryRows = [];
        for (let rowIndex = 0; rowIndex < MAX_VISIBLE_RADIO_MESSAGES; rowIndex += 1) {
            const row = $.CreatePanel(
                "Label",
                rowStack,
                "CS2InsightRadioHistoryRow" + rowIndex,
            );
            row.hittest = false;
            row.html = true;
            row.style.width = "100%";
            row.style.height = "fit-children";
            row.style.fontFamily = "Stratum2, 'Arial Unicode MS'";
            row.style.fontSize = "18px";
            row.style.fontWeight = "medium";
            row.style.letterSpacing = "0px";
            row.style.textShadow = "0px 0px 1px 1.0 #0000003a";
            row.style.whiteSpace = "nowrap";
            row.style.overflow = "noclip";
            row.style.opacity = "0";
            row.style.transitionProperty = "transform";
            row.style.transitionDuration = "0.1s";
            row.style.transitionTimingFunction = "linear";
            row.visible = false;
            radioHistoryRows.push(row);
        }
        radioHistoryPanel = rowStack;
        radioHud = hud;
        return hud;
    }

    function hideRadioHud() {
        radioHistoryRows.forEach(function (row) {
            if (row && row.IsValid()) {
                row.text = "";
                row.style.opacity = "0";
                row.style.transform = "none";
                row.visible = false;
            }
        });
        if (radioHud && radioHud.IsValid()) {
            radioHud.visible = false;
        }
    }

    function radioEventOpacity(event, tick) {
        const lifetimeTicks = Math.max(
            1,
            RADIO_MESSAGE_SECONDS * Math.max(1, Number(event.tickRate) || 64),
        );
        const progress = Math.max(
            0,
            Math.min(1, (tick - event.tick) / lifetimeTicks),
        );
        if (progress < RADIO_FADE_IN_END) {
            return progress / RADIO_FADE_IN_END;
        }
        if (progress < RADIO_FADE_OUT_START) {
            return 1;
        }
        if (progress < RADIO_FADE_OUT_END) {
            return 1 - (
                (progress - RADIO_FADE_OUT_START)
                / (RADIO_FADE_OUT_END - RADIO_FADE_OUT_START)
            );
        }
        return 0;
    }

    function paintRadioHistory(events, tick) {
        if (!radioHistoryPanel || !radioHistoryPanel.IsValid()) {
            return;
        }
        for (let rowIndex = 0; rowIndex < radioHistoryRows.length; rowIndex += 1) {
            const row = radioHistoryRows[rowIndex];
            if (!row || !row.IsValid()) {
                continue;
            }
            const event = events[rowIndex] || null;
            row.text = event ? lowerLeftEventHtml(event) : "";
            row.style.opacity = event
                ? String(radioEventOpacity(event, tick))
                : "0";
            row.visible = Boolean(event);
        }
    }

    function updateRadioHud() {
        if (!radioTrack && !killFeedbackTrack) {
            return;
        }
        if (!advancedPovVisualsActive()) {
            hideRadioHud();
            $.Schedule(RADIO_IDLE_REFRESH_SECONDS, updateRadioHud);
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state || !isFinite(Number(state.nTick))) {
            hideRadioHud();
            $.Schedule(RADIO_IDLE_REFRESH_SECONDS, updateRadioHud);
            return;
        }
        const tick = Number(state.nTick);
        const jumped = radioLastTick >= 0
            && (tick + 2 < radioLastTick
                || tick - radioLastTick > TRANSIENT_HUD_TICK_JUMP_THRESHOLD);
        if (radioEpochTick < 0) {
            radioEpochTick = 0;
        }
        if (jumped || state.bIsPaused) {
            radioEpochTick = tick;
        }
        radioLastTick = tick;

        const hud = ensureRadioHud();
        if (!hud || state.bIsPaused || tick <= transientHudSuppressUntilTick) {
            hideRadioHud();
            $.Schedule(RADIO_IDLE_REFRESH_SECONDS, updateRadioHud);
            return;
        }
        const povXuid = currentPovXuid(state);
        let visible = [];
        if (radioTrack) {
            const povTeam = resolvePovTeam(povXuid, tick);
            const radioLifetimeTicks = Math.max(
                1,
                Math.round(RADIO_MESSAGE_SECONDS * radioTrack.tickRate),
            );
            visible = visible.concat(radioTrack.events.filter(function (event) {
                if (event.tick < radioEpochTick
                        || event.tick > tick
                        || event.tick + radioLifetimeTicks <= tick) {
                    return false;
                }
                return povTeam !== 0 && event.team === povTeam;
            }));
            visible = visible.concat(radioTrack.messages.filter(function (event) {
                if (event.tick < radioEpochTick
                        || event.tick > tick
                        || event.tick + radioLifetimeTicks <= tick) {
                    return false;
                }
                return event.type !== "chat"
                    || !event.teamOnly
                    || (povTeam !== 0 && event.team === povTeam);
            }));
        }
        if (killFeedbackTrack && povXuid) {
            const cashLifetimeTicks = Math.max(
                1,
                Math.round(RADIO_MESSAGE_SECONDS * killFeedbackTrack.tickRate),
            );
            visible = visible.concat(killFeedbackEvents.filter(function (event) {
                return event.reward > 0
                    && event.attackerXuid === povXuid
                    && event.tick >= radioEpochTick
                    && event.tick <= tick
                    && event.tick + cashLifetimeTicks > tick;
            }));
        }
        // Stable sort retains demo arrival order for events sharing one tick.
        visible.sort(function (left, right) { return left.tick - right.tick; });
        visible = visible.slice(-MAX_VISIBLE_RADIO_MESSAGES);

        hud.visible = Boolean(visible.length);
        paintRadioHistory(visible, tick);
        $.Schedule(
            visible.length ? RADIO_ACTIVE_REFRESH_SECONDS : RADIO_IDLE_REFRESH_SECONDS,
            updateRadioHud,
        );
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
        const marker = createClassedPanel("Label", notice, "VoiceMarker", "VoiceText");
        marker.style.width = "fit-children";
        marker.style.marginLeft = "4px";
        const label = createClassedPanel("Label", notice, "VoiceText", "VoiceText");
        label.style.width = "fit-children";
        label.style.marginLeft = "0px";
        const locationLabel = createClassedPanel("Label", notice, "VoiceLocation", "VoiceText");
        locationLabel.style.width = "fit-children";
        locationLabel.style.marginLeft = "0px";
        locationLabel.style.color = "#40ff40";

        const xuid = speaker.xuid || GameStateAPI.GetPlayerXuidStringFromPlayerSlot(speaker.slot);
        if (xuid) {
            avatar.PopulateFromSteamID(xuid);
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
        GameInterfaceAPI.ConsoleCommand("snd_sos_start_soundevent " + KILL_CONFIRMATION_EVENT);
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
        if (!advancedPovVisualsActive()) {
            killFeedbackLastTick = Number(state.nTick || 0);
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
        if (!advancedPovVisualsActive()) {
            speakers.forEach(function (speaker) {
                if (speaker.panel && speaker.panel.IsValid()) {
                    speaker.panel.AddClass("Hidden");
                }
            });
            $.Schedule(0.1, update);
            return;
        }

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
            const audible = Boolean(speakerPlayer)
                && advancedVoiceAllows(speaker.xuid, povTeam, state.nTick);
            if (audible
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
            // Reveal the structural voice notice before painting its labels so
            // the speaker icon/avatar cannot disappear while the row still
            // reserves space above reconstructed messages.
            notice.SetHasClass("Hidden", !active);
            if (active) {
                pinVoiceNotices(voicePanel, activeRowCount, notice, row);
                const xuid = speaker.xuid || GameStateAPI.GetPlayerXuidStringFromPlayerSlot(speaker.slot);
                const name = xuid ? GameStateAPI.GetPlayerName(xuid) : "";
                const locationToken = locationAt(speaker.locations, state.nTick);
                const localizedLocation = locationToken ? $.Localize("#" + locationToken) : "";
                const speakerTeam = resolvePovTeam(speaker.xuid, state.nTick)
                    || (speakerPlayer ? speakerPlayer.team : 0);
                const markerColor = radioPlayerColor(xuid);
                const marker = notice.FindChildTraverse("VoiceMarker");
                const voiceText = notice.FindChildTraverse("VoiceText");
                const voiceLocation = notice.FindChildTraverse("VoiceLocation");
                marker.text = markerColor ? "● " : "";
                marker.style.color = markerColor || "#ffffff";
                voiceText.text = name || ("Player " + (speaker.slot + 1));
                voiceText.style.color = markerColor
                    ? voiceTeamColor(speakerTeam)
                    : radioTeamColor(speakerTeam);
                voiceLocation.text = localizedLocation ? " @ " + localizedLocation : "";
            }
        });
        $.Schedule(0.05, update);
    }

    function advancedChinese() {
        let language = "";
        try { language = String($.Language() || "").toLowerCase(); } catch (errLanguage) {}
        return language.indexOf("schinese") >= 0
            || language.indexOf("tchinese") >= 0
            || language.indexOf("chinese") >= 0;
    }

    function advancedCopy(zh, en) {
        return advancedChinese() ? zh : en;
    }

    function advancedCreatePanel(type, parent, id) {
        const panel = $.CreatePanel(type, parent, id || "");
        panel.hittest = true;
        panel.hittestchildren = true;
        if (type === "Panel") {
            // Empty Panorama panels otherwise let MOUSE1 reach CS2's spectator
            // binding (next player). Every structural region consumes clicks.
            try { panel.SetPanelEvent("onactivate", function () { return true; }); } catch (errActivate) {}
            try { panel.SetPanelEvent("oncontextmenu", function () { return true; }); } catch (errContext) {}
        }
        return panel;
    }

    function advancedCreateLabel(parent, text, size, color) {
        const label = advancedCreatePanel("Label", parent, "");
        label.text = String(text || "");
        label.style.fontFamily = "Stratum2, 'Arial Unicode MS'";
        label.style.fontSize = String(size || 16) + "px";
        label.style.color = color || "#eeeeec";
        label.style.verticalAlign = "center";
        label.style.textOverflow = "ellipsis";
        label.hittest = false;
        label.hittestchildren = false;
        return label;
    }

    function advancedCreateButton(parent, text, onActivate, width) {
        const button = advancedCreatePanel("Button", parent, "");
        button.style.height = "30px";
        button.style.width = width || "fit-children";
        button.style.paddingLeft = "10px";
        button.style.paddingRight = "10px";
        button.style.marginRight = "5px";
        button.style.backgroundColor = "#222221f2";
        button.style.border = "1px solid #494844";
        button.style.borderRadius = "6px";
        const label = advancedCreateLabel(button, text, 12, "#eeeeec");
        label.hittest = false;
        label.style.horizontalAlign = "center";
        if (onActivate) {
            button.SetPanelEvent("onactivate", onActivate);
        }
        return button;
    }

    function advancedStyleButton(button, active, accent) {
        if (!button || !button.IsValid()) {
            return;
        }
        button.style.backgroundColor = active ? (accent || "#e07f0a") : "#222221f2";
        button.style.border = active ? "1px solid #f2a54a" : "1px solid #494844";
        button.style.brightness = active ? "1.08" : "1";
    }

    function advancedRefreshQuickOptionButtons() {
        Object.keys(advancedOptionButtons).forEach(function (key) {
            const enabled = Boolean(advancedQuickOptions[key]);
            advancedSetButtonText(
                advancedOptionButtons[key],
                advancedOptionLabels[key]
                    + advancedCopy(enabled ? "开" : "关", enabled ? " ON" : " OFF"),
            );
            advancedStyleButton(advancedOptionButtons[key], enabled);
        });
    }

    function advancedApplyQuickOptions() {
        const overheadMode = advancedQuickOptions.overhead
            ? 1
            : -1;
        const commands = [
            "spec_show_xray " + (advancedQuickOptions.xray ? 1 : 0),
            "cl_drawhud_force_radar " + (advancedQuickOptions.radar ? 0 : -1),
            "cl_drawhud_force_teamid_overhead " + overheadMode,
            // Messages are profile-owned: reconstructed in POV HUD, native in
            // DEMO HUD. Always leave CS2 chat enabled so the DEMO profile can
            // resume its own lifetime/animation without another user switch.
            "tv_nochat 0",
        ];
        for (let index = 0; index < commands.length; index += 1) {
            try { GameInterfaceAPI.ConsoleCommand(commands[index]); } catch (errCommand) {}
        }
        advancedRefreshQuickOptionButtons();
    }

    function advancedToggleQuickOption(key) {
        if (!Object.prototype.hasOwnProperty.call(advancedQuickOptions, key)) {
            return;
        }
        advancedQuickOptions[key] = !advancedQuickOptions[key];
        if (key === "overhead") {
            advancedNativeOverheadRestored = false;
        }
        advancedApplyQuickOptions();
    }

    function advancedClearPanel(panel) {
        if (!panel || !panel.IsValid()) {
            return;
        }
        try {
            panel.RemoveAndDeleteChildren();
        } catch (errRemove) {
            const count = panel.GetChildCount ? panel.GetChildCount() : 0;
            for (let index = count - 1; index >= 0; index -= 1) {
                try { panel.GetChild(index).DeleteAsync(0); } catch (errDelete) {}
            }
        }
    }

    function restoreAdvancedHealthPanels() {
        for (let index = advancedModifiedHealthPanels.length - 1; index >= 0; index -= 1) {
            const panel = advancedModifiedHealthPanels[index];
            if (!panel || !panel.IsValid()) {
                continue;
            }
            applyHaSlotClass(panel, -1);
            try { panel.style.backgroundColor = null; } catch (errBackground) {
                try { panel.style.backgroundColor = "#ffffffff"; } catch (errWhite) {}
            }
            try { panel.style.washColor = null; } catch (errWash) {
                try { panel.style.washColor = "none"; } catch (errNone) {}
            }
        }
        advancedModifiedHealthPanels.length = 0;
    }

    function advancedPlayerName(xuid) {
        const normalized = normalizeXuid(xuid);
        const packedPlayer = advancedPlayback && advancedPlayback.byXuid[normalized];
        let liveName = "";
        try { liveName = String(GameStateAPI.GetPlayerName(normalized) || "").trim(); } catch (errName) {}
        return liveName || (packedPlayer ? packedPlayer.name : "") || "Player";
    }

    function advancedFormatTick(tick) {
        const seconds = Math.max(0, Number(tick) || 0) / Math.max(1, advancedPlayback.tickRate);
        const minutes = Math.floor(seconds / 60);
        const remain = Math.floor(seconds % 60);
        return minutes + ":" + (remain < 10 ? "0" : "") + remain;
    }

    function advancedRefreshRoundIntervals(state) {
        if (advancedPlayback && advancedPlayback.rounds && advancedPlayback.rounds.length) {
            advancedRoundIntervals = advancedPlayback.rounds;
        }
        return advancedRoundIntervals;
    }

    function advancedRoundNumberAtTick(tick) {
        const value = Math.max(0, Number(tick) || 0);
        const rounds = advancedRoundIntervals;
        if (!rounds.length || value < rounds[0].start) {
            return 0;
        }
        for (let index = 1; index < rounds.length; index += 1) {
            if (value < rounds[index].start) {
                return index;
            }
        }
        return rounds.length;
    }

    function advancedUpdateRoundLabel(state) {
        const rounds = advancedRefreshRoundIntervals(state);
        const current = state ? advancedRoundNumberAtTick(state.nTick) : 0;
        if (advancedRoundLabel && advancedRoundLabel.IsValid()) {
            advancedRoundLabel.text = advancedChinese()
                ? ("第" + current + "/" + rounds.length + "回合")
                : ("R " + current + "/" + rounds.length);
        }
    }

    function advancedNumericEntryText(entry) {
        if (!entry || !entry.IsValid()) {
            return "";
        }
        if (entry._insightNumericButton) {
            return String(entry._insightNumericValue || "");
        }
        return String(entry.text || "");
    }

    function advancedSetNumericEntryText(entry, value) {
        if (!entry || !entry.IsValid()) {
            return;
        }
        const text = String(value || "").replace(/[^0-9]/g, "");
        if (entry._insightNumericButton) {
            entry._insightNumericValue = text;
            advancedSetButtonText(entry, text || entry._insightPlaceholder || "");
            return;
        }
        entry.text = text;
    }

    function advancedSubmitRound() {
        if (!advancedRoundInput || !advancedRoundInput.IsValid()) {
            return;
        }
        const raw = advancedNumericEntryText(advancedRoundInput).replace(/[^0-9]/g, "");
        const wanted = Number(raw);
        const rounds = advancedRefreshRoundIntervals(null);
        if (!raw || !isFinite(wanted) || wanted < 1 || wanted > rounds.length) {
            advancedOpenNumericPad(
                advancedRoundInput,
                advancedSubmitRound,
                advancedCopy("输入回合", "Enter round"),
            );
            return;
        }
        const target = rounds[wanted - 1];
        advancedSetNumericEntryText(advancedRoundInput, "");
        advancedCloseNumericPad();
        advancedEventPage = 0;
        advancedSeekToTick(target.start);
    }

    function advancedStepRound(delta) {
        const state = controller.GetDemoControllerState();
        const rounds = advancedRefreshRoundIntervals(null);
        if (!rounds.length) {
            return;
        }
        const currentNumber = state ? advancedRoundNumberAtTick(state.nTick) : 0;
        const currentIndex = currentNumber > 0
            ? currentNumber - 1
            : (Number(delta || 0) > 0 ? -1 : 0);
        const targetIndex = Math.max(
            0,
            Math.min(rounds.length - 1, currentIndex + Number(delta || 0)),
        );
        advancedEventPage = 0;
        advancedSeekToTick(rounds[targetIndex].start);
    }

    function advancedClampTick(tick) {
        return Math.max(0, Math.min(advancedPlayback.totalTick, Math.round(Number(tick) || 0)));
    }

    function advancedSetButtonText(button, value) {
        if (!button || !button.IsValid() || !button.GetChildCount || button.GetChildCount() < 1) {
            return;
        }
        const label = button.GetChild(0);
        if (label && label.IsValid()) {
            label.text = String(value || "");
        }
    }

    function advancedSeekToTick(tick) {
        const targetTick = advancedClampTick(tick);
        if (advancedSelectedXuid && advancedPlayback.byXuid[advancedSelectedXuid]) {
            advancedSelectPlayer(advancedSelectedXuid, { tick: targetTick });
            return;
        }
        const state = controller.GetDemoControllerState();
        const resumeAfterSeek = Boolean(state && !state.bIsPaused);
        try {
            if (controller.SetPaused) {
                controller.SetPaused(true);
            } else {
                GameInterfaceAPI.ConsoleCommand("demo_pause");
            }
            if (controller.GotoTick) {
                controller.GotoTick(targetTick);
            } else {
                GameInterfaceAPI.ConsoleCommand("demo_gototick " + targetTick);
            }
        } catch (errSeekTick) {}
        if (resumeAfterSeek) {
            $.Schedule(0.05, function () {
                try {
                    if (controller.SetPaused) {
                        controller.SetPaused(false);
                    } else {
                        GameInterfaceAPI.ConsoleCommand("demo_resume");
                    }
                } catch (errResumeSeek) {}
            });
        }
    }

    function advancedStepSeconds(seconds) {
        const state = controller.GetDemoControllerState();
        const current = state ? Number(state.nTick || 0) : 0;
        advancedSeekToTick(current + Number(seconds || 0) * advancedPlayback.tickRate);
    }

    function advancedTogglePlayback() {
        const state = controller.GetDemoControllerState();
        try {
            if (controller.SetPaused) {
                controller.SetPaused(!(state && state.bIsPaused));
            } else {
                GameInterfaceAPI.ConsoleCommand(state && state.bIsPaused ? "demo_resume" : "demo_pause");
            }
        } catch (errTogglePlayback) {}
    }

    function advancedSubmitTick() {
        if (!advancedTickInput || !advancedTickInput.IsValid()) {
            return;
        }
        const raw = advancedNumericEntryText(advancedTickInput).replace(/[^0-9]/g, "");
        if (!raw) {
            advancedOpenNumericPad(
                advancedTickInput,
                advancedSubmitTick,
                advancedCopy("输入 tick", "Enter tick"),
            );
            return;
        }
        const value = Number(raw);
        if (!isFinite(value)) {
            return;
        }
        advancedSetNumericEntryText(advancedTickInput, "");
        advancedCloseNumericPad();
        advancedSeekToTick(value);
    }

    function advancedFocusTextEntry(entry) {
        if (!entry || !entry.IsValid()) {
            return;
        }
        try { entry.SetFocus(); } catch (errFocus) {}
        try { $.DispatchEvent("SetInputFocus", entry); } catch (errDispatchFocus) {}
    }

    function advancedCloseNumericPad() {
        advancedNumericEntry = null;
        advancedNumericSubmit = null;
        if (advancedNumericPad && advancedNumericPad.IsValid()) {
            try { advancedNumericPad.DeleteAsync(0); } catch (errDeletePad) {}
        }
        advancedNumericPad = null;
    }

    function advancedNumericPadAppend(value) {
        if (!advancedNumericEntry || !advancedNumericEntry.IsValid()) {
            advancedCloseNumericPad();
            return;
        }
        const current = advancedNumericEntryText(advancedNumericEntry).replace(/[^0-9]/g, "");
        const limit = Math.max(1, Number(advancedNumericEntry.maxchars || 10));
        advancedSetNumericEntryText(
            advancedNumericEntry,
            (current + String(value || "")).slice(0, limit),
        );
    }

    function advancedOpenNumericPad(entry, submit, title) {
        if (!advancedMenu || !advancedMenu.IsValid() || !entry || !entry.IsValid()) {
            return;
        }
        advancedCloseNumericPad();
        advancedNumericEntry = entry;
        advancedNumericSubmit = submit;
        advancedNumericPad = advancedCreatePanel("Panel", advancedMenu, "CS2InsightAdvancedNumericPad");
        advancedNumericPad.style.width = "230px";
        advancedNumericPad.style.height = "244px";
        advancedNumericPad.style.horizontalAlign = "center";
        advancedNumericPad.style.verticalAlign = "center";
        advancedNumericPad.style.ignoreParentFlow = "true";
        advancedNumericPad.style.flowChildren = "down";
        advancedNumericPad.style.padding = "10px";
        advancedNumericPad.style.backgroundColor = "#191918fe";
        advancedNumericPad.style.border = "1px solid #e07f0a";
        advancedNumericPad.style.borderRadius = "8px";
        advancedNumericPad.style.boxShadow = "0px 4px 18px 3.0 #000000dd";
        advancedNumericPad.style.zIndex = "32100";

        const heading = advancedCreateLabel(advancedNumericPad, title, 13, "#e07f0a");
        heading.style.width = "100%";
        heading.style.height = "24px";
        heading.style.textAlign = "center";

        [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]].forEach(function (digits) {
            const row = advancedCreatePanel("Panel", advancedNumericPad, "");
            row.style.width = "100%";
            row.style.height = "36px";
            row.style.flowChildren = "right";
            digits.forEach(function (digit, digitIndex) {
                const button = advancedCreateButton(row, digit, function () {
                    advancedNumericPadAppend(digit);
                    return true;
                }, "64px");
                button.style.height = "31px";
                button.style.marginRight = digitIndex === 2 ? "0px" : "5px";
            });
        });

        const editRow = advancedCreatePanel("Panel", advancedNumericPad, "");
        editRow.style.width = "100%";
        editRow.style.height = "36px";
        editRow.style.flowChildren = "right";
        const clear = advancedCreateButton(editRow, advancedCopy("清空", "Clear"), function () {
            if (advancedNumericEntry && advancedNumericEntry.IsValid()) {
                advancedSetNumericEntryText(advancedNumericEntry, "");
            }
            return true;
        }, "64px");
        const zero = advancedCreateButton(editRow, "0", function () {
            advancedNumericPadAppend("0");
            return true;
        }, "64px");
        const erase = advancedCreateButton(editRow, "⌫", function () {
            if (advancedNumericEntry && advancedNumericEntry.IsValid()) {
                const current = advancedNumericEntryText(advancedNumericEntry).replace(/[^0-9]/g, "");
                advancedSetNumericEntryText(advancedNumericEntry, current.slice(0, -1));
            }
            return true;
        }, "64px");
        [clear, zero, erase].forEach(function (button, index) {
            button.style.height = "31px";
            button.style.marginRight = index === 2 ? "0px" : "5px";
        });

        const actionRow = advancedCreatePanel("Panel", advancedNumericPad, "");
        actionRow.style.width = "100%";
        actionRow.style.height = "37px";
        actionRow.style.marginTop = "3px";
        actionRow.style.flowChildren = "right";
        const cancel = advancedCreateButton(actionRow, advancedCopy("取消", "Cancel"), advancedCloseNumericPad, "98px");
        const confirm = advancedCreateButton(actionRow, advancedCopy("确定", "OK"), function () {
            const callback = advancedNumericSubmit;
            if (callback) {
                callback();
            }
            return true;
        }, "98px");
        cancel.style.height = "31px";
        confirm.style.height = "31px";
        confirm.style.marginRight = "0px";
        advancedStyleButton(confirm, true);
    }

    function advancedCursorPosition() {
        let raw = null;
        try {
            if (typeof GameUI !== "undefined" && GameUI.GetCursorPosition) {
                raw = GameUI.GetCursorPosition();
            }
        } catch (errGameUiCursor) {}
        if (!raw) {
            try {
                if ($.GetCursorPosition) {
                    raw = $.GetCursorPosition();
                }
            } catch (errPanoramaCursor) {}
        }
        if (!raw) {
            try {
                if (GameInterfaceAPI.GetCursorPosition) {
                    raw = GameInterfaceAPI.GetCursorPosition();
                }
            } catch (errInterfaceCursor) {}
        }
        if (!raw) {
            return null;
        }
        const x = Number(raw.x !== undefined ? raw.x : raw[0]);
        const y = Number(raw.y !== undefined ? raw.y : raw[1]);
        return isFinite(x) && isFinite(y) ? { x: x, y: y } : null;
    }

    function advancedPanelWindowPosition(panel) {
        if (!panel || !panel.IsValid()) {
            return null;
        }
        try {
            if (panel.GetPositionWithinWindow) {
                const raw = panel.GetPositionWithinWindow();
                const x = Number(raw.x !== undefined ? raw.x : raw[0]);
                const y = Number(raw.y !== undefined ? raw.y : raw[1]);
                if (isFinite(x) && isFinite(y)) {
                    return { x: x, y: y };
                }
            }
        } catch (errWindowPosition) {}
        let x = 0;
        let y = 0;
        let current = panel;
        let guard = 0;
        while (current && current.IsValid() && guard < 32) {
            x += Number(current.actualxoffset || 0);
            y += Number(current.actualyoffset || 0);
            current = current.GetParent ? current.GetParent() : null;
            guard += 1;
        }
        return { x: x, y: y };
    }

    function advancedPreviewProgressTick(value) {
        const target = advancedClampTick(value);
        if (advancedProgressFill && advancedProgressFill.IsValid()) {
            advancedProgressFill.style.width = (
                100 * target / Math.max(1, advancedPlayback.totalTick)
            ).toFixed(2) + "%";
        }
        if (advancedProgressLabel && advancedProgressLabel.IsValid()) {
            advancedProgressLabel.text = advancedFormatTick(target) + " / "
                + advancedFormatTick(advancedPlayback.totalTick) + "  ·  tick " + target;
        }
        return true;
    }

    function advancedSeekFromProgressSlider(panel, value) {
        const target = advancedClampTick(value);
        advancedPreviewProgressTick(target);
        advancedSeekToTick(target);
        return true;
    }

    function advancedUpdateProgress(state) {
        if (!state) {
            return;
        }
        advancedPlayback.totalTick = Math.max(
            1,
            advancedPlayback.totalTick,
            Number(state.nTotalTicks || 0),
        );
        const current = advancedClampTick(state.nTick);
        if (advancedProgressFill && advancedProgressFill.IsValid()) {
            advancedProgressFill.style.width = (100 * current / Math.max(1, advancedPlayback.totalTick)).toFixed(2) + "%";
        }
        if (advancedProgressSlider && advancedProgressSlider.IsValid()) {
            // Match CS2's stock HudDemoController exactly: Slider values are
            // absolute ticks. A normalized 0..1 Slider is integer-quantized by
            // Panorama and therefore returned 0 for almost every click.
            advancedProgressSlider.min = 0;
            advancedProgressSlider.max = advancedPlayback.totalTick;
            if (!advancedProgressSlider.mousedown) {
                advancedProgressSlider.value = current;
            }
        }
        if (advancedProgressLabel && advancedProgressLabel.IsValid()) {
            advancedProgressLabel.text = advancedFormatTick(current) + " / "
                + advancedFormatTick(advancedPlayback.totalTick) + "  ·  tick " + current;
        }
        advancedSetButtonText(
            advancedPlayPauseButton,
            state.bIsPaused ? advancedCopy("播放", "Play") : advancedCopy("暂停", "Pause"),
        );
    }

    function advancedHideNativeDemoUi() {
        // The injected script runs on the stock huddemocontroller context panel.
        // Hide that panel only; its parent owns the rest of the game HUD.
        try {
            controller.visible = false;
            controller.hittest = false;
            controller.hittestchildren = false;
            controller.style.opacity = "0";
        } catch (errNativeController) {}
        if (advancedNativeDemoUiCommandAttempts >= 12) {
            return;
        }
        let state = null;
        try { state = controller.GetDemoControllerState(); } catch (errState) {}
        if (!state || Number(state.nTotalTicks || 0) <= 0) {
            return;
        }
        if (advancedNativeDemoUiCommandAttempts === 0) {
            try { GameInterfaceAPI.ConsoleCommand("sv_cheats 1"); } catch (errCheats) {}
        }
        advancedNativeDemoUiCommandAttempts += 1;
        try { GameInterfaceAPI.ConsoleCommand("demoui false"); } catch (errDemoUi) {}
    }

    function advancedGuardNativeDemoUi() {
        if (!advancedPlayback) {
            return;
        }
        advancedHideNativeDemoUi();
        $.Schedule(1, advancedGuardNativeDemoUi);
    }

    function advancedLocalizedUtilityName(raw) {
        const text = String(raw || "").trim();
        let key = text.toLowerCase();
        if (key.indexOf("weapon_") === 0) {
            key = key.slice(7);
        }
        key = key.replace(/[_\- ]/g, "");
        const names = {
            smoke: ["烟雾弹", "Smoke"],
            smokegrenade: ["烟雾弹", "Smoke"],
            flash: ["闪光弹", "Flashbang"],
            flashbang: ["闪光弹", "Flashbang"],
            he: ["高爆手雷", "HE grenade"],
            hegrenade: ["高爆手雷", "HE grenade"],
            molotov: ["燃烧瓶", "Molotov"],
            incendiary: ["燃烧弹", "Incendiary"],
            incgrenade: ["燃烧弹", "Incendiary"],
            decoy: ["诱饵弹", "Decoy"],
            utility: ["道具", "Utility"],
        };
        return names[key] ? advancedCopy(names[key][0], names[key][1]) : text;
    }

    function advancedEventTitle(event) {
        const peer = event.peerXuid ? advancedPlayerName(event.peerXuid) : "";
        const roundNumber = advancedRoundNumberAtTick(event.tick);
        const roundText = roundNumber > 0
            ? advancedCopy("第" + roundNumber + "回合 · ", "R" + roundNumber + " · ")
            : "";
        const eventDetail = event.type === "utility"
            ? advancedLocalizedUtilityName(event.detail)
            : event.detail;
        const detail = eventDetail ? " · " + eventDetail : "";
        const headshot = (event.flags & 1) && event.type !== "utility"
            ? advancedCopy(" · 爆头", " · Headshot")
            : "";
        if (event.type === "kill") {
            return advancedCopy("[击杀] ", "[Kill] ") + roundText + advancedFormatTick(event.tick)
                + "  " + peer + detail + headshot;
        }
        if (event.type === "death") {
            return advancedCopy("[死亡] ", "[Death] ") + roundText + advancedFormatTick(event.tick)
                + "  " + (peer || advancedCopy("世界", "World")) + detail + headshot;
        }
        return advancedCopy("[道具] ", "[Utility] ") + roundText + advancedFormatTick(event.tick)
            + "  " + (eventDetail || advancedCopy("道具", "Utility"));
    }

    function advancedSpecCandidates(xuid) {
        const values = [];
        function add(value) {
            const number = Number(value);
            if (!isFinite(number) || number < 0 || number > 64 || values.indexOf(number) >= 0) {
                return;
            }
            values.push(number);
        }
        const runtimeSlot = runtimeSlotForXuid(xuid);
        const player = advancedPlayback.byXuid[normalizeXuid(xuid)];
        if (runtimeSlot >= 0) {
            add(runtimeSlot);
            add(runtimeSlot + 1);
        }
        if (player) {
            add(player.parserSlot);
            add(player.parserSlot + 1);
        }
        return values;
    }

    function advancedFinishSpecOperation(success) {
        const operation = advancedSpecOperation;
        if (!operation) {
            return;
        }
        advancedSpecOperation = null;
        if (operation.seekTick >= 0) {
            if (operation.playAfter) {
                try {
                    if (controller.SetPaused) {
                        controller.SetPaused(false);
                    } else {
                        GameInterfaceAPI.ConsoleCommand("demo_resume");
                    }
                } catch (errResume) {}
            } else {
                try {
                    if (controller.SetPaused) {
                        controller.SetPaused(true);
                    } else {
                        GameInterfaceAPI.ConsoleCommand("demo_pause");
                    }
                    if (controller.GotoTick) {
                        controller.GotoTick(Math.max(0, operation.seekTick | 0));
                    } else {
                        GameInterfaceAPI.ConsoleCommand("demo_gototick " + Math.max(0, operation.seekTick | 0));
                    }
                } catch (errExactSeek) {}
                if (operation.resumeAfterSeek) {
                    $.Schedule(0.05, function () {
                        try {
                            if (controller.SetPaused) {
                                controller.SetPaused(false);
                            } else {
                                GameInterfaceAPI.ConsoleCommand("demo_resume");
                            }
                        } catch (errResumeExactSeek) {}
                    });
                }
            }
        } else if (operation.restorePause) {
            try {
                if (controller.SetPaused) {
                    controller.SetPaused(true);
                } else {
                    GameInterfaceAPI.ConsoleCommand("demo_pause");
                }
            } catch (errPause) {}
        }
        if (!success) {
            $.Msg("[CS2 Insight] advanced playback could not verify POV XUID " + operation.xuid);
        }
    }

    function advancedAdvanceSpecOperation() {
        const operation = advancedSpecOperation;
        if (!operation) {
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.1, advancedAdvanceSpecOperation);
            return;
        }
        if (operation.seekTick >= 0
                && Math.abs(Number(state.nTick || 0) - operation.initialSeekTick) > 16
                && operation.seekWaits < 40) {
            operation.seekWaits += 1;
            $.Schedule(0.05, advancedAdvanceSpecOperation);
            return;
        }
        if (sameXuid(currentPovXuid(state), operation.xuid)) {
            advancedFinishSpecOperation(true);
            return;
        }
        if (operation.candidates.length === 0) {
            advancedFinishSpecOperation(false);
            return;
        }
        if (operation.index >= operation.candidates.length) {
            operation.index = 0;
            operation.cycles += 1;
            if (!operation.resumedForSpec && state.bIsPaused) {
                operation.resumedForSpec = true;
                try { GameInterfaceAPI.ConsoleCommand("demo_resume"); } catch (errResume) {}
                $.Schedule(0.12, advancedAdvanceSpecOperation);
                return;
            }
            if (operation.cycles >= 3) {
                advancedFinishSpecOperation(false);
                return;
            }
        }
        const candidate = operation.candidates[operation.index];
        operation.index += 1;
        try {
            GameInterfaceAPI.ConsoleCommand("spec_mode " + operation.mode);
            GameInterfaceAPI.ConsoleCommand("spec_player " + candidate);
        } catch (errSpec) {}
        $.Schedule(0.16, advancedAdvanceSpecOperation);
    }

    function advancedSelectPlayer(xuid, options) {
        const normalized = normalizeXuid(xuid);
        if (!advancedPlayback.byXuid[normalized]) {
            return;
        }
        const state = controller.GetDemoControllerState();
        const opts = options || {};
        const exactTick = isFinite(Number(opts.tick)) ? Math.max(0, Number(opts.tick) | 0) : -1;
        const playAfter = Boolean(opts.playAfter);
        const resumeAfterSeek = playAfter || Boolean(state && !state.bIsPaused);
        const initialSeekTick = exactTick >= 0
            ? Math.max(0, exactTick - (playAfter ? Math.round(advancedPlayback.tickRate * 3) : 0))
            : -1;
        advancedSelectedXuid = normalized;
        advancedEventPage = 0;
        if (initialSeekTick >= 0) {
            try {
                if (controller.SetPaused) {
                    controller.SetPaused(true);
                } else {
                    GameInterfaceAPI.ConsoleCommand("demo_pause");
                }
                if (controller.GotoTick) {
                    controller.GotoTick(initialSeekTick);
                } else {
                    GameInterfaceAPI.ConsoleCommand("demo_gototick " + initialSeekTick);
                }
            } catch (errSeek) {}
        }
        advancedSpecOperation = {
            xuid: normalized,
            mode: advancedViewMode === 1 ? 5 : advancedViewMode,
            candidates: advancedSpecCandidates(normalized),
            index: 0,
            cycles: 0,
            seekWaits: 0,
            seekTick: exactTick,
            initialSeekTick: initialSeekTick,
            playAfter: playAfter,
            resumeAfterSeek: resumeAfterSeek,
            restorePause: Boolean(state && state.bIsPaused),
            resumedForSpec: false,
        };
        try { GameInterfaceAPI.ConsoleCommand("spec_mode " + advancedSpecOperation.mode); } catch (errMode) {}
        $.Schedule(initialSeekTick >= 0 ? 0.12 : 0, advancedAdvanceSpecOperation);
        advancedRenderMenu();
    }

    function advancedSetPanelRuntimeVisible(panel, visible) {
        if (!panel || !panel.IsValid()) {
            return;
        }
        panel.visible = visible;
        try {
            panel.style.opacity = visible ? "1" : "0";
            panel.style.visibility = visible ? "visible" : "collapse";
        } catch (errStyle) {}
    }

    function advancedSpectatorInfoPanels() {
        const root = hudRootPanel();
        const panels = [];
        function add(panel) {
            if (panel && panel.IsValid() && panels.indexOf(panel) < 0) {
                panels.push(panel);
            }
        }
        [
            "HudSpecplayer",
            "HudSpecplayerRoot",
            "HudSpecplayerParentContainer",
            "HudSpecPlayer",
        ].forEach(function (id) {
            try { add(root.FindChildTraverse(id)); } catch (errId) {}
        });
        if (root.FindChildrenWithClassTraverse) {
            [
                "HudSpecplayerParentContainer",
                "HudSpecplayerRoot--visible",
                "HudSpecplayer__Bg",
            ].forEach(function (className) {
                const matches = root.FindChildrenWithClassTraverse(className) || [];
                matches.forEach(function (panel) {
                    add(panel);
                    let parent = panel.GetParent ? panel.GetParent() : null;
                    for (let depth = 0; parent && parent.IsValid() && depth < 2; depth += 1) {
                        let belongsToSpecPlayer = String(parent.id || "")
                            .toLowerCase().indexOf("specplayer") >= 0;
                        try {
                            belongsToSpecPlayer = belongsToSpecPlayer
                                || parent.BHasClass("HudSpecplayerParentContainer")
                                || parent.BHasClass("HudSpecplayerRoot--visible");
                        } catch (errClass) {}
                        if (!belongsToSpecPlayer) {
                            break;
                        }
                        add(parent);
                        parent = parent.GetParent ? parent.GetParent() : null;
                    }
                });
            });
        }
        return panels;
    }

    function advancedApplyNativeSpectatorHud(enabled) {
        const healthAmmo = findHudTraverse("HudHealthAmmoCenter")
            || findHudTraverse("CSGOHudHealthAmmoCenter");
        advancedSetPanelRuntimeVisible(healthAmmo, !enabled);

        advancedSpectatorInfoPanels().forEach(function (panel) {
            advancedSetPanelRuntimeVisible(panel, enabled);
            try { panel.SetHasClass("HudSpecplayerRoot--visible", enabled); } catch (errClass) {}
        });

        if (enabled) {
            restoreAdvancedTeamCounterPanels();
            const teamCounter = findTeamCounterRoot();
            if (teamCounter && teamCounter.IsValid() && teamCounter.FindChildrenWithClassTraverse) {
                const equipment = teamCounter.FindChildrenWithClassTraverse("hudteamcounter-equipmentinfo") || [];
                equipment.forEach(function (panel) {
                    advancedSetPanelRuntimeVisible(panel, true);
                    try { panel.RemoveClass("Invisible"); } catch (errInvisible) {}
                });
            }
        }
    }

    function advancedGuardSpectatorHud() {
        if (!advancedPlayback) {
            return;
        }
        advancedApplyNativeSpectatorHud(!advancedPovVisualsEnabled);
        $.Schedule(0.25, advancedGuardSpectatorHud);
    }

    function advancedApplyPlaybackProfile(profile) {
        if (profile !== "pov" && profile !== "demo") {
            return;
        }
        advancedPovVisualsEnabled = profile === "pov";
        const commands = advancedPovVisualsEnabled ? [
            "cl_draw_only_deathnotices false",
            "mp_forcecamera 0",
            "cl_trueview_show_status 0",
            "cl_spec_show_bindings 0",
            "cl_spec_stats 0",
            "r_spectator_flashbang_opacity 1",
            "cl_radar_always_centered 1",
            "cl_radar_square_always false",
            "cl_radar_rotate true",
            "cl_radar_square_when_spectating 0",
            "cl_radar_scale 0.4",
            "snd_disable_radar_visualize 0",
            "cl_hud_color 12",
            "cl_drawhud_force_teamid_overhead 1",
            "cl_teamid_overhead_mode 3",
            "cl_teamid_overhead_colors_show 1",
            "cl_teamid_overhead_fade_near_crosshair 0",
            "cl_teamid_overhead_maxdist 9999",
            "cl_teamid_overhead_maxdist_spec 9999",
        ] : [
            "cl_draw_only_deathnotices false",
            "mp_forcecamera 0",
            "cl_trueview_show_status 1",
            "cl_spec_show_bindings 1",
            "cl_spec_stats 1",
            "r_spectator_flashbang_opacity 1",
            "cl_radar_always_centered 0",
            "cl_radar_square_always true",
            "cl_radar_rotate false",
            "cl_radar_square_when_spectating 1",
            "cl_radar_scale 0.7",
            "snd_disable_radar_visualize 0",
            "cl_hud_color 0",
            "cl_drawhud_force_teamid_overhead 1",
            "cl_teamid_overhead_mode 3",
            "cl_teamid_overhead_colors_show 0",
            "cl_teamid_overhead_fade_near_crosshair 0",
            "cl_teamid_overhead_maxdist 9999",
            "cl_teamid_overhead_maxdist_spec 9999",
            "cl_teamcounter_playercount_instead_of_avatars false",
            "cl_drawhud_force_radar 0",
        ];
        for (let index = 0; index < commands.length; index += 1) {
            try { GameInterfaceAPI.ConsoleCommand(commands[index]); } catch (errCommand) {}
        }
        advancedApplyQuickOptions();
        advancedNativeOverheadRestored = false;
        advancedApplyNativeSpectatorHud(!advancedPovVisualsEnabled);
        if (!advancedPovVisualsEnabled) {
            restoreAdvancedTeamCounterPanels();
            restoreAdvancedHealthPanels();
            if (inputHud && inputHud.IsValid()) {
                inputHud.visible = false;
            }
            if (radarHud && radarHud.IsValid()) {
                radarHud.visible = false;
            }
            if (radarUnclipHud && radarUnclipHud.IsValid()) {
                radarUnclipHud.visible = false;
            }
            restoreNativeRadarForAdvancedSpectator();
            hideRadioHud();
            speakers.forEach(function (speaker) {
                if (speaker.panel && speaker.panel.IsValid()) {
                    speaker.panel.AddClass("Hidden");
                }
            });
            $.Schedule(0.05, function () {
                advancedApplyNativeSpectatorHud(true);
            });
        }
        audienceRefreshFrames = 0;
        advancedRenderMenu();
    }

    function advancedSetVoicePolicy(policy) {
        if (["team", "all", "mute", "custom"].indexOf(policy) < 0) {
            return;
        }
        advancedVoicePolicy = policy;
        audienceRefreshFrames = 0;
        advancedRenderMenu();
    }

    function advancedTogglePlayerVoice(xuid) {
        const normalized = normalizeXuid(xuid);
        if (advancedVoicePolicy !== "custom") {
            Object.keys(advancedCustomVoiceXuids).forEach(function (key) {
                delete advancedCustomVoiceXuids[key];
            });
            advancedVoicePolicy = "custom";
        }
        advancedCustomVoiceXuids[normalized] = !advancedCustomVoiceXuids[normalized];
        audienceRefreshFrames = 0;
        advancedRenderMenu();
    }

    function advancedPlayerVoiceEnabled(xuid) {
        const state = controller.GetDemoControllerState();
        const tick = state ? Number(state.nTick || 0) : 0;
        const povTeam = state ? resolvePovTeam(currentPovXuid(state), tick) : 0;
        return advancedVoiceAllows(xuid, povTeam, tick);
    }

    function advancedRenderPlayers() {
        if (!advancedPlayerListPanel || !advancedPlayerListPanel.IsValid()) {
            return;
        }
        advancedClearPanel(advancedPlayerListPanel);
        const state = controller.GetDemoControllerState();
        const tick = state ? Number(state.nTick || 0) : 0;
        const grouped = { 2: [], 3: [] };
        const teamSignature = [];
        advancedPlayback.players.forEach(function (player) {
            const liveTeam = resolvePovTeam(player.xuid, tick) || player.team;
            grouped[liveTeam === 3 ? 3 : 2].push(player);
            teamSignature.push(player.xuid + ":" + liveTeam);
        });
        advancedPlayerTeamSignature = teamSignature.join("|");

        function renderTeam(team, title, color) {
            const column = advancedCreatePanel("Panel", advancedPlayerListPanel, "");
            column.style.width = "fill-parent-flow(1.0)";
            column.style.height = "100%";
            column.style.flowChildren = "down";
            if (team === 3) {
                column.style.marginRight = "6px";
            } else {
                column.style.marginLeft = "6px";
            }
            const header = advancedCreateLabel(column, title, 12, color);
            header.style.width = "100%";
            header.style.height = "20px";
            header.style.textAlign = "center";
            grouped[team].forEach(function (player) {
                const row = advancedCreatePanel("Panel", column, "");
                row.style.width = "100%";
                row.style.height = "25px";
                row.style.flowChildren = "right";
                row.style.marginBottom = "1px";
                const button = advancedCreateButton(
                    row,
                    advancedPlayerName(player.xuid),
                    function () { advancedSelectPlayer(player.xuid, {}); },
                    "fill-parent-flow(1.0)",
                );
                button.style.height = "23px";
                button.style.marginRight = "3px";
                advancedStyleButton(button, sameXuid(player.xuid, advancedSelectedXuid));
                const voiceEnabled = advancedPlayerVoiceEnabled(player.xuid);
                const voiceText = voiceEnabled
                    ? advancedCopy("语音开", "ON")
                    : advancedCopy("语音关", "OFF");
                const voice = advancedCreateButton(
                    row,
                    voiceText,
                    function () { advancedTogglePlayerVoice(player.xuid); },
                    "54px",
                );
                voice.style.height = "23px";
                voice.style.marginRight = "0px";
                voice.style.paddingLeft = "2px";
                voice.style.paddingRight = "2px";
                advancedStyleButton(voice, voiceEnabled);
            });
        }

        renderTeam(3, "CT", "#5ebaf0");
        renderTeam(2, "T", "#e7bd53");
    }

    function advancedFilteredEvents() {
        const events = advancedPlayback.eventsByXuid[advancedSelectedXuid] || [];
        if (advancedEventFilter === "all") {
            return events;
        }
        return events.filter(function (event) { return event.type === advancedEventFilter; });
    }

    function advancedRenderEvents() {
        if (!advancedEventListPanel || !advancedEventListPanel.IsValid()) {
            return;
        }
        advancedClearPanel(advancedEventListPanel);
        const events = advancedFilteredEvents();
        const pageSize = 5;
        const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
        advancedEventPage = Math.max(0, Math.min(advancedEventPage, pageCount - 1));
        const visible = events.slice(advancedEventPage * pageSize, (advancedEventPage + 1) * pageSize);
        if (!visible.length) {
            const empty = advancedCreateLabel(
                advancedEventListPanel,
                advancedCopy("当前筛选没有事件", "No events for this filter"),
                14,
                "#8ea1aa",
            );
            empty.style.height = "32px";
        }
        visible.forEach(function (event) {
            const row = advancedCreatePanel("Panel", advancedEventListPanel, "");
            row.style.width = "100%";
            row.style.height = "26px";
            row.style.flowChildren = "right";
            row.style.marginBottom = "1px";
            const locate = advancedCreateButton(
                row,
                advancedEventTitle(event),
                function () { advancedSelectPlayer(advancedSelectedXuid, { tick: event.tick }); },
                "fill-parent-flow(1.0)",
            );
            locate.style.height = "24px";
            locate.style.marginRight = "6px";
            if (locate.GetChildCount && locate.GetChildCount() > 0) {
                locate.GetChild(0).style.textOverflow = "shrink";
            }
            const preroll = advancedCreateButton(
                row,
                "▶ -3s",
                function () {
                    advancedSelectPlayer(advancedSelectedXuid, { tick: event.tick, playAfter: true });
                },
                "58px",
            );
            preroll.style.height = "24px";
            preroll.style.marginRight = "0px";
        });
        if (advancedEventPagerLabel && advancedEventPagerLabel.IsValid()) {
            advancedEventPagerLabel.text = (advancedEventPage + 1) + " / " + pageCount
                + "  ·  " + events.length;
        }
    }

    function advancedRenderMenu() {
        if (!advancedPlayback || !advancedMenu || !advancedMenu.IsValid()) {
            return;
        }
        const state = controller.GetDemoControllerState();
        advancedRefreshRoundIntervals(state);
        if (!advancedSelectedXuid) {
            advancedSelectedXuid = state ? currentPovXuid(state) : "";
        }
        if (!advancedPlayback.byXuid[advancedSelectedXuid]) {
            advancedSelectedXuid = advancedPlayback.players[0].xuid;
        }
        advancedStyleButton(advancedProfileButtons.pov, advancedPovVisualsEnabled);
        advancedStyleButton(advancedProfileButtons.demo, !advancedPovVisualsEnabled);
        Object.keys(advancedVoiceButtons).forEach(function (key) {
            advancedStyleButton(advancedVoiceButtons[key], key === advancedVoicePolicy);
        });
        Object.keys(advancedFilterButtons).forEach(function (key) {
            advancedStyleButton(advancedFilterButtons[key], key === advancedEventFilter);
        });
        if (advancedPinButton && advancedPinButton.IsValid()) {
            advancedSetButtonText(
                advancedPinButton,
                advancedCopy(advancedMenuPinned ? "常显开" : "常显关", advancedMenuPinned ? "PIN ON" : "PIN OFF"),
            );
            advancedStyleButton(advancedPinButton, advancedMenuPinned);
        }
        advancedRefreshQuickOptionButtons();
        advancedRenderPlayers();
        advancedRenderEvents();
    }

    function advancedStopMenuDrag() {
        advancedMenuDragging = false;
        advancedMenuDragStartCursor = null;
        advancedMenuDragStartPosition = null;
        if (advancedMenuDragGhost && advancedMenuDragGhost.IsValid()) {
            try { advancedMenuDragGhost.DeleteAsync(0); } catch (errDeleteGhost) {}
        }
        advancedMenuDragGhost = null;
        return true;
    }

    function advancedMenuDragTick() {
        if (!advancedMenuDragging || !advancedMenu || !advancedMenu.IsValid()) {
            return;
        }
        const cursor = advancedCursorPosition();
        const root = hudRootPanel();
        if (cursor && root && root.IsValid()
                && advancedMenuDragStartCursor && advancedMenuDragStartPosition) {
            const scaleX = Math.max(0.001, Number(advancedMenu.actualuiscale_x || 1));
            const scaleY = Math.max(0.001, Number(advancedMenu.actualuiscale_y || scaleX));
            const rootWidth = Number(root.actuallayoutwidth || 0) / scaleX;
            const rootHeight = Number(root.actuallayoutheight || 0) / scaleY;
            const menuWidth = Number(advancedMenu.actuallayoutwidth || 0) / scaleX;
            const menuHeight = Number(advancedMenu.actuallayoutheight || 0) / scaleY;
            const x = advancedMenuDragStartPosition.x
                + (cursor.x - advancedMenuDragStartCursor.x) / scaleX;
            const y = advancedMenuDragStartPosition.y
                + (cursor.y - advancedMenuDragStartCursor.y) / scaleY;
            advancedMenu.style.x = Math.max(0, Math.min(Math.max(0, rootWidth - menuWidth), x)) + "px";
            advancedMenu.style.y = Math.max(0, Math.min(Math.max(0, rootHeight - menuHeight), y)) + "px";
        }
        $.Schedule(0.016, advancedMenuDragTick);
    }

    function advancedStartMenuDrag() {
        if (!advancedMenu || !advancedMenu.IsValid()) {
            return true;
        }
        if (advancedMenuDragging) {
            return true;
        }
        const cursor = advancedCursorPosition();
        const menuPosition = advancedPanelWindowPosition(advancedMenu);
        const root = hudRootPanel();
        const rootPosition = advancedPanelWindowPosition(root);
        if (!cursor || !menuPosition || !rootPosition) {
            return true;
        }
        const scaleX = Math.max(0.001, Number(advancedMenu.actualuiscale_x || 1));
        const scaleY = Math.max(0.001, Number(advancedMenu.actualuiscale_y || scaleX));
        const localX = (menuPosition.x - rootPosition.x) / scaleX;
        const localY = (menuPosition.y - rootPosition.y) / scaleY;
        advancedMenu.style.horizontalAlign = "left";
        advancedMenu.style.verticalAlign = "top";
        advancedMenu.style.marginRight = "0px";
        advancedMenu.style.marginLeft = "0px";
        advancedMenu.style.marginTop = "0px";
        advancedMenu.style.x = localX + "px";
        advancedMenu.style.y = localY + "px";
        advancedMenuDragStartCursor = cursor;
        advancedMenuDragStartPosition = { x: localX, y: localY };
        advancedMenuDragging = true;
        advancedMenuHoverGeneration += 1;
        $.Schedule(0, advancedMenuDragTick);
        return true;
    }

    function advancedAttachMenuDrag(handle) {
        if (!handle || !handle.IsValid()) {
            return;
        }
        try { handle.SetDraggable(true); } catch (errDraggable) {}
        try { handle.SetPanelEvent("onmousedown", advancedStartMenuDrag); } catch (errMouseDown) {}
        try { handle.SetPanelEvent("onactivate", advancedStopMenuDrag); } catch (errActivate) {}
        try {
            $.RegisterEventHandler("DragStart", handle, function (source, dragCallbacks) {
                advancedStartMenuDrag();
                const root = hudRootPanel();
                if (root && root.IsValid()) {
                    advancedMenuDragGhost = advancedCreatePanel(
                        "Panel",
                        root,
                        "CS2InsightAdvancedDragGhost",
                    );
                    const scaleX = Math.max(0.001, Number(advancedMenu.actualuiscale_x || 1));
                    const scaleY = Math.max(0.001, Number(advancedMenu.actualuiscale_y || scaleX));
                    const menuWidth = Number(advancedMenu.actuallayoutwidth || 0) / scaleX;
                    const menuHeight = Number(advancedMenu.actuallayoutheight || 0) / scaleY;
                    advancedMenuDragGhost.style.width = Math.max(1, menuWidth) + "px";
                    advancedMenuDragGhost.style.height = Math.max(1, menuHeight) + "px";
                    advancedMenuDragGhost.style.backgroundColor = "#19191899";
                    advancedMenuDragGhost.style.border = "1px solid #e07f0a";
                    advancedMenuDragGhost.style.borderRadius = "10px";
                    // If GameUI exposes cursor coordinates, the menu itself is
                    // already following them. Otherwise Panorama's native drag
                    // ghost provides the fallback position captured on DragEnd.
                    advancedMenuDragGhost.style.opacity = advancedMenuDragStartCursor ? "0" : "0.55";
                    advancedMenuDragGhost.hittest = false;
                    advancedMenuDragGhost.hittestchildren = false;
                    advancedMenuDragging = true;
                    advancedMenuHoverGeneration += 1;
                    if (dragCallbacks) {
                        dragCallbacks.displayPanel = advancedMenuDragGhost;
                        dragCallbacks.offsetX = 0;
                        dragCallbacks.offsetY = 0;
                    }
                }
                return true;
            });
            $.RegisterEventHandler("DragEnd", handle, function (source, draggedPanel) {
                if (!advancedMenuDragStartCursor && advancedMenu && advancedMenu.IsValid()) {
                    const position = advancedPanelWindowPosition(
                        draggedPanel && draggedPanel.IsValid()
                            ? draggedPanel
                            : advancedMenuDragGhost,
                    );
                    const root = hudRootPanel();
                    const rootPosition = advancedPanelWindowPosition(root);
                    if (position && rootPosition && root && root.IsValid()) {
                        const scaleX = Math.max(0.001, Number(advancedMenu.actualuiscale_x || 1));
                        const scaleY = Math.max(0.001, Number(advancedMenu.actualuiscale_y || scaleX));
                        const rootWidth = Number(root.actuallayoutwidth || 0) / scaleX;
                        const rootHeight = Number(root.actuallayoutheight || 0) / scaleY;
                        const menuWidth = Number(advancedMenu.actuallayoutwidth || 0) / scaleX;
                        const menuHeight = Number(advancedMenu.actuallayoutheight || 0) / scaleY;
                        const x = Math.max(0, Math.min(
                            Math.max(0, rootWidth - menuWidth),
                            (position.x - rootPosition.x) / scaleX,
                        ));
                        const y = Math.max(0, Math.min(
                            Math.max(0, rootHeight - menuHeight),
                            (position.y - rootPosition.y) / scaleY,
                        ));
                        advancedMenu.style.horizontalAlign = "left";
                        advancedMenu.style.verticalAlign = "top";
                        advancedMenu.style.marginRight = "0px";
                        advancedMenu.style.marginLeft = "0px";
                        advancedMenu.style.marginTop = "0px";
                        advancedMenu.style.x = x + "px";
                        advancedMenu.style.y = y + "px";
                    }
                }
                return advancedStopMenuDrag();
            });
        } catch (errDragEvents) {}
    }

    function advancedScheduleHideMenu() {
        if (advancedMenuPinned || advancedMenuDragging) {
            return;
        }
        const generation = ++advancedMenuHoverGeneration;
        $.Schedule(0.3, function () {
            if (generation !== advancedMenuHoverGeneration || !advancedMenu || !advancedMenu.IsValid()) {
                return;
            }
            if (advancedMenuPinned || advancedMenuDragging) {
                return;
            }
            try {
                if ((advancedMenu.BHasHoverStyle && advancedMenu.BHasHoverStyle())
                        || (advancedEdgeTrigger && advancedEdgeTrigger.IsValid()
                            && advancedEdgeTrigger.BHasHoverStyle
                            && advancedEdgeTrigger.BHasHoverStyle())) {
                    advancedMenuHoverGeneration += 1;
                    return;
                }
            } catch (errHoverState) {}
            advancedMenuVisible = false;
            advancedMenu.visible = false;
        });
    }

    function advancedShowMenu() {
        if (!advancedMenu || !advancedMenu.IsValid()) {
            return;
        }
        advancedMenuHoverGeneration += 1;
        advancedMenuVisible = true;
        advancedMenu.visible = true;
        advancedRenderMenu();
    }

    function advancedToggleMenuPinned() {
        advancedMenuPinned = !advancedMenuPinned;
        if (advancedMenuPinned) {
            advancedShowMenu();
        } else {
            advancedRenderMenu();
            advancedScheduleHideMenu();
        }
    }

    function advancedEnsureMenu() {
        if (!advancedPlayback) {
            return null;
        }
        const root = hudRootPanel();
        if (!root || !root.IsValid()) {
            return null;
        }
        root.hittestchildren = true;
        if (!advancedEdgeTrigger || !advancedEdgeTrigger.IsValid()) {
            advancedEdgeTrigger = advancedCreatePanel("Panel", root, "CS2InsightAdvancedEdge");
            advancedEdgeTrigger.style.width = "18px";
            advancedEdgeTrigger.style.height = "100%";
            advancedEdgeTrigger.style.horizontalAlign = "right";
            advancedEdgeTrigger.style.verticalAlign = "center";
            advancedEdgeTrigger.style.backgroundColor = "#e07f0a02";
            advancedEdgeTrigger.style.zIndex = "32000";
            advancedEdgeTrigger.SetPanelEvent("onmouseover", advancedShowMenu);
        }
        if (advancedMenu && advancedMenu.IsValid()) {
            return advancedMenu;
        }
        advancedMenu = advancedCreatePanel("Panel", root, "CS2InsightAdvancedMenu");
        advancedMenu.style.width = "500px";
        advancedMenu.style.height = "640px";
        advancedMenu.style.maxHeight = "92%";
        advancedMenu.style.horizontalAlign = "right";
        advancedMenu.style.verticalAlign = "center";
        advancedMenu.style.marginRight = "6px";
        advancedMenu.style.padding = "12px";
        advancedMenu.style.flowChildren = "down";
        advancedMenu.style.backgroundColor = "#191918f7";
        advancedMenu.style.border = "1px solid #494844";
        advancedMenu.style.borderRadius = "10px";
        advancedMenu.style.boxShadow = "0px 8px 32px 4.0 #000000bb";
        advancedMenu.style.zIndex = "32001";
        advancedMenu.style.overflow = "clip";
        advancedMenuVisible = advancedMenuPinned;
        advancedMenu.visible = advancedMenuPinned;
        advancedMenu.SetPanelEvent("onmouseover", function () {
            advancedMenuHoverGeneration += 1;
        });
        advancedMenu.SetPanelEvent("onmouseout", advancedScheduleHideMenu);

        const titleRow = advancedCreatePanel("Panel", advancedMenu, "");
        titleRow.style.width = "100%";
        titleRow.style.height = "30px";
        titleRow.style.marginBottom = "2px";
        titleRow.style.flowChildren = "right";
        const dragHandle = advancedCreatePanel(
            "Button",
            titleRow,
            "CS2InsightAdvancedDragHandle",
        );
        dragHandle.style.width = "fill-parent-flow(1.0)";
        dragHandle.style.height = "25px";
        dragHandle.style.backgroundColor = "#00000001";
        dragHandle.style.border = "0px";
        const title = advancedCreateLabel(dragHandle, "INSIGHT · " + advancedCopy("高级播放", "ADVANCED PLAYBACK"), 17, "#e07f0a");
        title.style.width = "100%";
        title.style.horizontalAlign = "left";
        advancedAttachMenuDrag(dragHandle);
        advancedMenuTickLabel = advancedCreateLabel(titleRow, "", 11, "#7c7b74");
        advancedMenuTickLabel.style.width = "70px";
        advancedPinButton = advancedCreateButton(titleRow, "", advancedToggleMenuPinned, "62px");
        advancedPinButton.style.height = "25px";
        advancedPinButton.style.paddingLeft = "4px";
        advancedPinButton.style.paddingRight = "4px";
        const close = advancedCreateButton(titleRow, "×", function () {
            advancedStopMenuDrag();
            advancedMenuHoverGeneration += 1;
            advancedMenuPinned = false;
            advancedMenuVisible = false;
            advancedMenu.visible = false;
        }, "30px");
        close.style.height = "25px";
        close.style.marginRight = "0px";

        const viewRow = advancedCreatePanel("Panel", advancedMenu, "");
        viewRow.style.width = "100%";
        viewRow.style.height = "30px";
        viewRow.style.flowChildren = "right";
        advancedCreateLabel(viewRow, "HUD", 12, "#b5b3ad").style.width = "40px";
        const pov = advancedCreateButton(viewRow, "POV HUD", function () { advancedApplyPlaybackProfile("pov"); }, "112px");
        const demo = advancedCreateButton(viewRow, "DEMO HUD", function () { advancedApplyPlaybackProfile("demo"); }, "112px");
        advancedProfileButtons.pov = pov;
        advancedProfileButtons.demo = demo;
        pov.style.marginRight = "5px";
        demo.style.marginRight = "5px";
        advancedStyleButton(pov, advancedPovVisualsEnabled);
        advancedStyleButton(demo, !advancedPovVisualsEnabled);
        [pov, demo].forEach(function (button) { button.style.height = "25px"; });

        const voiceRow = advancedCreatePanel("Panel", advancedMenu, "");
        voiceRow.style.width = "100%";
        voiceRow.style.height = "30px";
        voiceRow.style.flowChildren = "right";
        advancedCreateLabel(voiceRow, advancedCopy("语音", "Voice"), 12, "#b5b3ad").style.width = "40px";
        [
            ["team", advancedCopy("本队", "Team")],
            ["all", advancedCopy("全部", "All")],
            ["mute", advancedCopy("静音", "Mute")],
            ["custom", advancedCopy("自选", "Custom")],
        ].forEach(function (entry) {
            const button = advancedCreateButton(voiceRow, entry[1], function () { advancedSetVoicePolicy(entry[0]); }, "66px");
            button.style.height = "25px";
            advancedVoiceButtons[entry[0]] = button;
            advancedStyleButton(button, advancedVoicePolicy === entry[0]);
        });

        const optionRow = advancedCreatePanel("Panel", advancedMenu, "");
        optionRow.style.width = "100%";
        optionRow.style.height = "30px";
        optionRow.style.flowChildren = "right";
        advancedCreateLabel(optionRow, advancedCopy("显示", "View"), 12, "#b5b3ad").style.width = "40px";
        [
            ["xray", advancedCopy("X光", "X-ray"), "135px"],
            ["radar", advancedCopy("雷达", "Radar"), "135px"],
            ["overhead", advancedCopy("标识", "IDs"), "135px"],
        ].forEach(function (entry) {
            const button = advancedCreateButton(
                optionRow,
                "",
                function () { advancedToggleQuickOption(entry[0]); },
                entry[2],
            );
            button.style.height = "25px";
            advancedOptionButtons[entry[0]] = button;
            advancedOptionLabels[entry[0]] = entry[1];
        });
        advancedRefreshQuickOptionButtons();

        const timeline = advancedCreatePanel("Panel", advancedMenu, "CS2InsightAdvancedTimeline");
        timeline.style.width = "100%";
        timeline.style.height = "108px";
        timeline.style.marginTop = "6px";
        timeline.style.flowChildren = "down";
        timeline.style.backgroundColor = "#111110aa";
        timeline.style.border = "1px solid #3b3a37";
        timeline.style.borderRadius = "6px";
        timeline.style.paddingLeft = "7px";
        timeline.style.paddingRight = "7px";
        advancedProgressLabel = advancedCreateLabel(timeline, "", 11, "#b5b3ad");
        advancedProgressLabel.style.width = "100%";
        advancedProgressLabel.style.height = "18px";
        advancedProgressTrack = advancedCreatePanel("Panel", timeline, "CS2InsightAdvancedProgress");
        advancedProgressTrack.style.width = "100%";
        advancedProgressTrack.style.height = "12px";
        advancedProgressTrack.style.backgroundColor = "#222221";
        advancedProgressTrack.style.border = "1px solid #494844";
        advancedProgressTrack.style.borderRadius = "6px";
        advancedProgressTrack.style.overflow = "clip";
        advancedProgressFill = advancedCreatePanel("Panel", advancedProgressTrack, "CS2InsightAdvancedProgressFill");
        advancedProgressFill.hittest = false;
        advancedProgressFill.hittestchildren = false;
        advancedProgressFill.style.width = "0%";
        advancedProgressFill.style.height = "100%";
        advancedProgressFill.style.backgroundColor = "#e07f0a";
        advancedProgressSlider = advancedCreatePanel(
            "Slider",
            advancedProgressTrack,
            "CS2InsightAdvancedProgressSlider",
        );
        advancedProgressSlider.AddClass("HorizontalSlider");
        try { advancedProgressSlider.SetAttributeString("direction", "horizontal"); } catch (errDirection) {}
        try { advancedProgressSlider.direction = "horizontal"; } catch (errDirectionProperty) {}
        advancedProgressSlider.style.width = "100%";
        advancedProgressSlider.style.height = "100%";
        advancedProgressSlider.style.zIndex = "3";
        advancedProgressSlider.style.opacity = "0.01";
        advancedProgressSlider.min = 0;
        advancedProgressSlider.max = Math.max(1, advancedPlayback.totalTick);
        $.RegisterEventHandler(
            "SliderReleased",
            advancedProgressSlider,
            advancedSeekFromProgressSlider,
        );
        $.RegisterEventHandler(
            "SliderValueChanged",
            advancedProgressSlider,
            function (panel, value) { return advancedPreviewProgressTick(value); },
        );
        const timelineControls = advancedCreatePanel("Panel", timeline, "");
        timelineControls.style.width = "100%";
        timelineControls.style.height = "31px";
        timelineControls.style.marginTop = "7px";
        timelineControls.style.flowChildren = "right";
        const back = advancedCreateButton(timelineControls, "-15s", function () { advancedStepSeconds(-15); }, "52px");
        advancedPlayPauseButton = advancedCreateButton(timelineControls, advancedCopy("暂停", "Pause"), advancedTogglePlayback, "56px");
        const forward = advancedCreateButton(timelineControls, "+15s", function () { advancedStepSeconds(15); }, "52px");
        const timelineSpacer = advancedCreatePanel("Panel", timelineControls, "");
        timelineSpacer.style.width = "fill-parent-flow(1.0)";
        const tickCaption = advancedCreateLabel(timelineControls, "tick", 11, "#7c7b74");
        tickCaption.style.width = "32px";
        advancedTickInput = advancedCreateButton(
            timelineControls,
            "tick",
            function () {
                advancedOpenNumericPad(
                    advancedTickInput,
                    advancedSubmitTick,
                    advancedCopy("输入 tick", "Enter tick"),
                );
                return true;
            },
            "110px",
        );
        advancedTickInput.style.width = "110px";
        advancedTickInput.style.height = "25px";
        advancedTickInput.style.marginRight = "5px";
        advancedTickInput.style.paddingLeft = "7px";
        advancedTickInput.style.paddingRight = "7px";
        advancedTickInput.style.backgroundColor = "#222221";
        advancedTickInput.style.border = "1px solid #494844";
        advancedTickInput.style.color = "#eeeeec";
        advancedTickInput.style.fontSize = "12px";
        advancedTickInput._insightNumericButton = true;
        advancedTickInput._insightNumericValue = "";
        advancedTickInput._insightPlaceholder = "tick";
        advancedTickInput.maxchars = 10;
        const jump = advancedCreateButton(timelineControls, advancedCopy("跳转", "Go"), advancedSubmitTick, "54px");
        jump.style.marginRight = "0px";

        const roundControls = advancedCreatePanel("Panel", timeline, "");
        roundControls.style.width = "100%";
        roundControls.style.height = "31px";
        roundControls.style.marginTop = "3px";
        roundControls.style.flowChildren = "right";
        const roundCaption = advancedCreateLabel(roundControls, advancedCopy("回合", "Round"), 11, "#7c7b74");
        roundCaption.style.width = "40px";
        const previousRound = advancedCreateButton(roundControls, advancedCopy("上一回", "Prev"), function () { advancedStepRound(-1); }, "54px");
        advancedRoundInput = advancedCreateButton(
            roundControls,
            advancedCopy("回合号", "No."),
            function () {
                advancedOpenNumericPad(
                    advancedRoundInput,
                    advancedSubmitRound,
                    advancedCopy("输入回合", "Enter round"),
                );
                return true;
            },
            "64px",
        );
        advancedRoundInput.style.width = "64px";
        advancedRoundInput.style.height = "25px";
        advancedRoundInput.style.marginRight = "5px";
        advancedRoundInput.style.paddingLeft = "7px";
        advancedRoundInput.style.paddingRight = "7px";
        advancedRoundInput.style.backgroundColor = "#222221";
        advancedRoundInput.style.border = "1px solid #494844";
        advancedRoundInput.style.color = "#eeeeec";
        advancedRoundInput.style.fontSize = "12px";
        advancedRoundInput._insightNumericButton = true;
        advancedRoundInput._insightNumericValue = "";
        advancedRoundInput._insightPlaceholder = advancedCopy("回合号", "No.");
        advancedRoundInput.maxchars = 3;
        const locateRound = advancedCreateButton(roundControls, advancedCopy("定位", "Go"), advancedSubmitRound, "48px");
        const nextRound = advancedCreateButton(roundControls, advancedCopy("下一回", "Next"), function () { advancedStepRound(1); }, "54px");
        advancedRoundLabel = advancedCreateLabel(roundControls, "", 11, "#e07f0a");
        advancedRoundLabel.style.width = "fill-parent-flow(1.0)";
        advancedRoundLabel.style.textAlign = "center";
        [back, advancedPlayPauseButton, forward, jump, previousRound, locateRound, nextRound].forEach(function (button) {
            button.style.height = "25px";
        });

        advancedPlayerListPanel = advancedCreatePanel("Panel", advancedMenu, "CS2InsightAdvancedPlayers");
        advancedPlayerListPanel.style.width = "100%";
        advancedPlayerListPanel.style.height = "154px";
        advancedPlayerListPanel.style.marginTop = "8px";
        advancedPlayerListPanel.style.flowChildren = "right";
        advancedPlayerListPanel.style.overflow = "clip";
        advancedPlayerListPanel.style.backgroundColor = "#11111088";
        advancedPlayerListPanel.style.border = "1px solid #3b3a37";
        advancedPlayerListPanel.style.borderRadius = "6px";

        const filterRow = advancedCreatePanel("Panel", advancedMenu, "");
        filterRow.style.width = "100%";
        filterRow.style.height = "30px";
        filterRow.style.marginTop = "8px";
        filterRow.style.flowChildren = "right";
        [
            ["all", advancedCopy("全部事件", "All")],
            ["kill", advancedCopy("击杀", "Kills")],
            ["death", advancedCopy("死亡", "Deaths")],
            ["utility", advancedCopy("道具", "Utility")],
        ].forEach(function (entry) {
            const button = advancedCreateButton(filterRow, entry[1], function () {
                advancedEventFilter = entry[0];
                advancedEventPage = 0;
                advancedRenderMenu();
            }, "62px");
            button.style.height = "25px";
            advancedFilterButtons[entry[0]] = button;
            advancedStyleButton(button, advancedEventFilter === entry[0]);
        });
        const pagerPrevious = advancedCreateButton(filterRow, "‹", function () {
            advancedEventPage = Math.max(0, advancedEventPage - 1);
            advancedRenderEvents();
        }, "28px");
        pagerPrevious.style.height = "25px";
        pagerPrevious.style.marginRight = "3px";
        advancedEventPagerLabel = advancedCreateLabel(filterRow, "", 11, "#7c7b74");
        advancedEventPagerLabel.style.width = "fill-parent-flow(1.0)";
        advancedEventPagerLabel.style.textAlign = "center";
        const pagerNext = advancedCreateButton(filterRow, "›", function () {
            advancedEventPage += 1;
            advancedRenderEvents();
        }, "28px");
        pagerNext.style.height = "25px";
        pagerNext.style.marginRight = "0px";
        advancedEventListPanel = advancedCreatePanel("Panel", advancedMenu, "CS2InsightAdvancedEvents");
        advancedEventListPanel.style.width = "100%";
        advancedEventListPanel.style.height = "140px";
        advancedEventListPanel.style.marginTop = "4px";
        advancedEventListPanel.style.flowChildren = "down";
        advancedEventListPanel.style.overflow = "clip";
        advancedEventListPanel.style.backgroundColor = "#11111088";
        advancedEventListPanel.style.border = "1px solid #3b3a37";
        advancedEventListPanel.style.borderRadius = "6px";
        const footerSpacer = advancedCreatePanel("Panel", advancedMenu, "");
        footerSpacer.style.width = "100%";
        footerSpacer.style.height = "18px";
        footerSpacer.hittest = false;
        footerSpacer.hittestchildren = false;

        advancedApplyQuickOptions();
        advancedRenderMenu();
        return advancedMenu;
    }

    function advancedMenuTick() {
        if (!advancedPlayback) {
            return;
        }
        advancedEnsureMenu();
        if (advancedMenuPinned && advancedMenu && advancedMenu.IsValid() && !advancedMenuVisible) {
            advancedShowMenu();
        }
        const state = controller.GetDemoControllerState();
        advancedUpdateProgress(state);
        advancedUpdateRoundLabel(state);
        if (advancedMenuTickLabel && advancedMenuTickLabel.IsValid() && state) {
            advancedMenuTickLabel.text = "tick " + Number(state.nTick || 0);
        }
        if (advancedMenuVisible && state) {
            const tick = Number(state.nTick || 0);
            const teamSignature = advancedPlayback.players.map(function (player) {
                return player.xuid + ":" + (resolvePovTeam(player.xuid, tick) || player.team);
            }).join("|");
            if (teamSignature !== advancedPlayerTeamSignature) {
                advancedRenderPlayers();
            }
            const current = currentPovXuid(state);
            if (current && current !== advancedSelectedXuid && !advancedSpecOperation) {
                advancedSelectedXuid = current;
                advancedEventPage = 0;
                advancedRenderMenu();
            }
        }
        $.Schedule(0.1, advancedMenuTick);
    }

    $.Schedule(0, ensureDemoVoicesUnmuted);
    $.Schedule(0, update);
    $.Schedule(0, updateInputHud);
    $.Schedule(0, tickTeamCounterHud);
    $.Schedule(0, updateOverheadInfoHud);
    $.Schedule(0, tickFlashBlindHud);
    $.Schedule(0, watchDemoTimeJumps);
    suppressNativeLowerLeft();
    if (radarTrack) {
        $.Schedule(0, updateRadarHud);
    }
    if (killFeedbackEvents) {
        $.Schedule(0, updateKillFeedback);
    }
    if (radioTrack || killFeedbackTrack) {
        $.Schedule(0, updateRadioHud);
    }
    if (advancedPlayback) {
        $.Schedule(0, advancedGuardNativeDemoUi);
        $.Schedule(0, advancedGuardSpectatorHud);
        $.Schedule(0, advancedMenuTick);
    }
})();
