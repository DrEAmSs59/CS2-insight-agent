const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// VPK inline DATA contains readable stock JavaScript. Exercise the shipped
// speed handler rather than a reimplementation of its pause/resume rules.
for (const template of ['pov_voice_template.vpk', 'pov_advanced_playback_template.vpk']) {
    const source = fs.readFileSync(path.join(__dirname, template)).toString('utf8');
    function extract(name) {
        const start = source.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `missing ${name} in ${template}`);
        const open = source.indexOf('{', start);
        let depth = 1, end = open + 1;
        for (; depth > 0; end++) {
            if (source[end] === '{') depth++;
            if (source[end] === '}') depth--;
            assert.ok(end < source.length);
        }
        return source.slice(start, end);
    }
    test(`${template}: speed slider updates CS2 and unpauses at the selected speed`, () => {
        assert.match(source, /RegisterEventHandler\("SliderValueChanged", speedSlider/);
        const stops = JSON.parse(source.match(/const speedStops = (\[[^;]+\]);/)[1]);
        const calls = [], timescale = {};
        let paused = true;
        const context = {speedStops:stops, timescale,
            $:{Localize:()=> 'Paused'},
            cp:{BHasClass:()=>paused, SetDemoTimeScale:s=>calls.push(s),
                SetPaused:p=>{paused=p;}, SetHasClass:(_,p)=>{paused=p;}}};
        vm.createContext(context);
        vm.runInContext(extract('SpeedToText')+'\n'+extract('SetPlaybackSpeedStop'),context);
        for (const speed of [0.1,0.25,0.5,1,2,4]) {
            context.SetPlaybackSpeedStop(stops.indexOf(speed));
            assert.equal(calls.at(-1),speed);
            assert.equal(paused,false);
            assert.equal(timescale.text,`${speed}x`);
        }
        context.SetPlaybackSpeedStop(0);
        assert.equal(paused,true);
        assert.equal(timescale.text,'Paused');
        context.SetPlaybackSpeedStop(stops.indexOf(1));
        assert.equal(paused,false);
        assert.equal(calls.at(-1),1);
    });
}
