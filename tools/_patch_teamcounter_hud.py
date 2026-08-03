"""Restore stock CSS then apply POV HUD patches (same-length).

- Hide ALL equipinfo (money/guns/nades)
- Keep stock C4 yellow + defuse kit cyan washes
- Do not rewrite shared .healthbar__bg
- Lift #Radar clip:rect only (keep Inner circular border-radius)
- HP bar: keep red underlay; color fill via Ci0..4 on ProgressBarLeft (ammo untouched)
"""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.demo_voice_hud import read_inline_vpk, write_inline_vpk  # noqa: E402

TEAMCOUNTER = "panorama/styles/hud/hudteamcounter.vcss_c"
EQUIPINFO = "panorama/styles/hud/hudteamcounter-equipmentinfo.vcss_c"
HUDRADAR = "panorama/styles/hud/hudradar.vcss_c"
HEALTHAMMO = "panorama/styles/hud/hudhealthammocenter.vcss_c"
STOCK_VPK = Path(r"d:\cs2owndocs\pov_default.vpk")


def _replace_exact(blob: bytes, old: bytes, new: bytes, label: str) -> bytes:
    if len(old) != len(new):
        raise SystemExit(f"{label}: length mismatch {len(old)} vs {len(new)}")
    count = blob.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    return blob.replace(old, new, 1)


def _pad(rule: bytes, total: int) -> bytes:
    if len(rule) > total:
        raise SystemExit(f"{rule!r} too long ({len(rule)} > {total})")
    return rule + (b" " * (total - len(rule)))


def _rule_with_spaces(text: str, needle: str) -> bytes:
    start = text.find(needle)
    if start < 0:
        raise SystemExit(f"missing {needle}")
    end = text.find("}", start) + 1
    while end < len(text) and text[end] == " ":
        end += 1
    return text[start:end].encode("latin1")


def patch_teamcounter(css: bytes) -> bytes:
    """Restore C4/kit washes; JS+CSS hide enemy HP/kit by CT/T panel class."""
    text = css.decode("latin1")

    # Keep AvatarL health stock-ish; no --right assumption (sides flip with team).
    old = _rule_with_spaces(text, ".AvatarL__HealthBar{")
    css = _replace_exact(
        css,
        old,
        _pad(
            b".AvatarL__HealthBar{height:100%;-s2-mix-blend-mode:additive;brightness:10;"
            b"box-shadow:fill 1px 1px 1px #00000080;}",
            len(old),
        ),
        "AvatarL__HealthBar stock wash",
    )

    text = css.decode("latin1")
    old = _rule_with_spaces(text, ".AvatarL__C4{")
    css = _replace_exact(
        css,
        old,
        _pad(
            b".AvatarL__C4{horizontal-align:right;vertical-align:bottom;y:-5px;x:-3px;"
            b"width:16px;height:16px;opacity:1;wash-color:rgb(255,255,95);"
            b"img-shadow:1px 1px 1px 4 black;}",
            len(old),
        ),
        "AvatarL__C4 yellow wash",
    )

    text = css.decode("latin1")
    old = _rule_with_spaces(text, ".AvatarL__DefuseKit{")
    css = _replace_exact(
        css,
        old,
        _pad(
            b".AvatarL__DefuseKit{horizontal-align:right;vertical-align:bottom;"
            b"y:-3px;x:-3px;width:20px;height:20px;opacity:1;"
            b"wash-color:rgb(119,221,255);img-shadow:1px 1px 1px 4 black;}",
            len(old),
        ),
        "AvatarL__DefuseKit cyan wash",
    )

    # Same-length: compress stock white HP fills + hide enemy HP via JS class.
    old_hp = (
        b".Avatar__HealthBar--Red{background-color: white;}"
        b".Avatar__HealthBar--Normal{background-color: white;}"
        b".Avatar__HealthBar--Full{background-color: white;}"
    )
    new_hp = (
        b".Avatar__HealthBar--Red,.Avatar__HealthBar--Normal,.Avatar__HealthBar--Full"
        b"{background-color:#fff;}.CS2InsightPovEnemy .healthbar-container{opacity:0;}"
    )
    if len(old_hp) != len(new_hp):
        raise SystemExit(f"enemy hp css length {len(old_hp)} vs {len(new_hp)}")
    if css.count(old_hp) != 1:
        raise SystemExit(f"enemy hp css expected 1, found {css.count(old_hp)}")
    css = css.replace(old_hp, new_hp, 1)

    old_kit = b".dead .healthbar-container .healthbar__health-number{opacity: 0;}"
    new_kit = (
        b".CS2InsightPovEnemy .AvatarL__DefuseKit,.CS2InsightPovEnemy .AvatarL__C4"
        b"{opacity:0;}"
    )
    new_kit = _pad(new_kit, len(old_kit)) if len(new_kit) <= len(old_kit) else new_kit
    if len(old_kit) != len(new_kit):
        # Fall back: kit only (C4 still hidden by JS).
        new_kit = b".CS2InsightPovEnemy .AvatarL__DefuseKit{opacity:0;}" + (b" " * 14)
    if len(old_kit) != len(new_kit):
        raise SystemExit(f"enemy kit css length {len(old_kit)} vs {len(new_kit)}")
    if css.count(old_kit) != 1:
        raise SystemExit(f"enemy kit css expected 1, found {css.count(old_kit)}")
    return css.replace(old_kit, new_kit, 1)


