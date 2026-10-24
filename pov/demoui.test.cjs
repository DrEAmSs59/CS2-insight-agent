const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

// Exercise the shipped controller, not a copied implementation. Both templates
// must keep the complete stock controller before the shared Insight injection.
function controllerSource(filename) {
    const vpk = fs.readFileSync(path.join(__dirname, filename));
    assert.equal(vpk.readUInt32LE(0), 0x55aa1234);
    assert.equal(vpk.readUInt32LE(4), 2);
    const dataStart = 28 + vpk.readUInt32LE(8);
    let cursor = 28;
    function string() {
        const end = vpk.indexOf(0, cursor);
        const value = vpk.toString('utf8', cursor, end);
        cursor = end + 1;
        return value;
    }
    for (let ext; (ext = string());) {
        for (let dir; (dir = string());) {
            for (let name; (name = string());) {
                const preload = vpk.readUInt16LE(cursor + 4);
                const archive = vpk.readUInt16LE(cursor + 6);
                const offset = vpk.readUInt32LE(cursor + 8);
                const size = vpk.readUInt32LE(cursor + 12);
                cursor += 18;
                const prefix = vpk.subarray(cursor, cursor + preload);
                cursor += preload;
                if (`${dir}/${name}.${ext}` !== 'panorama/scripts/hud/huddemocontroller.vts_c') continue;
                assert.equal(archive, 0x7fff);
                const resource = Buffer.concat([prefix, vpk.subarray(dataStart + offset, dataStart + offset + size)]);
                for (let i = 0; i < resource.readUInt32LE(12); i++) {
                    const block = 16 + i * 12;
                    if (resource.toString('ascii', block, block + 4) !== 'DATA') continue;
                    const start = block + 4 + resource.readUInt32LE(block + 4);
                    const source = resource.toString('utf8', start, start + resource.readUInt32LE(block + 8));
                    const marker = source.indexOf('/*__CS2_INSIGHT_INJECTION_BEGIN__*/');
                    assert.ok(marker > 0, 'unambiguous stock/injection boundary');
                    return source.slice(0, marker);
                }
            }
        }
    }
    throw new Error(`Missing controller in ${filename}`);
}

