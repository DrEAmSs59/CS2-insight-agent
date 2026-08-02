use crate::entity::field::FieldState;
use crate::HashMap;
use std::rc::Rc;

#[derive(Default)]
pub(crate) struct BaselineContainer {
    pub(crate) baselines: HashMap<i32, Rc<Vec<u8>>>,
    pub(crate) states: HashMap<i32, FieldState>,
}

impl BaselineContainer {
    pub(crate) fn add_baseline(&mut self, id: i32, baseline: Rc<Vec<u8>>) {
        self.baselines.insert(id, baseline);
    }
}