def patch_equipmentinfo(css: bytes) -> bytes:
    """Stock layout + hide ALL equipment rows (money/guns/nades)."""
    text = css.decode("latin1")
    start = text.find(".SHOW-EQUIPINFO .equipinfo-root{")
    end = text.find(".equipinfo-root .equipinfo__armor--nohelmet")
    if start < 0 or end < 0:
        raise SystemExit("equipmentinfo SHOW span missing")
    old = text[start:end].encode("latin1")
    new = _pad(
        b".SHOW-EQUIPINFO .equipinfo-root{opacity:0;visibility:collapse;}"
        b".equipinfo-root .equipinfo__container{flow-children:down;width:100%;"
        b"padding:0px 2px;padding-top:86px;}"
        b".equipinfo-root .equipinfo__row{height:16px;horizontal-align:center;"
        b"margin:2px 0px;visibility:collapse;}",
        len(old),
    )
    return _replace_exact(css, old, new, "hide all equipinfo")


def patch_hudradar(css: bytes) -> bytes:
    # Only lift #Radar's clip:rect. Keep Inner border-radius + world-blur so
    # the circular radar background stays intact (clearing radius squared it).
    old = b"clip: rect(4px,295px,295px,4px);"
    new = b"overflow:noclip;" + (b" " * 16)  # 32 bytes
    if len(old) != len(new):
        raise SystemExit(f"radar clip length {len(old)} vs {len(new)}")
    if css.count(old) != 1:
        raise SystemExit(f"radar clip expected 1, found {css.count(old)}")
    return css.replace(old, new, 1)


def patch_healthammo(css: bytes) -> bytes:
    # HP fill: white base + no team wash so JS can set teammate hex each tick.
    # (Magenta diagnostic proved this selector is live.) Leave #AmmoClipBar alone.
    old = (
        b".hud-HA-bar{background-color: gradient( linear, 100% 0%, 0% 0%, from( rgba(255,0,0,0.1) ),"
        b"color-stop(0.5, rgba(255,0,0,1)), to( rgba(255,0,0,1)) );brightness: 1;y: -10px;x: -2px;"
        b"border: 1px solid #000000;horizontal-align: right;vertical-align: bottom;}"
        b".hud-HA-bar .ProgressBarLeft{background-color: defaultColor;}"
        b".hud-HA-bar .ProgressBarRight{background-color: rgba(0,0,0,0);}"
        b".hud-HA--on-damage .hud-HA-bar--health .ProgressBarLeft,"
        b".hud-HA--critical .hud-HA-bar--health .ProgressBarLeft{background-color: red;}"
    )
    new = _pad(
        b".hud-HA-bar{background-color:gradient(linear,100% 0%,0% 0%,from(rgba(255,0,0,.1)),"
        b"color-stop(.5,rgba(255,0,0,1)),to(rgba(255,0,0,1)));y:-10px;x:-2px;"
        b"border:1px solid #000;horizontal-align:right;vertical-align:bottom;}"
        b".hud-HA-bar .ProgressBarLeft{background-color:#fff;wash-color:#fff;}"
        b".hud-HA-bar .ProgressBarRight{background-color:#0000;}",
        len(old),
    )
    if css.count(old) != 1:
        raise SystemExit(f"HA bar color block expected 1, found {css.count(old)}")
    return css.replace(old, new, 1)


def restore_stock_css(entries: dict[str, bytes], stock: dict[str, bytes]) -> None:
    for key in (TEAMCOUNTER, EQUIPINFO, HUDRADAR, HEALTHAMMO):
        if key not in stock:
            raise SystemExit(f"stock missing {key}")
        entries[key] = stock[key]


def patch_vpk(path: Path, stock: dict[str, bytes]) -> None:
    entries = read_inline_vpk(path.read_bytes())
    restore_stock_css(entries, stock)
    entries[TEAMCOUNTER] = patch_teamcounter(entries[TEAMCOUNTER])
    entries[EQUIPINFO] = patch_equipmentinfo(entries[EQUIPINFO])
    entries[HUDRADAR] = patch_hudradar(entries[HUDRADAR])
    entries[HEALTHAMMO] = patch_healthammo(entries[HEALTHAMMO])
    path.write_bytes(write_inline_vpk(entries))
    print(f"restored+patched {path}")


def main() -> None:
    if not STOCK_VPK.is_file():
        raise SystemExit(f"missing stock VPK: {STOCK_VPK}")
    stock = read_inline_vpk(STOCK_VPK.read_bytes())
    for rel in ("pov/pov_default.vpk", "pov/pov_voice_template.vpk"):
        patch_vpk(ROOT / rel, stock)


if __name__ == "__main__":
    main()