function runtime(source) {
    const panels = new Map(), scheduled = [], handlers = new Map(), commands = [], seeks = [], spectated = [];
    function panel(id = '') {
        const classes = new Set();
        return {id, style: {}, children: [], events: {}, vars: {}, visible: true,
            actuallayoutwidth: 100, actualuiscale_x: 1, mousedown: false,
            SetHasClass(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
            BHasClass: name => classes.has(name), AddClass: name => classes.add(name),
            RemoveClass: name => classes.delete(name), ToggleClass(name) { this.SetHasClass(name, !classes.has(name)); },
            SetPanelEvent(name, action) { this.events[name] = action; },
            SetDialogVariable(name, value) { this.vars[name] = value; },
            SetDialogVariableInt(name, value) { this.vars[name] = value; },
            SetLocString(value) { this.text = value; },
            SetSelected(value) { this.selected = value; }, IsSelected() { return this.selected; },
            SetValueNoEvents(value) { this.value = value; },
            BReadyForDisplay: () => true, IsSizeValid: () => true,
            GetPositionWithinAncestor: () => ({x: 0, y: 0}),
            FindChildTraverse: id => panel(id),
            RemoveAndDeleteChildren() { this.children = []; },
        };
    }
    const state = {sFileName: 'test.dem', nTick: 6400, nTotalTicks: 30000, nSecondsPerTick: 1 / 64,
        nSpectatingPlayerId: 503, nObserverMode: 2, fTimeScale: 1, bIsPaused: false,
        RoundIntervals: [{nTickStart: 0, nTickEnd: 10000}, {nTickStart: 10000, nTickEnd: 20000},
            {nTickStart: 20000, nTickEnd: 30000}], HighlightIntervals: [], TimelineEvents: []};
    const roster = [
        {nEntIndex: 8, nPawnEntIndex: 503, nPlayerSlot: 7, sName: 'Alice', nTeam: 3, bAlive: true},
        {nEntIndex: 4, nPawnEntIndex: 901, nPlayerSlot: 3, sName: 'Bob', nTeam: 2, bAlive: true},
        {nEntIndex: 6, nPawnEntIndex: 502, nPlayerSlot: 5, sName: 'Dead', nTeam: 2, bAlive: false},
    ];
    const hud = panel('hud'), cp = panel('controller');
    Object.assign(cp, {
        GetParent: () => hud, GetDemoControllerState: () => state, GetDemoPlayers: () => roster.slice(),
        IsPlayingDemo: () => true, SetPaused: value => { state.bIsPaused = value; },
        SetDemoTimeScale: value => { state.fTimeScale = value; },
        GotoTick: tick => seeks.push(tick), SpectatePlayer: entity => spectated.push(entity),
        GotoTickAndSpectate: (tick, entity) => { seeks.push(tick); spectated.push(entity); },
        GetActionStartTicks: () => [640, 10640, 20640],
        GetDeathEvents: () => [{nTick: 8000, nControllerEntIndex: 4}],
        SetHighlightsModeEnabled: value => { state.bIsPlayingHighlights = value; },
        StopPlayback: () => { state.stopped = true; },
    });
    const $ = id => {
        if (!panels.has(id)) panels.set(id, panel(id));
        return panels.get(id);
    };
    Object.assign($, {GetContextPanel: () => cp, Schedule: (_, fn) => scheduled.push(fn),
        Localize: value => value,
        RegisterForUnhandledEvent: (name, fn) => handlers.set(name, fn),
        RegisterEventHandler: (name, p, fn) => { p.events[name] = fn; },
        CreatePanel: (_, parent, id, props) => {
            const p = Object.assign(panel(id), props); parent.children.push(p); return p;
        },
    });
    const settings = {demo_ui_mode: '2', spec_show_xray: '0', cl_demo_predict: '0', cl_trueview_show_doa_predictions: '0'};
    const ctx = vm.createContext({$, Date, GameInterfaceAPI: {
        GetSettingString: key => settings[key], ConsoleCommand: cmd => commands.push(cmd),
    }, UiToolkitAPI: {ShowTextTooltip() {}, HideTextTooltip() {}}});
    vm.runInContext(source, ctx);
    const frame = scheduled.find(fn => fn.name === 'FrameUpdate');
    assert.equal(typeof frame, 'function');
    frame();
    return {ui: ctx.HudDemoController, $, cp, state, roster, frame, commands, seeks, spectated, settings};
}

for (const filename of ['pov_voice_template.vpk', 'pov_advanced_playback_template.vpk']) {
    const source = controllerSource(filename);
    test(`${filename}: names resolve pawn -> slot and list switches by controller entity`, () => {
        const h = runtime(source);
        assert.equal(h.$('#PlayerName').vars.player_slot, 7);
        assert.equal(h.$('#PlayerName').text, '#CSGO_Demo_Player_Name');
        h.ui.TogglePlayerListVisible();
        const rows = h.$('#PlayerList').children;
        assert.equal(rows.length, 3);
        const bob = rows.find(p => p.children[1].vars.player_slot === 3);
        bob.events.onactivate();
        assert.deepEqual(h.spectated, [4]);
        assert.equal(h.$('#PlayerList').BHasClass('Visible'), false);
        assert.equal(rows.find(p => p.BHasClass('dead')).events.onactivate, undefined);
        h.state.nSpectatingPlayerId = 901; h.frame();
        assert.equal(h.$('#PlayerName').vars.player_slot, 3);
        assert.equal(h.$('#PlayerName').BHasClass('team-t'), true);
        h.roster[1].nPawnEntIndex = 1200; h.state.nSpectatingPlayerId = 1200; h.frame();
        assert.equal(h.$('#PlayerName').text, '#CSGO_Demo_Player_Name');
        h.state.nSpectatingPlayerId = -1; h.frame();
        assert.equal(h.$('#PlayerName').text, '#CSGO_Demo_Player_None');
    });
    test(`${filename}: speed, pause, seek, time and tick stay synchronized`, () => {
        const h = runtime(source), speed = h.$('#SpeedSlider');
        for (const [stop, value] of [0, .1, .25, .5, 1, 2, 4].entries()) {
            speed.events.SliderValueChanged(null, stop);
            assert.equal(h.state.bIsPaused, value === 0);
            if (value) assert.equal(h.state.fTimeScale, value);
            h.frame();
            assert.equal(speed.value, stop);
        }
        h.ui.OnPlayClicked(); assert.equal(h.state.bIsPaused, true);
        h.ui.OnPlayClicked(); assert.equal(h.state.fTimeScale, 1);
        h.$('#Slider').events.SliderReleased(null, 12000.9);
        assert.equal(h.seeks.at(-1), 12000);
        h.state.nTick = 12000; h.frame();
        assert.equal(h.cp.vars.current_tick, '012000');
        assert.equal(h.cp.vars.current_time, '03:07');
        assert.equal(h.cp.vars.round_number, 2);
        h.ui.OnStepTimeBackward(); assert.equal(h.seeks.at(-1), 11040);
        h.ui.OnStepTimeForward(); assert.equal(h.seeks.at(-1), 12960);
    });
    test(`${filename}: last round navigation, restart/action menu and next kill`, () => {
        const h = runtime(source);
        h.state.nTick = 25000; h.frame();
        h.ui.OnStepInterval(-1); assert.equal(h.seeks.at(-1), 10000);
        h.ui.OnStepInterval(1); assert.equal(h.seeks.at(-1), 20000);
        h.ui.OnRoundButtonActivate();
        const rows = h.$('#RoundMenu').children;
        assert.equal(rows.length, 2);
        rows[0].events.onactivate(); assert.equal(h.seeks.at(-1), 20000);
        rows[1].events.onactivate(); assert.equal(h.seeks.at(-1), 20640);
        h.state.nTick = 6400; h.frame();
        h.ui.OnNextEvent(); assert.equal(h.seeks.at(-1), 7872);
        assert.equal(h.spectated.at(-1), 4);
        h.state.bIsPlayingHighlights = true;
        h.state.TimelineEvents = [{nTick: 9000, eEventType: 0}]; h.frame();
        h.ui.OnNextEvent(); assert.equal(h.seeks.at(-1), 8872);
    });
    test(`${filename}: camera, player arrows, settings and quit bindings`, () => {
        const h = runtime(source);
        h.state.nObserverMode = 4; h.frame(); h.ui.OnStepPlayer(1);
        assert.deepEqual(h.commands.slice(-2), ['spec_mode 2', 'spec_next']);
        h.state.nObserverMode = 2; h.frame(); h.ui.OnStepPlayer(-1); h.ui.OnNextCamera();
        assert.deepEqual(h.commands.slice(-2), ['spec_prev', 'spec_mode']);
        h.ui.TogglePlayerListVisible(); h.ui.ToggleSettingsVisible(); h.frame();
        assert.equal(h.$('#PlayerList').BHasClass('Visible'), false);
        assert.equal(h.$('#Settings').BHasClass('Visible'), true);
        h.ui.ToggleXRay(); assert.equal(h.commands.at(-1), 'spec_show_xray 1');
        h.ui.ToggleTrueView(); assert.equal(h.commands.at(-1), 'cl_demo_predict 1');
        h.ui.OnStopPlayback(); assert.equal(h.state.stopped, true);
    });
}

const injection = fs.readFileSync(path.join(__dirname, 'voice_hud_injection.js'), 'utf8');
function fn(name) {
    const start = injection.indexOf('    function ' + name + '(');
    assert.ok(start >= 0);
    return injection.slice(start, injection.indexOf('\n    }', start) + 6);
}
test('shared POV identity resolves live pawn roster, never treats pawn IDs as player slots', () => {
    let hudXuid = '0', players = [{nPawnEntIndex: 7, nPlayerSlot: 3}];
    const slots = [];
    const ctx = vm.createContext({controller: {GetDemoPlayers: () => players}, GameStateAPI: {
        GetHudPlayerXuid: () => hudXuid,
        GetPlayerXuidStringFromPlayerSlot: slot => { slots.push(slot); return 'player-' + slot; },
    }});
    vm.runInContext(fn('normalizeXuid') + fn('currentPovXuid'), ctx);
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: 7}), 'player-3');
    assert.deepEqual(slots, [3]);
    players = [{nPawnEntIndex: 801, nPlayerSlot: 5}];
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: 801}), 'player-5');
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: 7}), '');
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: -1}), '');
    ctx.controller.GetDemoPlayers = () => { throw Error('demo loading'); };
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: 801}), '');
    hudXuid = 'current-hud-player';
    assert.equal(ctx.currentPovXuid({nSpectatingPlayerId: 801}), hudXuid);
});
