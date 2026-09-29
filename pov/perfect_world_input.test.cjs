const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'voice_hud_injection.js'), 'utf8');
function fn(name) {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }', start) + 6);
}

test('Perfect World starts hidden and cannot be enabled by playback controls', () => {
    const ctx = vm.createContext({
        encodedInputPresentation: [1, 'hybrid', 100, 1, 100, 1, 'bottom_center', 'perfect_world'],
        encodedAdvancedPlayback: {}, advancedPlayback: {}, advancedHudHidden: false,
    });
    vm.runInContext(source.slice(source.indexOf('    const inputHudUnavailable ='),
        source.indexOf('    const PLAYER_COLOR_HEX')), ctx);
    vm.runInContext(source.match(/    let advancedInputHudPosition = [^;]+;/)[0], ctx);
    vm.runInContext([fn('runtimeInputHudVisible'), fn('advancedSetInputHudPosition')].join('\n'), ctx);
    assert.equal(vm.runInContext('inputHudEnabled', ctx), false);
    assert.equal(vm.runInContext('inputAudioEnabled', ctx), false);
    assert.equal(vm.runInContext('advancedInputHudPosition', ctx), 'hidden');
    ctx.advancedSetInputHudPosition('weapon_right');
    assert.equal(vm.runInContext('advancedInputHudPosition', ctx), 'hidden');
    assert.equal(ctx.runtimeInputHudVisible(), false);
});


for (const chinese of [true, false]) {
    for (const unavailable of [false, true]) {
        test(`input row: chinese=${chinese}, unavailable=${unavailable}`, () => {
            const panels = [];
            function create(type, parent, id) {
                const panel = {type, parent, id, style: {}, children: [],
                    IsValid: () => true, GetChild(index) { return this.children[index]; },
                    SetPanelEvent() {}};
                parent?.children.push(panel);
                panels.push(panel);
                return panel;
            }
            const ctx = vm.createContext({
                $: {CreatePanel: create}, advancedMenuBody: create('Panel', null, ''),
                advancedCopy: (zh, en) => chinese ? zh : en, advancedChinese: () => chinese,
                inputHudUnavailable: unavailable, advancedInputHudButtons: {},
                advancedRefreshInputHudButtons() {}, advancedStyleButton() {},
            });
            vm.runInContext(['advancedCreatePanel', 'advancedCreateLabel',
                'advancedCreateSectionLabel', 'advancedCreateButton'].map(fn).join('\n'), ctx);
            const start = source.indexOf('        const inputHudRow =');
            const end = source.indexOf('        const voiceRow =', start);
            vm.runInContext(source.slice(start, end), ctx);
            assert.equal(Object.keys(ctx.advancedInputHudButtons).length, unavailable ? 0 : 4);
            if (unavailable) {
                const notice = panels.find(p => p.text?.includes(chinese ? '该 Demo 缺少玩家键鼠数据' : 'Input data unavailable'));
                assert.ok(notice);
                assert.equal(notice.style.whiteSpace, 'nowrap');
                assert.equal(notice.parent.children.length, 2);
            }
        });
    }
}
