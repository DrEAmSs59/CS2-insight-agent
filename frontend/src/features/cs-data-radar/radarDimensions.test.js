import { describe, expect, it } from "vitest";
import {
  RADAR_DIMENSIONS,
  averageRadarValue,
  compareToMatchAvg,
  deriveRadarStats,
  formatRadarValue,
  matchAvgRadarValue,
  normalizeRadarValues,
} from "./radarDimensions";

describe("radarDimensions (cs数据图)", () => {
  it("has the six dimensions in order (Multi-kill replaces Impact)", () => {
    expect(RADAR_DIMENSIONS.map((d) => d.key)).toEqual([
      "kpr",
      "survival_rate",
      "adr",
      "kast",
      "multi_kill",
      "rating",
    ]);
    for (const dim of RADAR_DIMENSIONS) {
      expect(dim.maxScore).toBeGreaterThan(0);
      expect(dim.minScore).toBeGreaterThanOrEqual(0);
      expect(dim.name).toBeTruthy();
    }
  });

  it("derives radar stats from workspace player rows", () => {
    const radar = deriveRadarStats({
      kills: 28,
      deaths: 12,
      assists: 7,
      kpr: 0.99,
      dpr: 0.42,
      adr: 101.4,
      kast: 78.2,
      survival_rate: 34.0,
      two_kill_rounds: 6,
      three_kill_rounds: 2,
      rounds: 30,
    });
    expect(radar.kpr).toBe(0.99);
    expect(radar.survival_rate).toBe(0.34); // percent → 0..1
    expect(radar.adr).toBe(101.4);
    expect(radar.kast).toBe(0.78);
    expect(radar.multi_kill).toBeCloseTo((6 + 2) / 30, 2); // multi-kill rounds / rounds
    expect(radar.rating).toBeGreaterThan(0);
  });

  it("zeroes rating when there is no data", () => {
    const radar = deriveRadarStats({});
    expect(Object.keys(radar)).toEqual([
      "kpr",
      "survival_rate",
      "adr",
      "kast",
      "multi_kill",
      "rating",
    ]);
    expect(Object.values(radar).every((v) => v === 0)).toBe(true);
  });

  it("normalizes values against the max-scale (outer blue ring) values", () => {
    // 各维度取“满分刻度的一半”，归一化都应为 0.5
    const radar = {
      kpr: 0.425, // 0.85 * 0.5
      survival_rate: 0.22, // 0.44 * 0.5
      adr: 42.5, // 85 * 0.5
      kast: 0.39, // 0.78 * 0.5
      multi_kill: 0.1, // 0.2 * 0.5
      rating: 0.65, // 1.3 * 0.5
    };
    const norm = normalizeRadarValues(radar);
    expect(norm).toHaveLength(6);
    for (const v of norm) expect(Math.abs(v - 0.5)).toBeLessThan(1e-9);
  });

  it("lets values above the max scale overflow beyond the blue outer ring", () => {
    const radar = {
      kpr: 1.5, // 1.5/0.85 ≈ 1.76 → capped at 1.6
      survival_rate: 0.8, // ≈ 1.82 → 1.6
      adr: 220, // ≈ 2.59 → 1.6
      kast: 1.0, // ≈ 1.28
      multi_kill: 3.0, // 3.0/0.2 = 15 → 1.6
      rating: 2.5, // ≈ 1.92 → 1.6
    };
    const norm = normalizeRadarValues(radar);
    for (const v of norm) expect(v).toBeGreaterThan(1);
    expect(Math.max(...norm)).toBeLessThanOrEqual(1.6);
    expect(norm[0]).toBe(1.6);
    expect(Math.abs(norm[3] - 1.0 / 0.78)).toBeLessThan(1e-9);
  });

  it("computes the average (center red hexagon radius)", () => {
    const radar = {
      kpr: 0.425,
      survival_rate: 0.22,
      adr: 42.5,
      kast: 0.39,
      multi_kill: 0.1,
      rating: 0.65,
    };
    expect(Math.abs(averageRadarValue(radar) - 0.5)).toBeLessThan(1e-3);
  });

  it("formats values with percentages where configured", () => {
    expect(formatRadarValue("kpr", 0.99)).toBe("0.99");
    expect(formatRadarValue("survival_rate", 0.34)).toBe("34%");
    expect(formatRadarValue("kast", 0.78)).toBe("78%");
    expect(formatRadarValue("multi_kill", 0.15)).toBe("15%");
    expect(formatRadarValue("adr", 101.4)).toBe("101.4");
  });

  it("computes the match-average benchmark and comparison", () => {
    const matchAvg = {
      kpr: 0.425,
      survival_rate: 0.22,
      adr: 42.5,
      kast: 0.39,
      multi_kill: 0.1,
      rating: 0.65,
    };
    expect(Math.abs(matchAvgRadarValue(matchAvg) - 0.5)).toBeLessThan(1e-3);
    expect(matchAvgRadarValue(null)).toBeNull();

    const above = { kpr: 0.85, survival_rate: 0.44, adr: 85, kast: 0.78, multi_kill: 0.2, rating: 1.3 };
    const below = { kpr: 0.1, survival_rate: 0.05, adr: 20, kast: 0.2, multi_kill: 0.02, rating: 0.2 };
    expect(compareToMatchAvg(above, matchAvg)).toBe(1);
    expect(compareToMatchAvg(below, matchAvg)).toBe(-1);
    expect(compareToMatchAvg(matchAvg, matchAvg)).toBe(0);
  });
});
