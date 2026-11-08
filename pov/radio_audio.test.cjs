const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'radio_audio.js'), 'utf8');
let next, team = 2, player = 'a', state = {}, throws = false, povActive = true;
const commands = [];
vm.runInNewContext(source, {
  controller: { GetDemoControllerState: () => state },
  currentPovXuid: () => player,
  advancedPovVisualsActive: () => povActive,
  GameStateAPI: { GetPlayerTeamNumber: (xuid) => { assert.equal(xuid, player); if (throws) throw Error('seek'); return team; } },
  GameInterfaceAPI: { ConsoleCommand: (cmd) => commands.push(cmd) },
  $: { Schedule: (_, fn) => { next = fn; } },
});
const expect = (value) => assert.equal(commands.at(-1), `snd_op_test_convar ${value}`);
expect(0); next(); expect(2);
const count = commands.length; next(); assert.equal(commands.length, count);
player='victim'; team=3; next(); expect(3); // Enemy POV replay.
team=2; next(); expect(2); // Same player after half-time/seek.
throws=true; next(); expect(0); // Never retain a stale team after failure.
throws=false; team=3; next(); expect(3);
state=null; next(); expect(0);
state={}; team=1; next(); expect(0);
povActive=false; next(); expect(-1); // Ordinary spectator HUD restores both teams.
state=null; throws=true; next(); expect(-1); // Bypass does not depend on a valid POV.
povActive=true; next(); expect(0); // Unknown POV must not retain bypass.
state={}; throws=false; team=2; next(); expect(2);
povActive=false; next(); expect(-1);
povActive=true; team=3; next(); expect(3);
console.log('radio_audio: POV switch, HUD switch, side swap, seek failure and idle passed');
