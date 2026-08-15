import OpenCutTrackTimeline from "./OpenCutTrackTimeline.jsx";

// OpenCut-style timeline surface, backed by LiteCut's existing project store.
export default function LiteCutTimelinePanel(props) {
  return <OpenCutTrackTimeline {...props} />;
}
