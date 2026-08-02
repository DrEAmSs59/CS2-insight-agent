use crate::entity::field::FieldPath;
use crate::reader::{BitsReader, SliceReader};
use crate::stream::bits::BitsWriter;
use crate::stream::field_path::{FieldOp, FIELD_OPS};
use bitter::BitReader;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::io;
use std::rc::Rc;

const DECODE_TABLE_BITS: u32 = 8;
const DECODE_TABLE_LEN: usize = 1 << DECODE_TABLE_BITS;

#[derive(Clone, Debug)]
pub(crate) struct FieldPathCodec {
    tree: Rc<FieldPathTree>,
    decode_table: Rc<[Option<FieldPathDecodeEntry>; DECODE_TABLE_LEN]>,
}

impl Default for FieldPathCodec {
    fn default() -> Self {
        let tree = Rc::new(FieldPathTree::default());
        Self {
            decode_table: Rc::new(tree.decode_table()),
            tree,
        }
    }
}

impl FieldPathCodec {
    #[inline]
    pub(crate) fn read_op(&self, reader: &mut SliceReader) -> FieldOp {
        reader.refill();
        if reader.bit_reader.lookahead_bits() >= DECODE_TABLE_BITS {
            let bits = reader.bit_reader.peek(DECODE_TABLE_BITS) as usize;
            if let Some(entry) = self.decode_table[bits] {
                reader.bit_reader.consume(entry.bit_len as u32);
                return entry.op;
            }
        }

        let mut node = self.tree.as_ref();
        loop {
            node = if reader.read_bool() {
                node.right()
            } else {
                node.left()
            };
            if let FieldPathTree::Leaf { value, .. } = node {
                return FIELD_OPS[*value as usize].0;
            }
        }
    }

    pub(crate) fn write_op<W: BitsWriter>(&self, writer: &mut W, op: FieldOp) -> io::Result<()> {
        let (code, bit_len) = self
            .tree
            .find_code(op, 0, 0)
            .expect("field-path operation must exist in the Huffman tree");
        writer.write_bits(bit_len, code)
    }

