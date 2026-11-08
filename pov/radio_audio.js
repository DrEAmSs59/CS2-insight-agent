// App-owned recording/advanced-playback module. Audio stays in the engine's original
// sound events; the sound stack reads the actual source entity's current team.
// The SOS float bridge is scoped to this temporary game session, which
// restores game configuration after CS2 exits. It is not a user volume setting.
// setinfo strings read as zero in convar_get; stack-field edits only affect new
// events. This float is read by active callouts too, so POV cuts mute immediately.
// -1: ordinary spectator HUD (bypass); 0: unknown POV team; 2/3: POV team.
let insightRadioTeam = null;
function updateInsightRadioTeam() {
    let team = 0;
    try {
        // Older verified HLAE templates may lack the shared HUD mode helper;
        // those are POV recording sessions and retain team filtering.
        const povActive = typeof advancedPovVisualsActive !== "function"
            || advancedPovVisualsActive();
        if (!povActive) {
            team = -1;
        } else {
            const state = controller.GetDemoControllerState();
            if (state) {
                const xuid = currentPovXuid(state);
                team = Number(GameStateAPI.GetPlayerTeamNumber(xuid)) || 0;
            }
            if (team !== 2 && team !== 3) team = 0;
        }
        if (team !== insightRadioTeam) {
            GameInterfaceAPI.ConsoleCommand("snd_op_test_convar " + team);
            insightRadioTeam = team;
        }
    } catch (error) {
        if (insightRadioTeam !== 0) {
            GameInterfaceAPI.ConsoleCommand("snd_op_test_convar 0");
            insightRadioTeam = 0;
        }
    }
    $.Schedule(0, updateInsightRadioTeam);
}
GameInterfaceAPI.ConsoleCommand("snd_op_test_convar 0");
$.Schedule(0, updateInsightRadioTeam);
