// Ordinary notices remain entirely engine-owned: no new rows, classes or clocks.
function createPovAssistHighlight(events, api) {
    const index = Object.create(null);
    let painted = [];
    function plain(text) {
        // Strip only native formatting; decode escaped player-name characters last.
        return String(text || "").replace(/<[^>]*>/g, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/&amp;/g, "&").replace(/\u00a0/g, " ").trim();
    }
    function key(names) { return JSON.stringify(names); }
    function variants(person) {
        // DEM names are literal text, not HTML. Native labels HTML-escape them.
        const name = String(person[0] || "").replace(/\u00a0/g, " ").trim();
        const clan = String(person[1] || "").replace(/\u00a0/g, " ").trim();
        return clan ? [name, clan + " " + name, "[" + clan + "] " + name] : [name];
    }
    events.forEach(function (event) {
        const names = event.people.map(variants);
        names[0].forEach(function (attacker) {
            names[1].forEach(function (assister) {
                names[2].forEach(function (victim) {
                    const signature = key([attacker, assister, victim]);
                    const entry = index[signature];
                    if (!entry) index[signature] = {xuid: event.xuid, tick: event.tick, ambiguous: false};
                    else {
                        // Even a future namesake makes this display signature unsafe.
                        entry.ambiguous = entry.ambiguous || entry.xuid !== event.xuid;
                        entry.tick = Math.min(entry.tick, event.tick);
                    }
                });
            });
        });
    });
    function clear(border) {
        if (border && border.IsValid()) border.ClearPropertyFromCode("border");
    }
    function dispose() { painted.forEach(clear); painted = []; }
    function update(state, xuid, enabled) {
        if (!enabled || !state || !Number.isFinite(Number(state.nTick)) || !xuid) {
            dispose(); return;
        }
        const hud = api.findHud();
        const stock = hud && hud.IsValid() ? hud.FindChildTraverse("VisibleNotices") : null;
        const next = [];
        if (stock && stock.IsValid()) stock.Children().forEach(function (row) {
            if (!row.IsValid() || !row.BHasClass("DeathNoticeAssist")
                    || row.BHasClass("Available") || row.BHasClass("DeathNoticeSuicide")) return;
            const labels = ["Attacker", "Assister", "Victim"].map(function (id) {
                const label = row.FindChildTraverse(id);
                return label && label.IsValid() ? plain(label.text) : "";
            });
            if (labels.some(function (text) { return !text; })) return;
            const event = index[key(labels)];
            if (!event || event.ambiguous || event.xuid !== String(xuid)
                    || event.tick > Number(state.nTick)) return;
            const borders = row.FindChildrenWithClassTraverse("DeathNoticeBGBorder");
            const border = borders && borders[0];
            if (!border || !border.IsValid()) return;
            // Same border as stock DeathNotice_Killer. Leave its class (and the
            // native local-player lifetime multiplier) entirely to the engine.
            border.style.border = "2px solid #e10000";
            next.push(border);
        });
        painted.forEach(function (border) { if (next.indexOf(border) < 0) clear(border); });
        painted = next;
    }
    return {update: update, dispose: dispose};
}