    pub(crate) fn write_transition<W: BitsWriter>(
        &self,
        writer: &mut W,
        from: &FieldPath,
        to: &FieldPath,
    ) -> io::Result<()> {
        if *from == FieldPath::default() {
            let root_increment = u32::from(to.path[0]) + 1;
            if to.last == 0 {
                let op = match root_increment {
                    1 => FieldOp::PlusOne,
                    2 => FieldOp::PlusTwo,
                    3 => FieldOp::PlusThree,
                    4 => FieldOp::PlusFour,
                    _ => FieldOp::PlusN,
                };
                self.write_op(writer, op)?;
                if op == FieldOp::PlusN {
                    writer.write_ubit_var_fp_unchecked((root_increment - 5) as i32)?;
                }
            } else {
                self.write_op(writer, FieldOp::PushN)?;
                writer.write_ubit_var(to.last as u32)?;
                writer.write_ubit_var(root_increment)?;
                for index in 1..=to.last {
                    writer.write_ubit_var_fp(to.path[index].into())?;
                }
            }
            return Ok(());
        }
        match from.last.cmp(&to.last) {
            Ordering::Equal => {
                self.write_op(writer, FieldOp::NonTopoComplex)?;
                for index in 0..=from.last {
                    let delta = i32::from(to.path[index]) - i32::from(from.path[index]);
                    writer.write_bit(delta != 0)?;
                    if delta != 0 {
                        writer.write_var_i32(delta)?;
                    }
                }
            }
            Ordering::Greater => {
                self.write_op(writer, FieldOp::PopNAndNonTopographical)?;
                writer.write_ubit_var_fp_unchecked((from.last - to.last) as i32)?;
                for index in 0..=to.last {
                    let delta = i32::from(to.path[index]) - i32::from(from.path[index]);
                    writer.write_bit(delta != 0)?;
                    if delta != 0 {
                        writer.write_var_i32(delta)?;
                    }
                }
            }
            Ordering::Less => {
                self.write_op(writer, FieldOp::PushNAndNonTopological)?;
                for index in 0..=from.last {
                    let delta = i32::from(to.path[index]) - i32::from(from.path[index]);
                    writer.write_bit(delta != 0)?;
                    if delta != 0 {
                        writer.write_var_i32(delta - 1)?;
                    }
                }
                writer.write_ubit_var((to.last - from.last) as u32)?;
                for index in (from.last + 1)..=to.last {
                    writer.write_ubit_var_fp(to.path[index].into())?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::writer::BitstreamWriter;

    fn round_trip_first_transition(target: FieldPath) -> io::Result<FieldOp> {
        let codec = FieldPathCodec::default();
        let mut encoded = Vec::new();
        let mut writer = BitstreamWriter::new(&mut encoded);
        codec.write_transition(&mut writer, &FieldPath::default(), &target)?;
        codec.write_op(&mut writer, FieldOp::FieldPathEncodeFinish)?;
        writer.flush()?;
        drop(writer);

        let mut reader = SliceReader::new(&encoded);
        let op = codec.read_op(&mut reader);
        let mut decoded = FieldPath::default();
        op.execute(&mut reader, &mut decoded);
        assert_eq!(decoded, target);
        assert_eq!(codec.read_op(&mut reader), FieldOp::FieldPathEncodeFinish);
        Ok(op)
    }

    #[test]
    fn initial_root_transition_uses_wrapping_increment() -> io::Result<()> {
        let mut target = FieldPath::default();
        target.path[0] = 42;
        assert_eq!(round_trip_first_transition(target)?, FieldOp::PlusN);
        Ok(())
    }

    #[test]
    fn initial_nested_transition_uses_push_n() -> io::Result<()> {
        let target = FieldPath {
            path: [3, 5, 7, 0, 0, 0, 0],
            last: 2,
        };
        assert_eq!(round_trip_first_transition(target)?, FieldOp::PushN);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct FieldPathDecodeEntry {
    op: FieldOp,
    bit_len: u8,
}

#[derive(Clone, Debug)]
enum FieldPathTree {
    Leaf {
        weight: u32,
        value: u32,
    },
    Node {
        weight: u32,
        value: u32,
        left: Box<FieldPathTree>,
        right: Box<FieldPathTree>,
    },
}

impl Default for FieldPathTree {
    fn default() -> Self {
        let mut trees = FIELD_OPS
            .iter()
            .map(|(_, weight)| weight)
            .enumerate()
            .map(|(v, &w)| FieldPathTree::Leaf {
                value: v as u32,
                weight: if w == 0 { 1 } else { w },
            })
            .collect::<BinaryHeap<FieldPathTree>>();
        let mut n = 40;
        while let (Some(a), Some(b)) = (trees.pop(), trees.pop()) {
            trees.push(FieldPathTree::Node {
                weight: a.weight() + b.weight(),
                value: n,
                left: a.into(),
                right: b.into(),
            });
            n += 1;
            if trees.len() == 1 {
                break;
            }
        }
        trees.pop().unwrap()
    }
}

impl FieldPathTree {
    fn weight(&self) -> u32 {
        match self {
            FieldPathTree::Leaf { weight, .. } | FieldPathTree::Node { weight, .. } => *weight,
        }
    }
    fn value(&self) -> u32 {
        match self {
            FieldPathTree::Leaf { value, .. } | FieldPathTree::Node { value, .. } => *value,
        }
    }
    fn left(&self) -> &FieldPathTree {
        match self {
            FieldPathTree::Node { left, .. } => left,
            FieldPathTree::Leaf { .. } => unreachable!(),
        }
    }
    fn right(&self) -> &FieldPathTree {
        match self {
            FieldPathTree::Node { right, .. } => right,
            FieldPathTree::Leaf { .. } => unreachable!(),
        }
    }
    fn decode_table(&self) -> [Option<FieldPathDecodeEntry>; DECODE_TABLE_LEN] {
        let mut table = [None; DECODE_TABLE_LEN];
        self.fill_decode_table(&mut table, 0, 0);
        table
    }
    fn fill_decode_table(
        &self,
        table: &mut [Option<FieldPathDecodeEntry>; DECODE_TABLE_LEN],
        code: usize,
        bit_len: u8,
    ) {
        match self {
            FieldPathTree::Leaf { value, .. } => {
                if bit_len as u32 <= DECODE_TABLE_BITS {
                    let mask = if bit_len == 0 {
                        0
                    } else {
                        (1usize << bit_len) - 1
                    };
                    let entry = Some(FieldPathDecodeEntry {
                        op: FIELD_OPS[*value as usize].0,
                        bit_len,
                    });
                    for (bits, slot) in table.iter_mut().enumerate() {
                        if bits & mask == code {
                            *slot = entry;
                        }
                    }
                }
            }
            FieldPathTree::Node { left, right, .. } => {
                left.fill_decode_table(table, code, bit_len + 1);
                right.fill_decode_table(table, code | (1usize << bit_len), bit_len + 1);
            }
        }
    }

    fn find_code(&self, target: FieldOp, code: u64, bit_len: u32) -> Option<(u64, u32)> {
        match self {
            FieldPathTree::Leaf { value, .. } => {
                (FIELD_OPS[*value as usize].0 == target).then_some((code, bit_len))
            }
            FieldPathTree::Node { left, right, .. } => left
                .find_code(target, code, bit_len + 1)
                .or_else(|| right.find_code(target, code | (1_u64 << bit_len), bit_len + 1)),
        }
    }
}

impl PartialEq for FieldPathTree {
    fn eq(&self, other: &Self) -> bool {
        self.weight() == other.weight() && self.value() == other.value()
    }
}
impl Eq for FieldPathTree {}
impl PartialOrd for FieldPathTree {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for FieldPathTree {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.weight().cmp(&other.weight()) {
            Ordering::Equal => self.value().cmp(&other.value()),
            ord => ord.reverse(),
        }
    }
}
