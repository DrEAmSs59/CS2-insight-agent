from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel


class RequestType(str, Enum):
    highlight = "highlight"
    fail = "fail"
    timeline_kill = "timeline_kill"
    timeline_death = "timeline_death"
    kill_compilation = "kill_compilation"
    death_compilation = "death_compilation"
    round_compilation = "round_compilation"
    timeline_round = "timeline_round"


class SourceType(str, Enum):
    kill = "kill"
    death = "death"
    round = "round"


class Perspective(str, Enum):
    killer = "killer"
    victim = "victim"
    main = "main"
    round = "round"


class EventType(str, Enum):
    kill = "kill"
    death = "death"


class DemoContext(BaseModel):
    demo_path: str
    demo_filename: str
    map_name: str
    tick_rate: float
    first_tick: int
    demo_end_tick: int
    final_round: int
    final_round_start_tick: int
    final_round_end_tick: int


class TargetPlayer(BaseModel):
    name: str
    steamid64: str


class EventInfo(BaseModel):
    event_type: EventType
    tick: int
    round: int
    killer: TargetPlayer
    victim: TargetPlayer
    target_player: TargetPlayer
    perspective: Perspective


class RoundInfo(BaseModel):
    round: int
    round_start_tick: int
    round_end_tick: Optional[int] = None
    freeze_start_tick: Optional[int] = None
    freeze_end_tick: Optional[int] = None
    next_round_start_tick: Optional[int] = None
    next_round_freeze_start_tick: Optional[int] = None
    next_round_freeze_end_tick: Optional[int] = None
    target_death_tick: Optional[int] = None
    round_end_tick_reliable: bool = True


class RecordingOptions(BaseModel):
    highlight_pre_sec: float = 3.0
    highlight_post_sec: float = 2.0
    kill_jump_cut_threshold_sec: float = 12.0
    timeline_kill_pre_sec: float = 3.0
    timeline_kill_post_sec: float = 2.0
    death_pre_sec: float = 3.0
    death_post_sec: float = 2.0
    kill_compilation_pre_sec: float = 2.0
    kill_compilation_post_sec: float = 1.5
    kill_compilation_jump_cut_threshold_sec: float = 10.0
    death_compilation_pre_sec: float = 2.0
    death_compilation_post_sec: float = 1.5
    death_compilation_merge_gap_sec: float = 2.0
    round_freeze_preroll_sec: float = 3.0
    round_death_post_sec: float = 2.0
    enable_victim_pov: bool = False
    victim_pov_pre_sec: Optional[float] = None   # None = use highlight_pre_sec
    victim_pov_post_sec: float = 1.5
    enable_fail_killer_pov: bool = False
    fail_killer_pre_sec: float = 3.0
    fail_killer_post_sec: float = 2.0
    final_round_guard_sec: float = 4.0
    final_round_seek_guard_sec: float = 2.0
    final_round_min_duration_sec: float = 0.8
    final_round_demo_exit_guard_sec: float = 1.5
    obs_transition_enabled: Optional[bool] = None
    obs_transition_name: Optional[str] = None
    obs_transition_duration_ms: Optional[int] = None


class SourceRef(BaseModel):
    original_clip_id: Optional[str] = None
    timeline_event_id: Optional[str] = None
    queue_item_id: Optional[str] = None
    group_id: Optional[str] = None


class RecordingRequestDTO(BaseModel):
    request_id: str
    request_type: RequestType
    source_type: SourceType
    demo: DemoContext
    target_player: TargetPlayer
    events: list[EventInfo] = []
    rounds: list[RoundInfo] = []
    options: RecordingOptions = RecordingOptions()
    source_ref: SourceRef = SourceRef()


class RecordingSegment(BaseModel):
    segment_index: int
    source_type: SourceType
    start_tick: int
    end_tick: int
    anchor_ticks: list[int] = []
    round: Optional[int] = None
    target_player_name: str
    target_steamid64: str
    perspective: Perspective
    is_final_round: bool = False
    safe_seek_tick: int
    safe_end_tick: Optional[int] = None
    disabled: bool = False
    disabled_reason: Optional[str] = None
    metadata: dict = {}


class RecordingPlan(BaseModel):
    request_id: str
    request_type: RequestType
    demo_path: str
    tick_rate: float
    segments: list[RecordingSegment]
    warnings: list[str] = []
    disabled_segments: list[RecordingSegment] = []
    estimated_duration_sec: float = 0.0

    def model_post_init(self, __context: Any) -> None:
        active = [s for s in self.segments if not s.disabled]
        if active and self.tick_rate > 0:
            total_ticks = sum(s.end_tick - s.start_tick for s in active)
            self.estimated_duration_sec = total_ticks / self.tick_rate
