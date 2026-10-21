const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the profile switch from both shipped templates so rebuilding only one
// VPK cannot leave OBS or advanced playback with the former color override.
for (const template of ['pov_voice_template.vpk', 'pov_advanced_playback_template.vpk']) {
    test(`${template}: repeated HUD profile switches preserve the game color`, () => {
        const source = fs.readFileSync(path.join(__dirname, template)).toString('utf8');
        const start = source.indexOf('    function advancedApplyPlaybackProfile(');
        const end = source.indexOf('\n    function ', start + 1);
        assert.ok(start >= 0 && end > start);
        const commands = [], settings = {cl_hud_color: '5'};
        const noop = () => {};
        const ctx = {
            advancedHudHidden: false, advancedPovVisualsEnabled: true,
            advancedNativeOverheadRestored: false, audienceRefreshFrames: 0,
            advancedQuickOptions: {radar: true}, radarHud: null, radarUnclipHud: null,
            $: {Schedule: (_, callback) => callback()},
            GameInterfaceAPI: {ConsoleCommand(command) {
                commands.push(command);
                const [name, value] = command.split(' ');
                settings[name] = value;
            }},
            advancedRefreshQuickOptionButtons: noop, advancedApplyQuickOptions: noop,
            advancedSetPanelRuntimeVisible: noop, findTeamCounterRoot: () => null,
            findNativeRadar: () => null, findHudTraverse: () => null,
            advancedSpectatorInfoPanels: () => [], advancedApplyNativeSpectatorHud: noop,
            restoreAdvancedTeamCounterPanels: noop, restoreNativeRadarForAdvancedSpectator: noop,
            hideRadioHud: noop, advancedRenderMenu: noop,
        };
        vm.createContext(ctx);
        vm.runInContext(source.slice(start, end), ctx);
        for (const color of ['5', '9', '12']) {
            settings.cl_hud_color = color;
            for (const profile of ['demo', 'hidden', 'pov', 'demo', 'pov']) {
                ctx.advancedApplyPlaybackProfile(profile);
                assert.equal(settings.cl_hud_color, color);
            }
        }
        assert.equal(commands.some(command => command.startsWith('cl_hud_color ')), false);
        assert.ok(commands.includes('cl_force_spec_hud_color_to_team false'));
    });
}
