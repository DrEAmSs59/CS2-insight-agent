use crate::entity::field::FieldPath;
use crate::reader::{BitsReader, SliceReader};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FieldOp {
    PlusOne,
    PlusTwo,
    PlusThree,
    PlusFour,
    PlusN,
    PushOneLeftDeltaZeroRightZero,
    PushOneLeftDeltaZeroRightNonZero,
    PushOneLeftDeltaOneRightZero,
    PushOneLeftDeltaOneRightNonZero,
    PushOneLeftDeltaNRightZero,
    PushOneLeftDeltaNRightNonZero,
    PushOneLeftDeltaNRightNonZeroPack6Bits,
    PushOneLeftDeltaNRightNonZeroPack8Bits,
    PushTwoLeftDeltaZero,
    PushTwoPack5LeftDeltaZero,
    PushThreeLeftDeltaZero,
    PushThreePack5LeftDeltaZero,
    PushTwoLeftDeltaOne,
    PushTwoPack5LeftDeltaOne,
    PushThreeLeftDeltaOne,
    PushThreePack5LeftDeltaOne,
    PushTwoLeftDeltaN,
    PushTwoPack5LeftDeltaN,
    PushThreeLeftDeltaN,
    PushThreePack5LeftDeltaN,
    PushN,
    PushNAndNonTopological,
    PopOnePlusOne,
    PopOnePlusN,
    PopAllButOnePlusOne,
    PopAllButOnePlusN,
    PopAllButOnePlusNPack3Bits,
    PopAllButOnePlusNPack6Bits,
    PopNPlusOne,
    PopNPlusN,
    PopNAndNonTopographical,
    NonTopoComplex,
    NonTopoPenultimatePlusOne,
    NonTopoComplexPack4Bits,
    FieldPathEncodeFinish,
}

