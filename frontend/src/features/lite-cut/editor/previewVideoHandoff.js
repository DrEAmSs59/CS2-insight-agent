function normalizedDescriptor(identity, streamUrl) {
  const url = String(streamUrl || "");
  return url ? { identity: String(identity || ""), streamUrl: url } : null;
}

export function createPreviewVideoHandoff(identity, streamUrl) {
  const descriptor = normalizedDescriptor(identity, streamUrl);
  return {
    targetIdentity: String(identity || ""),
    activeIndex: 0,
    outgoingIndex: null,
    pending: false,
    slots: [descriptor, null],
  };
}

/**
 * Rotate between two persistent media elements without unmounting the frame
 * that is currently visible.  If another switch arrives while an incoming
 * source is still loading, reuse that incoming slot and continue holding the
 * last source that was actually presented.
 */
export function advancePreviewVideoHandoff(state, identity, streamUrl) {
  const targetIdentity = String(identity || "");
  const descriptor = normalizedDescriptor(targetIdentity, streamUrl);
  const activeDescriptor = state?.slots?.[state.activeIndex] || null;
  if (
    state
    && state.targetIdentity === targetIdentity
    && String(activeDescriptor?.streamUrl || "") === String(descriptor?.streamUrl || "")
  ) return state;

  if (!descriptor) return createPreviewVideoHandoff(targetIdentity, "");
  if (!state || !activeDescriptor) return createPreviewVideoHandoff(targetIdentity, descriptor.streamUrl);

  const keepPendingOutgoing = Boolean(
    state.pending
    && state.outgoingIndex != null
    && state.slots[state.outgoingIndex],
  );
  const outgoingIndex = keepPendingOutgoing ? state.outgoingIndex : state.activeIndex;
  const incomingIndex = keepPendingOutgoing ? state.activeIndex : 1 - state.activeIndex;
  const slots = [...state.slots];
  slots[incomingIndex] = descriptor;

  return {
    targetIdentity,
    activeIndex: incomingIndex,
    outgoingIndex,
    pending: true,
    slots,
  };
}

export function completePreviewVideoHandoff(state, identity) {
  if (!state?.pending || state.targetIdentity !== String(identity || "")) return state;
  const slots = [...state.slots];
  if (state.outgoingIndex != null && state.outgoingIndex !== state.activeIndex) {
    slots[state.outgoingIndex] = null;
  }
  return {
    ...state,
    outgoingIndex: null,
    pending: false,
    slots,
  };
}

export function previewVideoSlotVisible(state, index) {
  if (!state?.slots?.[index]) return false;
  return state.pending ? state.outgoingIndex === index : state.activeIndex === index;
}
