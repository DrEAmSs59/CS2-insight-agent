// Injected into the stock Panorama huddemocontroller script in
// pov_voice_template.vpk. demo_voice_hud.py replaces only the bounded payload
// between the two marker comments before installing the package.
;(function CS2InsightDemoVoiceHud() {
    "use strict";

    const packed = /*__CS2_INSIGHT_VOICE_DATA_BEGIN__*/[[], []]/*__CS2_INSIGHT_VOICE_DATA_END__*/;
    const locationTokens = packed[0];
    const encodedSpeakers = packed[1];
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
    let listenAllInitialized = false;
    let unmuteAttempts = 0;

    function ensureAllDemoVoicesAudible() {
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.25, ensureAllDemoVoicesAudible);
            return;
        }

        if (!listenAllInitialized) {
            GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices -1");
            GameInterfaceAPI.ConsoleCommand("tv_listen_voice_indices_h -1");
            listenAllInitialized = true;
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
            $.Schedule(0.5, ensureAllDemoVoicesAudible);
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
        const voicePanel = findVoicePanel();
        if (!state || !voicePanel || !voicePanel.IsValid()) {
            speakers.forEach(function (speaker) {
                if (speaker.panel && speaker.panel.IsValid()) {
                    speaker.panel.AddClass("Hidden");
                }
            });
            $.Schedule(0.1, update);
            return;
        }

        speakers.forEach(function (speaker, index) {
            const active = isSpeaking(speaker.intervals, state.nTick);
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

    $.Schedule(0, ensureAllDemoVoicesAudible);
    $.Schedule(0, update);
})();
