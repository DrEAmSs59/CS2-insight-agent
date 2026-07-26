# 2D replay binary pipeline benchmark

Measured on 2026-07-25 with one 514 MB CS2 Demo (30 rounds, 3,269 seconds of
active round time, 10 players and 4,164 shots). Each frequency used the same
round boundaries and Rust Parquet writer. Timings are local warm-cache results.

## Why the pipeline changed

The former display path was:

```text
Rust Parquet -> pandas DataFrame -> Python dicts -> JSON -> JavaScript objects
```

The new trajectory path is:

```text
Rust Parquet -> fixed binary columns -> HTTP bytes -> JavaScript TypedArrays
```

FastAPI only validates the request and passes Rust-produced bytes through.
Player objects are created lazily for the frames the Canvas actually reads.
Sparse smoke, inferno and event data remain a separate JSON sidecar.

## Results

| Sample rate | Frames | Parquet | Old whole-match JSON | Binary payload | Rust read, all 30 rounds | Warm round p50 / p95 | Largest-round JS decode |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 Hz | 26,157 | 3.21 MiB | 109.7 MiB | 15.94 MiB | 366 ms | 11.5 / 15.9 ms | 0.66 ms |
| 16 Hz | 52,310 | 5.97 MiB | 218.1 MiB | 31.50 MiB | 667 ms | 21.0 / 30.2 ms | 0.29 ms |
| 32 Hz | 104,618 | 11.22 MiB | 435.0 MiB | 62.62 MiB | 1,307 ms | 41.2 / 58.9 ms | 0.71 ms |
| 64 Hz | 209,232 | 21.34 MiB | 868.9 MiB | 124.86 MiB | 3,245 ms | 102.7 / 145.2 ms | 1.28 ms |

The old JSON round path at 32 Hz had an 819 ms median backend-to-JSON time and
could take 2.84 seconds for the longest round. The binary path's corresponding
warm median is 41 ms and its longest observed read was 146 ms. It also avoids
the second full object graph previously estimated at roughly 870 MiB in the
frontend store.

The binary payload is about 63 bytes per player row at every frequency. The
largest 32 Hz round was 7.05 MB and contained 11,904 frames; creating all
TypedArray views took 0.71 ms, while reading players from three arbitrary frames
took 0.14 ms.

## Accuracy trade-off

64 Hz was used as the reference trajectory:

| Sample rate | Alive position error p95 | Yaw error p95 | Shot snap max | Death delay p95 |
| ---: | ---: | ---: | ---: | ---: |
| 8 Hz | 14.43 units | 4.34 degrees | 62.5 ms | 62.5 ms |
| 16 Hz | 6.91 units | 1.67 degrees | 31.25 ms | 31.25 ms |
| 32 Hz | 3.42 units | 0.41 degrees | 15.63 ms | 15.63 ms |
| 64 Hz | 0 | 0 | 15.63 ms | 0 |

32 Hz is therefore the default: it materially improves motion, aim and
event alignment over 8/16 Hz, while using half the trajectory storage and less
than half the Rust read time of 64 Hz. The request contract still accepts up to
64 Hz for future experiments.

## Binary protocol v1

Packets start with `CS2RPL01`, a little-endian version/header-length prefix and
a compact UTF-8 metadata dictionary. The payload is a fixed sequence of aligned
columns:

```text
frame ticks, frame row offsets,
steam id, name id, team, flags, health, armor, money, equipment value,
x, y, z, yaw, flash duration,
inventory id, active weapon id, active weapon name id, player color id
```

Strings are dictionary encoded. Frame offsets map a replay frame to its player
row range without scanning. The version and row/frame bounds are validated
before JavaScript creates any TypedArray view.
