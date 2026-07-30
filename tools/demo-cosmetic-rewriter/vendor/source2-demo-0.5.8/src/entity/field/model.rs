use crate::entity::field::serializer::Serializer;
use crate::entity::field::FieldDecoder;
use std::rc::Rc;

pub(crate) enum FieldModel {
    Value,
    Array,
    ValueVector(FieldDecoder),
    Vector(Rc<Serializer>),
    Pointer(Rc<Serializer>),
}
