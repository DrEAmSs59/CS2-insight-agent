mod decoder;
mod encoder;
mod model;
mod path;
mod properties;
mod serializer;
mod state;
mod r#type;
mod value;

pub(crate) use decoder::*;
pub(crate) use encoder::*;
pub(crate) use model::*;
pub(crate) use path::*;
pub(crate) use properties::*;
pub(crate) use r#type::*;
pub(crate) use serializer::*;
pub(crate) use state::*;
pub use value::*;

use std::rc::Rc;

pub(crate) struct Field {
    pub(crate) var_name: Box<str>,
    pub(crate) send_node: Option<Rc<str>>,
    pub(crate) field_type: Rc<FieldType>,
    pub(crate) model: FieldModel,

    pub(crate) decoder: FieldDecoder,
}

impl Field {
    pub(crate) fn append_name(&self, name: &mut String) {
        if let Some(send_node) = self
            .send_node
            .as_deref()
            .filter(|send_node| !send_node.is_empty())
        {
            name.push_str(send_node);
            name.push('.');
        }
        name.push_str(&self.var_name);
    }

    pub(crate) fn name_match_len(&self, name: &str, offset: usize) -> Option<usize> {
        if let Some(send_node) = self
            .send_node
            .as_deref()
            .filter(|send_node| !send_node.is_empty())
        {
            let mut len = 0;
            if name[offset..].starts_with(send_node) {
                len += send_node.len();
                if name.as_bytes().get(offset + len) == Some(&b'.') {
                    len += 1;

                    if name[offset + len..].starts_with(self.var_name.as_ref()) {
                        return Some(len + self.var_name.len());
                    }
                }
            }
        }

        if name[offset..].starts_with(self.var_name.as_ref()) {
            return Some(self.var_name.len());
        }

        None
    }

    pub(crate) fn get_paths(&self, fp: &mut FieldPath, st: &FieldState) -> Vec<FieldPath> {
        let mut field_paths: Vec<FieldPath> = vec![];
        match &self.model {
            FieldModel::Value => {
                field_paths.push(*fp);
            }
            FieldModel::Array | FieldModel::ValueVector(_) => {
                if let Some(s) = st.get_state(fp) {
                    fp.last += 1;
                    for i in 0..s.children().len() {
                        fp.path[fp.last] = i as u16;
                        field_paths.push(*fp);
                    }
                    fp.last -= 1;
                }
            }
            FieldModel::Vector(serializer) => {
                if let Some(x) = st.get_state(fp) {
                    fp.last += 2;
                    for i in 0..x.children().len() {
                        fp.path[fp.last - 1] = i as u16;
                        field_paths.extend(serializer.get_paths(fp, st));
                    }
                    fp.last -= 2;
                }
            }
            FieldModel::Pointer(serializer) => {
                if st.get_state(fp).is_some() {
                    fp.last += 1;
                    field_paths.extend(serializer.get_paths(fp, st));
                    fp.last -= 1;
                }
            }
        }
        field_paths
    }
}