impl FieldOp {
    #[inline]
    pub(crate) fn execute(&self, r: &mut SliceReader, fp: &mut FieldPath) {
        match self {
            FieldOp::PlusOne => fp.inc_curr(1),
            FieldOp::PlusTwo => fp.inc_curr(2),
            FieldOp::PlusThree => fp.inc_curr(3),
            FieldOp::PlusFour => fp.inc_curr(4),
            FieldOp::PlusN => fp.inc_curr(r.read_ubit_var_fp_unchecked() as u16 + 5),
            FieldOp::PushOneLeftDeltaZeroRightZero => fp.push(0),
            FieldOp::PushOneLeftDeltaZeroRightNonZero => {
                fp.push(r.read_ubit_var_fp_unchecked() as u16)
            }
            FieldOp::PushOneLeftDeltaOneRightZero => {
                fp.inc_curr(1);
                fp.push(0);
            }
            FieldOp::PushOneLeftDeltaOneRightNonZero => {
                fp.inc_curr(1);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushOneLeftDeltaNRightZero => {
                fp.inc_curr(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(0);
            }
            FieldOp::PushOneLeftDeltaNRightNonZero => {
                fp.inc_curr(r.read_ubit_var_fp_unchecked() as u16 + 2);
                fp.push(r.read_ubit_var_fp_unchecked() as u16 + 1);
            }
            FieldOp::PushOneLeftDeltaNRightNonZeroPack6Bits => {
                fp.inc_curr(r.read_bits_unchecked(3) as u16 + 2);
                fp.push(r.read_bits_unchecked(3) as u16 + 1);
            }
            FieldOp::PushOneLeftDeltaNRightNonZeroPack8Bits => {
                fp.inc_curr(r.read_bits_unchecked(4) as u16 + 2);
                fp.push(r.read_bits_unchecked(4) as u16 + 1);
            }
            FieldOp::PushTwoLeftDeltaZero => {
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushTwoPack5LeftDeltaZero => {
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushThreeLeftDeltaZero => {
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushThreePack5LeftDeltaZero => {
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushTwoLeftDeltaOne => {
                fp.inc_curr(1);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushTwoPack5LeftDeltaOne => {
                fp.inc_curr(1);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushThreeLeftDeltaOne => {
                fp.inc_curr(1);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushThreePack5LeftDeltaOne => {
                fp.inc_curr(1);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushTwoLeftDeltaN => {
                fp.inc_curr(r.read_ubit_var() as u16 + 2);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushTwoPack5LeftDeltaN => {
                fp.inc_curr(r.read_ubit_var() as u16 + 2);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushThreeLeftDeltaN => {
                fp.inc_curr(r.read_ubit_var() as u16 + 2);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
                fp.push(r.read_ubit_var_fp_unchecked() as u16);
            }
            FieldOp::PushThreePack5LeftDeltaN => {
                fp.inc_curr(r.read_ubit_var() as u16 + 2);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
                fp.push(r.read_bits_unchecked(5) as u16);
            }
            FieldOp::PushN => {
                let n = r.read_ubit_var() as i32;
                fp.inc_curr(r.read_ubit_var() as u16);
                for _ in 0..n {
                    fp.push(r.read_ubit_var_fp() as u16)
                }
            }
            FieldOp::PushNAndNonTopological => {
                for i in 0..=fp.last {
                    if r.read_bool() {
                        fp.inc(i, r.read_var_i32() as u16 + 1);
                    }
                }
                let count = r.read_ubit_var() as usize;
                for _ in 0..count {
                    fp.push(r.read_ubit_var_fp() as u16)
                }
            }
            FieldOp::PopOnePlusOne => {
                fp.pop(1);
                fp.inc_curr(1);
            }
            FieldOp::PopOnePlusN => {
                fp.pop(1);
                fp.inc_curr(r.read_ubit_var_fp_unchecked() as u16 + 1);
            }
            FieldOp::PopAllButOnePlusOne => {
                fp.pop(fp.last);
                fp.inc(0, 1);
            }
            FieldOp::PopAllButOnePlusN => {
                fp.pop(fp.last);
                fp.inc(0, r.read_ubit_var_fp_unchecked() as u16 + 1);
            }
            FieldOp::PopAllButOnePlusNPack3Bits => {
                fp.pop(fp.last);
                fp.inc(0, r.read_bits_unchecked(3) as u16 + 1);
            }
            FieldOp::PopAllButOnePlusNPack6Bits => {
                fp.pop(fp.last);
                fp.inc(0, r.read_bits_unchecked(6) as u16 + 1);
            }
            FieldOp::PopNPlusOne => {
                fp.pop(r.read_ubit_var_fp_unchecked() as usize);
                fp.inc_curr(1);
            }
            FieldOp::PopNPlusN => {
                fp.pop(r.read_ubit_var_fp_unchecked() as usize);
                fp.inc_curr(r.read_var_i32() as u16);
            }
            FieldOp::PopNAndNonTopographical => {
                fp.pop(r.read_ubit_var_fp_unchecked() as usize);
                for i in 0..=fp.last {
                    if r.read_bool() {
                        fp.inc(i, r.read_var_i32() as u16);
                    }
                }
            }
            FieldOp::NonTopoComplex => {
                for i in 0..=fp.last {
                    if r.read_bool() {
                        fp.inc(i, r.read_var_i32() as u16);
                    }
                }
            }
            FieldOp::NonTopoPenultimatePlusOne => fp.inc(fp.last - 1, 1),
            FieldOp::NonTopoComplexPack4Bits => {
                for i in 0..=fp.last {
                    if r.read_bool() {
                        fp.inc(i, r.read_bits_unchecked(4) as u16);
                        fp.sub(i, 7);
                    }
                }
            }
            FieldOp::FieldPathEncodeFinish => unreachable!(),
        }
    }
}

pub(crate) const FIELD_OPS: [(FieldOp, u32); 40] = [
    (FieldOp::PlusOne, 36271),
    (FieldOp::PlusTwo, 10334),
    (FieldOp::PlusThree, 1375),
    (FieldOp::PlusFour, 646),
    (FieldOp::PlusN, 4128),
    (FieldOp::PushOneLeftDeltaZeroRightZero, 35),
    (FieldOp::PushOneLeftDeltaZeroRightNonZero, 3),
    (FieldOp::PushOneLeftDeltaOneRightZero, 521),
    (FieldOp::PushOneLeftDeltaOneRightNonZero, 2942),
    (FieldOp::PushOneLeftDeltaNRightZero, 560),
    (FieldOp::PushOneLeftDeltaNRightNonZero, 471),
    (FieldOp::PushOneLeftDeltaNRightNonZeroPack6Bits, 10530),
    (FieldOp::PushOneLeftDeltaNRightNonZeroPack8Bits, 251),
    (FieldOp::PushTwoLeftDeltaZero, 0),
    (FieldOp::PushTwoPack5LeftDeltaZero, 0),
    (FieldOp::PushThreeLeftDeltaZero, 0),
    (FieldOp::PushThreePack5LeftDeltaZero, 0),
    (FieldOp::PushTwoLeftDeltaOne, 0),
    (FieldOp::PushTwoPack5LeftDeltaOne, 0),
    (FieldOp::PushThreeLeftDeltaOne, 0),
    (FieldOp::PushThreePack5LeftDeltaOne, 0),
    (FieldOp::PushTwoLeftDeltaN, 0),
    (FieldOp::PushTwoPack5LeftDeltaN, 0),
    (FieldOp::PushThreeLeftDeltaN, 0),
    (FieldOp::PushThreePack5LeftDeltaN, 0),
    (FieldOp::PushN, 0),
    (FieldOp::PushNAndNonTopological, 310),
    (FieldOp::PopOnePlusOne, 2),
    (FieldOp::PopOnePlusN, 0),
    (FieldOp::PopAllButOnePlusOne, 1837),
    (FieldOp::PopAllButOnePlusN, 149),
    (FieldOp::PopAllButOnePlusNPack3Bits, 300),
    (FieldOp::PopAllButOnePlusNPack6Bits, 634),
    (FieldOp::PopNPlusOne, 0),
    (FieldOp::PopNPlusN, 0),
    (FieldOp::PopNAndNonTopographical, 1),
    (FieldOp::NonTopoComplex, 76),
    (FieldOp::NonTopoPenultimatePlusOne, 271),
    (FieldOp::NonTopoComplexPack4Bits, 99),
    (FieldOp::FieldPathEncodeFinish, 25474),
];
