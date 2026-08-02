use crate::entity::field::{FieldPath, FieldValue};
use std::rc::Rc;

#[derive(Clone, Debug, Default)]
pub(crate) struct FieldState {
    children: FieldChildren,
    pub(crate) value: Option<FieldValue>,
}

impl FieldState {
    #[inline]
    pub(crate) fn children(&self) -> &[FieldState] {
        self.children.as_slice()
    }

    #[inline]
    pub(crate) fn get_value(&self, fp: &FieldPath) -> Option<&FieldValue> {
        self.get_state(fp).and_then(|x| x.value.as_ref())
    }

    #[inline]
    pub(crate) fn get_state(&self, fp: &FieldPath) -> Option<&FieldState> {
        let mut current_state = self;
        for i in 0..=fp.last {
            current_state = current_state.children().get(fp.path[i] as usize)?;
        }
        Some(current_state)
    }

    #[inline]
    pub(crate) fn set(&mut self, fp: &FieldPath, v: FieldValue) {
        let mut current_state = self;
        for i in 0..=fp.last {
            let index = fp.path[i] as usize;
            let children = current_state.children.make_mut();
            while children.len() <= index {
                children.push(FieldState::default());
            }
            current_state = &mut children[index];
        }
        current_state.value = Some(v);
    }
}

#[derive(Clone, Debug, Default)]
struct FieldChildren {
    shared: Option<Rc<Vec<FieldState>>>,
}

impl FieldChildren {
    #[inline]
    fn as_slice(&self) -> &[FieldState] {
        self.shared
            .as_deref()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    #[inline]
    fn make_mut(&mut self) -> &mut Vec<FieldState> {
        Rc::make_mut(self.shared.get_or_insert_with(|| Rc::new(Vec::new())))
    }
}
