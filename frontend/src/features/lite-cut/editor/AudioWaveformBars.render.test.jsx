import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AudioWaveformBars, { clearWaveformMemoryCache } from "./AudioWaveformBars.jsx";

function response(start, end) {
  return {
    ok: true,
    json: async () => ({ start_sec: start, end_sec: end, peaks: Array.from({ length: 32 }, () => 0.5) }),
  };
}

describe("AudioWaveformBars request scheduling", () => {
  beforeEach(() => {
    clearWaveformMemoryCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms one source before requesting its remaining visible tiles", async () => {
    let resolveFirst;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(response(10, 20));
    vi.stubGlobal("fetch", fetch);

    render(<>
      <AudioWaveformBars sourceUrl="/api/lite-cut/assets/12/stream" bars={32} startSec={0} endSec={10} />
      <AudioWaveformBars sourceUrl="/api/lite-cut/assets/12/stream" bars={32} startSec={10} endSec={20} />
    </>);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveFirst(response(0, 10));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
