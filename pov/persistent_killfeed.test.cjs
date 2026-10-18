const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'persistent_killfeed.js'), 'utf8');
class Panel {
    constructor(parent, id) { this.parent = parent; this.id = id; this.children = []; this.style = {}; this.classes = new Set(); this.valid = true; if (parent) parent.children.push(this); }
    IsValid() { return this.valid; } GetParent() { return this.parent; } Children() { return this.children; }
    FindChildTraverse(id) { return this.children.find(p => p.id === id) || null; }
    BLoadLayoutSnippet(name) { assert.equal(name, 'DeathNotice'); for (const id of ['Attacker', 'Victim', 'Assister', 'Weapon']) new Panel(this, id); return true; }
    SetHasClass(name, value) { if (value) this.classes.add(name); else this.classes.delete(name); }
    AddClass(name) { this.classes.add(name); } SetImage(path) { this.image = path; }
    RemoveAndDeleteChildren() { this.children.forEach(p => p.valid = false); this.children = []; }
    DeleteAsync() { this.valid = false; } ClearPropertyFromCode(name) { delete this.style[name]; }
}
const person = (xuid, name = xuid, team = 2) => ({xuid, name, team, clan:'tag'});
const event = (tick, index, attacker = '76561198386265483') => ({id:tick+':'+index, tick,
    attacker:person(attacker), victim:person('76561198386265484', 'victim', 3), assister:person(''),
    weapon:'ak47', classes:['DeathNoticeHeadShot', 'through-smoke']});
