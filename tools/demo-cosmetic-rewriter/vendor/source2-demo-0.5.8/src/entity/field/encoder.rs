#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum FieldEncoder {
    Coord,
    SimTime,
    RuneTime,
    Normal,
    Fixed64,
    QAnglePitchYaw,
    QAnglePrecise,
}

impl FieldEncoder {
    #[inline]
    pub(crate) fn from_str(s: &str) -> Option<Self> {
        match s {
            "coord" => Some(FieldEncoder::Coord),
            "simtime" => Some(FieldEncoder::SimTime),
            "runetime" => Some(FieldEncoder::RuneTime),
            "normal" => Some(FieldEncoder::Normal),
            "fixed64" => Some(FieldEncoder::Fixed64),
            "qangle_pitch_yaw" => Some(FieldEncoder::QAnglePitchYaw),
            "qangle_precise" => Some(FieldEncoder::QAnglePrecise),
            _ => None,
        }
    }
}
