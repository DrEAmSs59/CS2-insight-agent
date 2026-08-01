use crate::stream::bits::BitsWriter;
use bitter::{BitWriter, LittleEndianWriter};
use std::io;

const UBIT_VAR_BIT_COUNTS: [u8; 4] = [0, 4, 8, 28];
const UBIT_VAR_FIELDPATH_BIT_COUNTS: [u8; 5] = [2, 4, 10, 17, 31];
const COORDINATE_RESOLUTION_FACTOR: f32 = 1.0 / (1 << 5) as f32;
const NORMAL_DENOMINATOR: u32 = (1 << 11) - 1;
const NORMAL_RESOLUTION_FACTOR: f32 = 1.0 / NORMAL_DENOMINATOR as f32;

#[doc(hidden)]
pub struct BitstreamWriter<'a> {
    pub(crate) bit_writer: LittleEndianWriter<&'a mut Vec<u8>>,
}

impl<'a> BitstreamWriter<'a> {
    pub fn new(buffer: &'a mut Vec<u8>) -> Self {
        Self {
            bit_writer: LittleEndianWriter::new(buffer),
        }
    }
}

impl BitsWriter for BitstreamWriter<'_> {
    #[inline]
    fn flush(&mut self) -> io::Result<()> {
        BitWriter::flush(&mut self.bit_writer)
    }

    #[inline]
    fn write_bits(&mut self, amount: u32, value: u64) -> io::Result<()> {
        BitWriter::write_bits(&mut self.bit_writer, amount, value)
    }

    #[inline]
    fn write_bits_unchecked(&mut self, amount: u32, value: u64) -> io::Result<()> {
        BitWriter::write_bits(&mut self.bit_writer, amount, value)
    }

    #[inline]
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        BitWriter::write_bytes(&mut self.bit_writer, bytes)
    }

    #[inline]
    fn write_bit(&mut self, value: bool) -> io::Result<()> {
        self.write_bits(1, value as u64)
    }

    #[inline]
    fn write_f32(&mut self, value: f32) -> io::Result<()> {
        self.write_bits(32, value.to_bits() as u64)
    }

    #[inline]
    fn write_var_u32(&mut self, value: u32) -> io::Result<()> {
        self.write_var_u64(value as u64)
    }

    #[inline]
    fn write_var_i32(&mut self, value: i32) -> io::Result<()> {
        let encoded = if value < 0 {
            (!(value as u32) << 1) | 1
        } else {
            (value as u32) << 1
        };
        self.write_var_u32(encoded)
    }

    #[inline]
    fn write_var_u64(&mut self, mut value: u64) -> io::Result<()> {
        loop {
            let mut byte = (value & 0x7F) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            self.write_bits(8, byte as u64)?;
            if value == 0 {
                return Ok(());
            }
        }
    }

    #[inline]
    fn write_ubit_var(&mut self, value: u32) -> io::Result<()> {
        let low = value & 0x0F;

        if value < (1 << 4) {
            self.write_bits(6, low as u64)?;
            return Ok(());
        }

        let bucket = if value < (1 << 8) {
            1
        } else if value < (1 << 12) {
            2
        } else {
            3
        };
        self.write_bits(6, ((bucket as u32) << 4 | low) as u64)?;
        self.write_bits(UBIT_VAR_BIT_COUNTS[bucket] as u32, (value >> 4) as u64)?;
        Ok(())
    }

    #[inline]
    fn write_ubit_var_fp(&mut self, value: i32) -> io::Result<()> {
        debug_assert!(
            value >= 0,
            "field-path values are expected to be non-negative"
        );
        let value = value as u32;

        let bucket = if value < (1 << 2) {
            0
        } else if value < (1 << 4) {
            1
        } else if value < (1 << 10) {
            2
        } else if value < (1 << 17) {
            3
        } else {
            4
        };

        match bucket {
            0 => {
                self.write_bit(true)?;
                self.write_bits(UBIT_VAR_FIELDPATH_BIT_COUNTS[bucket] as u32, value as u64)?;
            }
            1 => {
                self.write_bit(false)?;
                self.write_bit(true)?;
                self.write_bits(UBIT_VAR_FIELDPATH_BIT_COUNTS[bucket] as u32, value as u64)?;
            }
            2 => {
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bit(true)?;
                self.write_bits(UBIT_VAR_FIELDPATH_BIT_COUNTS[bucket] as u32, value as u64)?;
            }
            3 => {
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bit(true)?;
                self.write_bits(UBIT_VAR_FIELDPATH_BIT_COUNTS[bucket] as u32, value as u64)?;
            }
            _ => {
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bit(false)?;
                self.write_bits(UBIT_VAR_FIELDPATH_BIT_COUNTS[bucket] as u32, value as u64)?;
            }
        }

        Ok(())
    }

    #[inline]
    fn write_ubit_var_fp_unchecked(&mut self, value: i32) -> io::Result<()> {
        self.write_ubit_var_fp(value)
    }

    #[inline]
    fn write_u64_le(&mut self, value: u64) -> io::Result<()> {
        self.write_bits(64, value)
    }

    #[inline]
    fn write_cstring(&mut self, value: &str) -> io::Result<()> {
        self.write_bytes(value.as_bytes())?;
        self.write_bits(8, 0)?;
        Ok(())
    }

    #[inline]
    fn write_coordinate(&mut self, value: f32) -> io::Result<()> {
        let abs = value.abs();
        let int_val = abs.trunc() as u32;
        let fract_val = ((abs * (1 << 5) as f32) as u32) & ((1 << 5) - 1);

        self.write_bit(int_val != 0)?;
        self.write_bit(fract_val != 0)?;

        if int_val == 0 && fract_val == 0 {
            return Ok(());
        }

        self.write_bit(value <= -COORDINATE_RESOLUTION_FACTOR)?;

        if int_val != 0 {
            self.write_bits(14, (int_val - 1) as u64)?;
        }

        if fract_val != 0 {
            self.write_bits(5, fract_val as u64)?;
        }

        Ok(())
    }

    #[inline]
    fn write_angle(&mut self, value: f32, n: u32) -> io::Result<()> {
        debug_assert!(
            n > 0 && n <= 32,
            "angle bit counts are expected to fit into u32"
        );
        let modulus = 1u128 << n;
        let raw = ((value / 360.0) * modulus as f32) as i128;
        let raw = (raw as u128) & (modulus - 1);
        self.write_bits(n, raw as u64)
    }

    #[inline]
    fn write_normal(&mut self, value: f32) -> io::Result<()> {
        let signbit = value <= -NORMAL_RESOLUTION_FACTOR;
        let len = ((value * NORMAL_DENOMINATOR as f32) as i32)
            .unsigned_abs()
            .min(NORMAL_DENOMINATOR);
        self.write_bit(signbit)?;
        self.write_bits(11, len as u64)
    }

    #[inline]
    fn write_normal_vec3(&mut self, value: [f32; 3]) -> io::Result<()> {
        let x = value[0] >= NORMAL_RESOLUTION_FACTOR || value[0] <= -NORMAL_RESOLUTION_FACTOR;
        let y = value[1] >= NORMAL_RESOLUTION_FACTOR || value[1] <= -NORMAL_RESOLUTION_FACTOR;

        self.write_bit(x)?;
        self.write_bit(y)?;

        if x {
            self.write_normal(value[0])?;
        }
        if y {
            self.write_normal(value[1])?;
        }

        self.write_bit(value[2] <= -NORMAL_RESOLUTION_FACTOR)?;
        Ok(())
    }

    #[inline]
    fn write_bits_as_bytes(&mut self, bytes: &[u8], n: u32) -> io::Result<()> {
        if n == 0 {
            return Ok(());
        }

        let whole = (n / 8) as usize;
        let rem = n % 8;

        if bytes.len() < whole + usize::from(rem > 0) {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "not enough source bytes for requested bit count",
            ));
        }

        for &byte in &bytes[..whole] {
            self.write_bits(8, byte as u64)?;
        }

        if rem > 0 {
            self.write_bits(rem, bytes[whole] as u64)?;
        }

        Ok(())
    }
}
