/* INSIGHT_PANORAMA_KILLFEED_V1 */
// The journal belongs to this recording, not the engine's seek-rebuilt HUD pool.
function createPersistentKillfeed(settings, api) {
    const events = settings.events || [], ranges = settings.segments || [], seen = new Set();
    let journal = [], lastTick = null, container = null, stock = null, rendered = "", highlighted = "";
    let playbackTarget = "", previousPaused = true;
    function inRecording(tick) { return ranges.some(function (r) { return tick >= r[0] && tick <= r[1]; }); }
    function firstAt(tick) {
        let lo = 0, hi = events.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].tick < tick) lo = mid + 1; else hi = mid; }
        return lo;
    }
    function playerLabel(row, id, person) {
        const label = row.FindChildTraverse(id);
        if (!label) return;
        const text = person ? ((!settings.hide_clan_tags && person.clan ? person.clan + " " : "") + person.name) : "";
        label.text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        label.SetHasClass("DeathNoticeCTColor", Boolean(person && person.team === 3));
        label.SetHasClass("DeathNoticeTColor", Boolean(person && person.team === 2));
        label.SetHasClass("DeathNoticeFadedColor", !person || (person.team !== 2 && person.team !== 3));
    }
    function highlight(row, event, xuid) {
        row.SetHasClass("DeathNotice_Killer", Boolean(xuid && event.attacker.xuid === xuid));
        row.SetHasClass("DeathNotice_Victim", Boolean(xuid && event.victim.xuid === xuid));
    }
    function render(xuid, recordingTarget, tick) {
        const hud = api.findHud();
        if (!hud || !hud.IsValid()) return;
        stock = hud.FindChildTraverse("VisibleNotices");
        if (!stock || !stock.IsValid()) return;
        if (!container || !container.IsValid() || container.GetParent() !== hud) {
            container = api.createPanel("Panel", hud, "CS2InsightPersistentNotices");
            container.style.flowChildren = "down";
            container.style.horizontalAlign = "right";
            container.style.height = "100%";
            container.hittest = false;
            rendered = "";
        }
        // A rewind changes the visible history, not event identity. Keep all
        // visited events so older rows can reappear without future kills leaking
        // into an earlier cut, even after the 15-row display limit was reached.
        const visible = journal.filter(function (event) { return event.tick <= tick; }).slice(-15);
        const signature = visible.map(function (event) { return event.id; }).join("|");
        if (signature !== rendered) {
            container.RemoveAndDeleteChildren();
            visible.forEach(function (event) {
                const row = api.createPanel("Panel", container, "");
                // Use the installed game's own snippet and CSS, not replacement artwork.
                if (!row.BLoadLayoutSnippet("DeathNotice")) throw new Error("DeathNotice snippet unavailable");
                row.AddClass("DeathNotice");
                playerLabel(row, "Attacker", event.attacker);
                playerLabel(row, "Assister", event.assister);
                playerLabel(row, "Victim", event.victim);
                event.classes.forEach(function (name) { row.AddClass(name); });
                row.FindChildTraverse("Weapon").SetImage("s2r://panorama/images/icons/equipment/" + event.weapon + ".vsvg");
                highlight(row, event, xuid);
            });
            rendered = signature;
            highlighted = xuid;
        } else if (highlighted !== xuid) {
            container.Children().forEach(function (row, index) { highlight(row, visible[index], xuid); });
            highlighted = xuid;
        }
        // Victim/replay POV must not inherit the protagonist's persistent list.
        // Keep its journal and seen IDs so returning never duplicates an event.
        container.style.visibility = xuid === settings.target_xuid
            && recordingTarget === settings.target_xuid ? "visible" : "collapse";
        stock.style.opacity = "0"; // Hide only once the replacement is ready.
    }
    function update(state, xuid, recordingTarget) {
        if (!state) return;
        const tick = Number(state.nTick);
        if (!Number.isFinite(tick)) return;
        const jump = lastTick === null || tick < lastTick || tick - lastTick > 128;
        xuid = String(xuid || "");
        // The legacy OBS executor pauses after selecting each clip's POV.
        // Latch that target across playback: a victim's death can make CS2
        // auto-observe the protagonist before the victim clip has finished.
        if (jump || (previousPaused && !state.bIsPaused)) playbackTarget = xuid;
        previousPaused = Boolean(state.bIsPaused);
        const lower = jump ? tick : lastTick;
        let added = false;
        if (!state.bIsPaused && inRecording(tick)) {
            for (let i = firstAt(lower); i < events.length && events[i].tick <= tick; i += 1) {
                const event = events[i];
                if (inRecording(event.tick) && event.attacker.xuid === settings.target_xuid
                    && event.victim.xuid !== settings.target_xuid && !seen.has(event.id)) {
                    seen.add(event.id);
                    journal.push(event);
                    added = true;
                }
            }
        }
        if (added) journal.sort(function (left, right) { return left.tick - right.tick; });
        lastTick = tick;
        // A caller may provide an explicit clip target; OBS otherwise latches it.
        render(xuid, recordingTarget == null ? playbackTarget : String(recordingTarget), tick);
    }
    function dispose() {
        if (stock && stock.IsValid()) stock.ClearPropertyFromCode("opacity");
        if (container && container.IsValid()) container.DeleteAsync(0);
    }
    return {update: update, dispose: dispose};
}
