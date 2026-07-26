import { describe, expect, it } from "vitest";
import { decodeReplayBinary } from "./replayBinary";
import { interpolateReplayFrame } from "./replayPlayback";

const encoder = new TextEncoder();

function packetFixture() {
  const strings = [
    "",
    "Alpha",
    "[\"AK-47\",\"Smoke Grenade\"]",
    "AK-47",
    "blue",
    "Bravo",
    "[\"M4A1-S\"]",
    "M4A1-S",
    "green",
  ];
  const metadata = {
    fps: 8,
    pov_steamid64: "1",
    pov_player_name: "Alpha",
    strings,
    frame_count: 2,
    row_count: 4,
    shots: [{ tick: 108, actor: "Alpha", weapon: "ak47" }],
    effect_tracks: [{ id: "smoke:1", type: "smoke", start_tick: 100, end_tick: 140, samples: [] }],
    cache: { frames: "parquet_binary_hit", parsed: false },
    effects_pending: false,
  };
  const header = encoder.encode(JSON.stringify(metadata));
  const output = [];
  const align = (boundary) => {
    while (output.length % boundary) output.push(0);
  };
  const write = (size, setter, value) => {
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    view[setter](0, value, true);
    output.push(...new Uint8Array(buffer));
  };
  const writeArray = (values, size, setter, boundary = size) => {
    align(boundary);
    for (const value of values) write(size, setter, value);
  };
  output.push(...encoder.encode("CS2RPL01"));
  write(2, "setUint16", 1);
  write(2, "setUint16", 0);
  write(4, "setUint32", header.length);
  output.push(...header);
  writeArray([100, 108], 4, "setInt32");
  writeArray([0, 2, 4], 4, "setUint32");
  writeArray([1n, 2n, 1n, 2n], 8, "setBigUint64", 8);
  writeArray([1, 5, 1, 5], 4, "setUint32");
  writeArray([2, 3, 2, 3], 1, "setInt8");
  writeArray([1 | 2 | 8, 1 | 2 | 4, 1 | 2 | 8, 1 | 2 | 4], 1, "setUint8");
  writeArray([100, 100, 95, 100], 2, "setUint16", 2);
  writeArray([100, 100, 90, 100], 2, "setUint16", 2);
  writeArray([2500, 2000, 2500, 2000], 4, "setInt32");
  writeArray([4700, 4200, 4700, 4200], 4, "setInt32");
  writeArray([0, 10, 80, 90], 4, "setFloat32");
  writeArray([0, 10, 40, 50], 4, "setFloat32");
  writeArray([0, 0, 10, 0], 4, "setFloat32");
  writeArray([359, 180, 1, 180], 4, "setFloat32");
  writeArray([0, 0, 0, 0], 4, "setFloat32");
  writeArray([2, 6, 2, 6], 4, "setUint32");
  writeArray([0, 0, 0, 0], 4, "setUint32");
  writeArray([3, 7, 3, 7], 4, "setUint32");
  writeArray([4, 8, 4, 8], 4, "setUint32");
  return new Uint8Array(output).buffer;
}

describe("decodeReplayBinary", () => {
  it("keeps the replay columnar and exposes lazy array-compatible frames", () => {
    const packet = packetFixture();
    const decoded = decodeReplayBinary(packet);

    expect(Array.isArray(decoded.frames)).toBe(true);
    expect(decoded.frames.isBinaryReplayFrames).toBe(true);
    expect(decoded.frames.binaryByteLength).toBe(packet.byteLength);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0].players[0]).toMatchObject({
      steamid64: "1",
      name: "Alpha",
      team: "T",
      inventory: ["AK-47", "Smoke Grenade"],
      weapon: "AK-47",
      has_c4: true,
      is_pov: true,
      is_teammate: true,
      slot_color_index: 0,
    });
    expect(decoded.frames[0].players[1]).toMatchObject({
      name: "Bravo",
      team: "CT",
      is_teammate: false,
      has_defuser: true,
      slot_color_index: 1,
    });
    expect(decoded.frames[1].shots).toEqual([
      { tick: 108, actor: "Alpha", weapon: "ak47" },
    ]);
    expect(decoded.effect_tracks).toEqual([
      expect.objectContaining({ id: "smoke:1", type: "smoke" }),
    ]);
    expect(decoded.effects_pending).toBe(false);
  });

  it("works with the existing interpolation helpers without materializing the round", () => {
    const { frames } = decodeReplayBinary(packetFixture());
    const middle = interpolateReplayFrame(frames, 104);
    expect(middle.players[0].x).toBeCloseTo(40, 5);
    expect(middle.players[0].y).toBeCloseTo(20, 5);
    expect(middle.players[0].yaw).toBeCloseTo(0, 5);
  });

  it("rejects unknown packets", () => {
    expect(() => decodeReplayBinary(new Uint8Array(16).buffer)).toThrow(/未知回放二进制格式/);
  });
});
