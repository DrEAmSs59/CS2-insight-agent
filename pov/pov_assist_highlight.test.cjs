const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'pov_assist_highlight.js'), 'utf8');
const create = vm.runInNewContext(source + '\ncreatePovAssistHighlight');
const own = '76561198875633179', other = '76561198875633178';
const event = (tick = 100, xuid = own, people = [['killer', ''], ['helper', ''], ['victim', '']]) => ({tick, xuid, people});
class Panel {
    constructor(id = '', classes = [], parent = null) {
        this.id = id; this.classes = new Set(classes); this.children = []; this.valid = true;
        this.style = {}; this.text = ''; if (parent) parent.children.push(this);
    }
    IsValid() { return this.valid; }
    Children() { return this.children; }
    BHasClass(name) { return this.classes.has(name); }
    FindChildTraverse(id) { return this.children.find(p => p.id === id) || null; }
    FindChildrenWithClassTraverse(name) { return this.children.filter(p => p.classes.has(name)); }
    ClearPropertyFromCode(name) { delete this.style[name]; }
}
function harness(events = [event()]) {
    let hud = new Panel();
    const stock = new Panel('VisibleNotices', [], hud);
    const control = create(events, {findHud: () => hud});
    function row(names = ['killer', 'helper', 'victim'], classes = ['DeathNotice', 'DeathNoticeAssist']) {
        const panel = new Panel('', classes, stock);
        ['Attacker', 'Assister', 'Victim'].forEach((id, i) => { new Panel(id, [], panel).text = names[i]; });
        const border = new Panel('', ['DeathNoticeBGBorder'], panel);
        panel.spawnTime = 1.5; panel.lifetime = 6; panel.opacity = 0.4;
        return {panel, border};
    }
    return {row, stock, control, update: (tick = 100, xuid = own, enabled = true) => control.update({nTick: tick}, xuid, enabled),
        detach: () => { hud = null; }};
}
test('ordinary assist gets only the stock border; native classes, lifetime, fade and list are untouched', () => {
    const h = harness(), assist = h.row(), kill = h.row(['helper', '', 'victim'], ['DeathNotice', 'DeathNotice_Killer']);
    const unrelated = h.row(['someone', 'else', 'victim']);
    h.update();
    assert.equal(assist.border.style.border, '2px solid #e10000');
    assert.equal(assist.panel.BHasClass('DeathNotice_Killer'), false);
    assert.equal(kill.panel.BHasClass('DeathNotice_Killer'), true);
    assert.equal(kill.border.style.border, undefined); assert.equal(unrelated.border.style.border, undefined);
    assert.equal(assist.panel.spawnTime, 1.5); assert.equal(assist.panel.lifetime, 6); assert.equal(assist.panel.opacity, 0.4);
    assert.equal(h.stock.Children().length, 3);
});
test('flash assists use the same identity; native flash icon and flags survive', () => {
    const h = harness(), r = h.row(undefined, ['DeathNoticeAssist', 'DeathNoticeFlashbang']);
    h.update(); assert.equal(r.border.style.border, '2px solid #e10000');
    assert.equal(r.panel.BHasClass('DeathNoticeFlashbang'), true);
});
test('no future highlight; rewind, profile changes, missing POV and switching players clear only our border', () => {
    const h = harness(), r = h.row();
    h.update(99); assert.equal(r.border.style.border, undefined);
    h.update(100); assert.ok(r.border.style.border);
    h.update(100, other); assert.equal(r.border.style.border, undefined);
    h.update(100); h.update(99); assert.equal(r.border.style.border, undefined);
    h.update(100); h.update(100, own, false); assert.equal(r.border.style.border, undefined);
    h.update(100); h.update(100, ''); assert.equal(r.border.style.border, undefined);
});
test('pooled or deleted rows, changed labels and a rebuilt HUD cannot retain an assist border', () => {
    const h = harness(), r = h.row(); h.update();
    r.panel.classes.add('Available'); h.update(); assert.equal(r.border.style.border, undefined);
    r.panel.classes.delete('Available'); h.update(); assert.ok(r.border.style.border);
    r.panel.FindChildTraverse('Assister').text = 'somebody'; h.update(); assert.equal(r.border.style.border, undefined);
    r.panel.FindChildTraverse('Assister').text = 'helper'; h.update();
    h.detach(); h.update(); assert.equal(r.border.style.border, undefined);
    r.border.valid = false; h.control.dispose();
});
test('exact full trio disambiguates names; conflicting SteamIDs remain unhighlighted including future namesakes', () => {
    const h = harness([event(), event(200, other)]), r = h.row();
    h.update(100); assert.equal(r.border.style.border, undefined);
    h.update(201); assert.equal(r.border.style.border, undefined);
    const unique = harness([event(), event(200, other, [['another killer', ''], ['helper', ''], ['victim', '']])]);
    const u = unique.row(); unique.update(); assert.ok(u.border.style.border);
});
test('native bracketed clan tags, hidden clans, aliases and escaped names match exactly', () => {
    const people = [['g2r1se', 'paди нeгo'], ['Agokufo', 'няшкa)'], ['virusmonstah', 'P9܆']];
    const h = harness([event(104146, own, people)]);
    const tagged = h.row(['<font color="#fff">[paди нeгo]</font> g2r1se', '[няшкa)] Agokufo', '[P9܆] virusmonstah']);
    const hidden = h.row(['g2r1se', 'Agokufo', 'virusmonstah']);
    h.update(104146); assert.ok(tagged.border.style.border); assert.ok(hidden.border.style.border);
    const escaped = harness([event(10, own, [['alias & one', ''], ['<helper>', ''], ['victim', '']])]);
    const e = escaped.row(['alias &amp; one', '&lt;helper&gt;', 'victim']); escaped.update(10); assert.ok(e.border.style.border);
});
test('repeated same-identity events and long-lived stock rows do not impose a custom time limit', () => {
    const h = harness([event(), event(300)]), r = h.row();
    h.update(20000); assert.ok(r.border.style.border); h.control.dispose(); assert.equal(r.border.style.border, undefined);
});
test('shared runtime enables OBS POV and advanced POV, clears for DEMO/hidden profiles', () => {
    const hud = new Panel(), stock = new Panel('VisibleNotices', [], hud);
    const row = new Panel('', ['DeathNoticeAssist'], stock);
    ['Attacker', 'Assister', 'Victim'].forEach((id, i) => { new Panel(id, [], row).text = ['killer', 'helper', 'victim'][i]; });
    const border = new Panel('', ['DeathNoticeBGBorder'], row), pending = [];
    const context = vm.createContext({povAssistEvents: [event()], controller: {GetDemoControllerState: () => ({nTick: 100})},
        currentPovXuid: () => own, findHudTraverse: () => hud, advancedPlayback: {}, advancedPovVisualsEnabled: false,
        advancedHudHidden: false, recordingPovVisualsEnabled: false,
        $: {Schedule: (_time, callback) => pending.push(callback), Msg: text => assert.fail(text)}});
    vm.runInContext(source + '\n' + fs.readFileSync(path.join(__dirname, 'pov_assist_highlight_runtime.js'), 'utf8'), context);
    pending.shift()(); assert.equal(border.style.border, undefined);
    context.advancedPovVisualsEnabled = true; pending.shift()(); assert.ok(border.style.border);
    context.advancedHudHidden = true; pending.shift()(); assert.equal(border.style.border, undefined);
    context.advancedPlayback = null; context.recordingPovVisualsEnabled = true;
    pending.shift()(); assert.ok(border.style.border);
    context.recordingPovVisualsEnabled = false; pending.shift()(); assert.equal(border.style.border, undefined);
});
