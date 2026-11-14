const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'round_banner.js'), 'utf8');
function harness(ends = [100, 500], clockEvents = [], legacy = false) {
    const scheduled = [], callbacks = {};
    let tick = 50, operation = null;
    let time = {roundtime_remaining:54,roundtime:115,hide:false};
    function panel() { return {style:{}, valid:true, classes:new Set(['WinPanelRoot', 'winpanel-basic-round-result-visible']),
        IsValid(){return this.valid}, BHasClass(c){return this.classes.has(c)},
        RemoveClass(c){this.classes.delete(c)}, ClearPropertyFromCode(p){delete this.style[p]}}; }
    let root=panel();
    const timer = {visible:false, IsValid:()=>true};
    const context = {sharedRoundEndTicks:ends,sharedRoundClockEvents:clockEvents,findHudTraverse:id=>id === "TimerText" ? timer : ({IsValid:()=>true,BHasClass:()=>false,GetParent:()=>root}),
        GameStateAPI:{GetTimeDataJSO:()=>time},
        recordingControlOperation:()=>operation === null ? null : {operationId:operation},
        controller:{GetDemoControllerState:()=>({nTick:tick,bIsPaused:true})},
        $:{Schedule:(_, fn)=>scheduled.push(fn),RegisterForUnhandledEvent:(name,fn)=>callbacks[name]=fn,Msg:message=>{throw Error(message)}}};
    if (legacy) delete context.recordingControlOperation;
    vm.runInNewContext(source, context);
    return {update(t,op=operation){tick=t;operation=op;scheduled.shift()()},
        jump(){callbacks.PanoramaGameTimeJumpEvent()},
        show(){root.classes.add('winpanel-basic-round-result-visible')},
        timer:()=>timer,time(value){time=value},
        hidden(){return root.style.opacity==='0'},visible(){return root.classes.has('winpanel-basic-round-result-visible') && root.style.opacity!=='0'},
        rebuild(){root.valid=false;root=panel()},root:()=>root};
}
test('real round_end releases suppression; rewind removes old victory and MVP',()=>{
    const h=harness();h.update(50);assert.ok(h.hidden());h.update(99);h.show();h.update(100);assert.ok(h.visible());
    h.update(30);assert.ok(h.hidden());assert.equal(h.root().classes.has('winpanel-basic-round-result-visible'),false);
    h.update(90);h.show();h.update(100);assert.ok(h.visible());h.update(101);assert.ok(h.visible());
});
test('paused seek without event and spec_player panel recreation remain suppressed',()=>{
    const h=harness();h.update(80);h.show();h.update(100);h.update(40);
    h.rebuild();h.update(40);assert.ok(h.hidden());h.show();h.update(41);assert.ok(h.hidden());
    h.update(99);h.show();h.update(100);assert.ok(h.visible());
});
test('same-tick jump event or new operation clears an already visible banner',()=>{
    for(const via of ['event','operation']) {const h=harness();h.update(80,'a');h.show();h.update(100,'a');assert.ok(h.visible());
        if(via==='event')h.jump();h.update(100,via==='event'?'a':'b');assert.ok(h.hidden());
        for(let t=150;t<500;t+=50)h.update(t);h.show();h.update(500);assert.ok(h.visible());}
});
test('forward seek across round end does not admit a skipped native event',()=>{
    const h=harness();h.update(50);h.show();h.update(200);assert.ok(h.hidden());
    for(let t=250;t<500;t+=50)h.update(t);h.show();h.update(500);assert.ok(h.visible());
});
test('empty round ends and seeking beyond final round never leak stale banners',()=>{
    for(const ends of [[],[100]]) {const h=harness(ends);h.update(200);h.show();h.update(201);assert.ok(h.hidden());}
});

test('rewind restores native clock while planted bomb and round-end retain their own visibility',()=>{
    const h=harness([100,500],[[0,true],[70,false],[100,false],[400,true],[500,false]]);
    h.update(50);assert.equal(h.timer().visible,true);
    h.update(70);assert.equal(h.timer().visible,false);
    h.update(100);h.timer().visible=false;
    h.update(30);assert.equal(h.timer().visible,true);
    h.update(70);assert.equal(h.timer().visible,false);
    h.update(400);assert.equal(h.timer().visible,true);
    h.update(450);h.timer().visible=false;h.update(500);
    assert.equal(h.timer().visible,false); // no override after normal round_end
});
test('landing after round_end keeps clock hidden; landing in next freeze period restores it',()=>{
    const h=harness([100,500],[[0,true],[100,false],[400,true],[500,false]]);
    h.update(150);assert.equal(h.timer().visible,false);
    h.update(400);assert.equal(h.timer().visible,true);
});

test('stock timer uses authoritative time after rewind and stays paused until game time changes',()=>{
    const h=harness([100,500],[[0,true,false],[100,false,false],[400,true,true],[430,true,false]]);
    h.update(30);assert.equal(h.timer().text,'0:55');
    h.update(30);assert.equal(h.timer().text,'0:55');
    h.time({roundtime_remaining:53,roundtime:115});h.update(31);assert.equal(h.timer().text,'0:54');
    h.time({roundtime_remaining:136,roundtime:115});h.update(400);assert.equal(h.timer().text,'0:22');
    h.time({roundtime_remaining:115,roundtime:115});h.update(429);assert.equal(h.timer().text,'0:01');
    h.time({roundtime_remaining:114,roundtime:115});h.update(430);assert.equal(h.timer().text,'1:55');
    h.time({roundtime_remaining:53,roundtime:115,hide:true});h.update(431);assert.equal(h.timer().visible,false);
});

test('legacy OBS and killfeed-only context run without a recording controller',()=>{
    const h=harness([100,500],[[0,true,false],[100,false,false]],true);
    h.update(50);assert.ok(h.hidden());assert.equal(h.timer().text,'0:55');
    h.show();h.update(100);assert.ok(h.visible());
    h.update(30);assert.ok(h.hidden());assert.equal(h.timer().visible,true);
});
