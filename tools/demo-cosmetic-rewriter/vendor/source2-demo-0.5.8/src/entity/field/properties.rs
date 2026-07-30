use crate::entity::field::FieldEncoder;

#[derive(Clone, Copy)]
pub(crate) struct FieldProperties {
    pub(crate) encoder: Option<FieldEncoder>,
    pub(crate) encoder_flags: i32,
    pub(crate) bit_count: i32,
    pub(crate) low_value: f32,
    pub(crate) high_value: f32,
}
