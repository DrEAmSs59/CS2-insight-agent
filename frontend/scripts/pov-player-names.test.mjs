// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("../../pov/voice_hud_injection.js", import.meta.url), "utf8");
const functions = [
  "plainPlayerName", "normalizedOverheadName", "normalizeXuid", "lowerLeftPlayerName",
  "escapeRadioHtml", "radioHtmlSpan", "radioTeamColor", "radioMessageColor",
  "teammateMarkerHtml", "radioEventHtml", "chatEventHtml", "teammateNoticeText",
  "serverEventHtml", "advancedPlayerName",
];

function hud(liveName) {
  // Execute the production functions without booting Panorama's scheduled HUD.
  const context = {
    GameStateAPI: { GetPlayerName: () => liveName },
    $: { Localize: () => "A site", Language: () => "english" },
    radioPlayerColor: () => "#88CEF5",
    localizedRadioMessage: () => "Smoke!",
    advancedPlayback: { byXuid: { "123": { name: "demo fallback" } } },
  };
  const script = functions.map((name) => {
    const match = source.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
    if (!match) throw new Error(`Missing production HUD function: ${name}`);
    return match[0];
  }).join("\n");
  runInNewContext(script, context);
  return context;
}

const decorate = (name) => `<span class='decorated-player-name__controller-name'>${name}</span>`;

describe("CS2 formatted player names", () => {
  test.each(["Rycbar_", "Sec_Wang", "Do myself", "SkyL4rk", "doc"])(
    "renders the reported name %s without engine tags", (name) => {
      const api = hud(decorate(name));
      const event = { xuid: "123", team: 2, kind: 0, location: "BombsiteA", message: "hello", teamOnly: true };
      expect(api.lowerLeftPlayerName(event)).toBe(name);
      expect(api.advancedPlayerName("123")).toBe(name);
      expect(api.normalizedOverheadName(decorate(name))).toBe(name.toLowerCase());
      for (const html of [api.radioEventHtml(event), api.chatEventHtml(event)]) {
        expect(html).toContain(name);
        expect(html).toContain("● ");
        expect(html).not.toContain("decorated-player-name");
        expect(html).not.toContain("&lt;span");
      }
      expect(api.radioEventHtml(event)).toContain("Smoke!");
      expect(api.chatEventHtml(event)).toContain("hello");
      expect(api.serverEventHtml({ ...event, messageKind: 1 })).toContain(`${name} attacked a teammate`);
    },
  );

  test("keeps the clan tag and decodes formatted text exactly once", () => {
    const name = '<span class="decorated-player-name__clan-tag">A&amp;B</span> '
      + decorate("名字 &lt;x&gt; &quot;q&quot; &#39;a&#39; &#x1f600; &amp;lt;");
    const api = hud(name);
    expect(api.plainPlayerName(name)).toBe('A&B 名字 <x> "q" \'a\' 😀 &lt;');
    const html = api.chatEventHtml({ xuid: "123", team: 3, message: "<font>literal</font>" });
    expect(html).toContain("A&amp;B 名字 &lt;x&gt;");
    expect(html).toContain("&amp;lt;");
    expect(html).toContain("&lt;font&gt;literal&lt;/font&gt;");
    expect(html).not.toContain("<x>");
  });

  test.each(["plain name", "<3 玩家", "A &amp; B", "<span>literal</span>"])(
    "preserves legacy plain names verbatim: %s", (name) => {
      const api = hud(name);
      expect(api.plainPlayerName(name)).toBe(name);
      expect(api.lowerLeftPlayerName({ xuid: "123" })).toBe(name);
    },
  );

  test("retains fallbacks when names are empty or the API is unavailable", () => {
    const api = hud(decorate(""));
    expect(api.lowerLeftPlayerName({ xuid: "123", name: "recorded" })).toBe("recorded");
    expect(api.advancedPlayerName("123")).toBe("demo fallback");
    expect(api.lowerLeftPlayerName(null)).toBe("Player");
    api.GameStateAPI.GetPlayerName = () => { throw new Error("unavailable"); };
    expect(api.lowerLeftPlayerName({ xuid: "123", name: "recorded" })).toBe("recorded");
    expect(api.advancedPlayerName("123")).toBe("demo fallback");
  });

  test("invalid numeric entities do not throw or become control characters", () => {
    const api = hud("");
    expect(api.plainPlayerName(decorate("&#0; &#xD800; &#x110000; &unknown;")))
      .toBe("&#0; &#xD800; &#x110000; &unknown;");
  });
});
