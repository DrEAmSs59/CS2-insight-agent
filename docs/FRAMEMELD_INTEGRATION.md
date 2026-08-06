# FrameMeld integration boundary

Insight Agent and FrameMeld are separate programs with separate licenses.

- Insight Agent is licensed under PolyForm Noncommercial 1.0.0.
- FrameMeld is licensed under GPL-3.0-only.
- Insight Agent starts FrameMeld as an external process and exchanges only
  documented command-line arguments, process output, and media files.
- Insight Agent does not import, link, vendor, or derive its implementation
  from FrameMeld source code.
- Interpolation targets, duplicate repair, temporal samples, weighting, and
  motion-blur strength remain exclusively owned and implemented by FrameMeld.

The adapter is implemented in `backend/app/framemeld.py`.  It first looks for
the versioned public protocol:

```text
ffmpeg.exe -framemeld --capabilities-json
```

Protocol identifier: `org.framemeld.cli`; minimum API version: `1`.

Already-built FrameMeld releases currently expose `-blur --help`.  The adapter
accepts that route only as a transitional compatibility interface.  It does
not copy the processing code or policy behind that interface.

## Distribution rules

FrameMeld should normally be downloaded or selected separately by the user.
If a product package also distributes FrameMeld, it must remain a clearly
separate component and include, for that exact FrameMeld version:

1. its GPL-3.0-only license text;
2. copyright notices;
3. the corresponding source code or a GPL-compliant written offer/source link;
4. a separate component directory and version record.

The Insight Agent PolyForm license applies to Insight Agent code, not to the
separately licensed FrameMeld component.  Do not turn FrameMeld into a Python
module, shared library, static library, or private in-process API used by
Insight Agent without a new license review.

This document records the intended engineering and distribution boundary; it
is not legal advice.
