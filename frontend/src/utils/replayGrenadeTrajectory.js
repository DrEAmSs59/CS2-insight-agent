export const MAX_SMOKE_TRAJECTORY_SECONDS = 12;
export const MAX_OTHER_GRENADE_TRAJECTORY_SECONDS = 9;
export const MAX_TRAJECTORY_EVENT_GAP_SECONDS = 2;

export function grenadeTrajectoryTimingIsValid(
  points,
  eventTick,
  tickRate = 64,
  isSmoke = false,
) {
  if (!Array.isArray(points) || points.length < 2) return false;
  const firstTick = Number(points[0]?.tick);
  const lastTick = Number(points.at(-1)?.tick);
  const rate = Math.max(1, Number(tickRate) || 64);
  if (!Number.isFinite(firstTick) || !Number.isFinite(lastTick) || lastTick <= firstTick) {
    return false;
  }
  const maxDuration = rate * (
    isSmoke ? MAX_SMOKE_TRAJECTORY_SECONDS : MAX_OTHER_GRENADE_TRAJECTORY_SECONDS
  );
  if (lastTick - firstTick > maxDuration) return false;

  const landingTick = Number(eventTick);
  if (
    Number.isFinite(landingTick)
    && landingTick > 0
    && Math.abs(lastTick - landingTick) > rate * MAX_TRAJECTORY_EVENT_GAP_SECONDS
  ) {
    return false;
  }
  return true;
}
