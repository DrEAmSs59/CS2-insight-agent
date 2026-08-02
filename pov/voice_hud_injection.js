/*__CS2_INSIGHT_INJECTION_BEGIN__*/
// Injected into the stock Panorama huddemocontroller script in
// pov_voice_template.vpk. demo_voice_hud.py replaces only the bounded payload
// between the two marker comments before installing the package. The payload
// contains [location tokens, voice speakers, exact svc_UserCmd input tracks,
// SteamID/slot/team roster].
;(function CS2InsightDemoVoiceHud() {
    "use strict";

    const packed = /*__CS2_INSIGHT_VOICE_DATA_BEGIN__*/[[], [], [], []]/*__CS2_INSIGHT_VOICE_DATA_END__*/;
    const locationTokens = packed[0];
    const encodedSpeakers = packed[1];
    const encodedInputTracks = packed[2] || [];
    const encodedRoster = packed[3] || [];
    const roster = encodedRoster.map(function (encoded) {
        return {
            xuid: String(encoded[0]),
            slot: Number(encoded[1]),
            team: Number(encoded[2]),
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
            unmuted: false,
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
    let unmuteAttempts = 0;
    let audiencePovXuid = "";
    let audienceMaskSignature = "";
    let audienceRefreshFrames = 0;
    let inputHud = null;
    let inputKeyPanels = [];

    function currentPovXuid(state) {
        let xuid = String(GameStateAPI.GetHudPlayerXuid() || "");
        if ((!xuid || xuid === "0") && state && state.nSpectatingPlayerId >= 0) {
            xuid = String(
                GameStateAPI.GetPlayerXuidStringFromPlayerSlot(state.nSpectatingPlayerId) || "",
            );
        }
        return xuid;
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
        const povPlayer = rosterByXuid[povXuid];
        const povTeam = povPlayer ? povPlayer.team : 0;
        const targetChanged = povXuid !== audiencePovXuid;
        audienceRefreshFrames -= 1;
        if (!targetChanged && audienceRefreshFrames > 0) {
            return povTeam;
        }

        let low = 0;
        let high = 0;
        if (povTeam === 2 || povTeam === 3) {
            // Resolve actual runtime slots from XUIDs instead of trusting a
            // platform-specific spec_player offset baked into the demo.
            for (let slot = 0; slot < 64; slot += 1) {
                const slotXuid = String(GameStateAPI.GetPlayerXuidStringFromPlayerSlot(slot) || "");
                const slotPlayer = rosterByXuid[slotXuid];
                if (!slotPlayer || slotPlayer.team !== povTeam) {
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

    function ensureDemoVoicesUnmuted() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.25, ensureDemoVoicesUnmuted);
            return;
        }

        let pending = false;
        speakers.forEach(function (speaker) {
            if (!speaker.xuid || speaker.unmuted) {
                return;
            }
            GameStateAPI.SetPlayerVoiceVolume(speaker.xuid, 1);
            speaker.unmuted = !GameStateAPI.IsSelectedPlayerMuted(speaker.xuid)
                && GameStateAPI.GetPlayerVoiceVolume(speaker.xuid) > 0;
            pending = pending || !speaker.unmuted;
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

        speakers.forEach(function (speaker, index) {
            const speakerPlayer = rosterByXuid[speaker.xuid];
            const sameTeam = povTeam !== 0 && speakerPlayer && speakerPlayer.team === povTeam;
            const active = sameTeam && isSpeaking(speaker.intervals, state.nTick);
            if (!active && (!speaker.panel || !speaker.panel.IsValid())) {
                return;
            }
            const notice = ensureNotice(speaker, index, voicePanel);
            if (active) {
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
        $.Schedule(0, update);
    }

    $.Schedule(0, ensureDemoVoicesUnmuted);
    $.Schedule(0, update);
    $.Schedule(0, updateInputHud);
})();