function harness(events, ranges = [[0, 10000]]) {
    let hud = new Panel(null, 'HudDeathNotice'); new Panel(hud, 'VisibleNotices');
    const factory = vm.runInNewContext(source + '\ncreatePersistentKillfeed');
    const api = {findHud:()=>hud, createPanel:(type, parent, id)=>new Panel(parent,id)};
    const control = factory({events, segments:ranges, hide_clan_tags:true,target_xuid:'76561198386265483'},api);
    const rows = () => hud.FindChildTraverse('CS2InsightPersistentNotices')?.Children() || [];
    return { control, rows, update:(tick,xuid='76561198386265483',paused=false)=>control.update({nTick:tick,bIsPaused:paused},xuid),
        visible:()=>hud.FindChildTraverse('CS2InsightPersistentNotices')?.style.visibility === 'visible',
        rebuild() { hud.valid=false; hud=new Panel(null,'HudDeathNotice'); new Panel(hud,'VisibleNotices'); }, hud:()=>hud };
}
test('A/B/A POV changes and replaying old cuts preserve one row per exact DEM event', () => {
    const h=harness([event(10,0),event(10,1),event(1000,2),event(5000,3)]);
    h.update(9); h.update(10); assert.equal(h.rows().length,2); // distinct same-tick kills
    h.update(10,'76561198386265484'); assert.ok(h.rows().every(r=>r.classes.has('DeathNotice_Victim')));
    assert.equal(h.visible(),false);
    assert.ok(h.rows().every(r=>!r.classes.has('DeathNotice_Killer')));
    h.update(10); assert.ok(h.rows().every(r=>r.classes.has('DeathNotice_Killer')));
    assert.equal(h.visible(),true);
    h.update(999); h.update(1000); assert.equal(h.rows().length,3);
    h.update(9);assert.equal(h.rows().length,0);
    h.update(10);assert.equal(h.rows().length,2);
    h.update(999);assert.equal(h.rows().length,2);
    h.update(1000);assert.equal(h.rows().length,3);
    h.rebuild(); h.update(1001); assert.equal(h.rows().length,3);
    assert.ok(h.rows()[0].classes.has('through-smoke'));
    assert.match(h.rows()[0].FindChildTraverse('Weapon').image,/ak47\.vsvg$/);
});
test('skipped ticks, paused warmup and events outside requested cuts are not invented', () => {
    const h=harness([event(10,0),event(500,1),event(1000,2)],[[0,20],[990,1010]]);
    h.update(9); h.update(10,'',true); assert.equal(h.rows().length,0);
    h.update(11); assert.equal(h.rows().length,1);
    h.update(500); assert.equal(h.rows().length,1);
    h.update(999); h.update(1000); assert.equal(h.rows().length,2);
});
test('only protagonist kills survive filtering, even while watching their victim', () => {
    const own=event(10,0), other=event(11,1,'76561198386265485');
    other.assister=person(own.attacker.xuid); // protagonist only assisted
    const death=event(12,2,own.victim.xuid);death.victim=person(own.attacker.xuid);
    const suicide=event(13,3);suicide.victim=person(own.attacker.xuid);
    const h=harness([own,other,death,suicide]);h.update(9,own.victim.xuid);h.update(13,own.victim.xuid);
    assert.equal(h.rows().length,1);
    assert.equal(h.visible(),false);
    assert.ok(h.rows()[0].classes.has('DeathNotice_Victim'));
    h.update(9);h.update(13);assert.equal(h.rows().length,1);
    assert.ok(h.rows()[0].classes.has('DeathNotice_Killer'));
    assert.equal(h.visible(),true);
});
test('victim death cannot reveal the journal by auto-observing the protagonist', () => {
    const own=event(10,0), h=harness([own]);
    h.update(9,own.victim.xuid,true);h.update(10,own.victim.xuid);
    h.update(11,own.attacker.xuid); // engine auto-switch during victim clip
    assert.equal(h.visible(),false);assert.equal(h.rows().length,1);
    h.update(12,own.attacker.xuid,true); // pause precedes OBS Stop/PauseRecord
    assert.equal(h.visible(),false);
    h.update(13,own.attacker.xuid);
    assert.equal(h.visible(),true);assert.equal(h.rows().length,1);
    // Explicit operation identity wins even if the engine pauses on the killer.
    h.control.update({nTick:14,bIsPaused:true},own.attacker.xuid,own.victim.xuid);
    assert.equal(h.visible(),false);
    h.control.update({nTick:15,bIsPaused:false},own.attacker.xuid,own.attacker.xuid);
    assert.equal(h.visible(),true);assert.equal(h.rows().length,1);
});
test('rewinding a five-kill sequence shows only kills reached at the current tick', () => {
    const h=harness(Array.from({length:5},(_,i)=>event((i+1)*10,i)));
    h.update(0);for(let i=1;i<=5;i++){h.update(i*10);assert.equal(h.rows().length,i);}
    h.update(9);assert.equal(h.rows().length,0);
    for(let i=1;i<=5;i++){h.update(i*10);assert.equal(h.rows().length,i);}
    h.update(10,'76561198386265484');assert.equal(h.visible(),false);
    h.update(11,'76561198386265484',true);h.update(20);
    assert.equal(h.visible(),true);assert.equal(h.rows().length,2);
});
test('display limit preserves old events for rewind; a new recording owns a fresh journal', () => {
    const events=Array.from({length:20},(_,i)=>event(i+1,i));const h=harness(events);
    h.update(0); for(let i=1;i<=20;i++)h.update(i);
    assert.equal(h.rows().length,15);h.update(0);h.update(1);assert.equal(h.rows().length,1);
    h.update(20);assert.equal(h.rows().length,15);
    const fresh=harness(events);fresh.update(0);fresh.update(1);assert.equal(fresh.rows().length,1);
    h.control.dispose(); assert.equal(h.hud().FindChildTraverse('VisibleNotices').style.opacity,undefined);
});
test('names are escaped, tags respect the setting, and team colors do not follow the POV', () => {
    const e=event(10,0);e.attacker.name='A<&>';const h=harness([e]);h.update(9);h.update(10);
    const name=h.rows()[0].FindChildTraverse('Attacker');assert.equal(name.text,'A&lt;&amp;&gt;');
    assert.ok(name.classes.has('DeathNoticeTColor'));h.update(10,e.victim.xuid);
    assert.ok(name.classes.has('DeathNoticeTColor'));
});
