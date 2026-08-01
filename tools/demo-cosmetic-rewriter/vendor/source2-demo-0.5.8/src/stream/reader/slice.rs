use crate::stream::bits::BitsReader;
use bitter::BitReader;

const UBIT_VAR_BIT_COUNTS: [u8; 4] = [0, 4, 8, 28];
const UBIT_VAR_FIELDPATH_BIT_COUNTS: [u8; 5] = [2, 4, 10, 17, 31];
const NORMAL_RESOLUTION_FACTOR: f32 = 1.0 / ((1 << 11) - 1) as f32;
const COORDINATE_RESOLUTION_FACTOR: f32 = 1.0 / (1 << 5) as f32;

#[doc(hidden)]
pub struct SliceReader<'a> {
    pub(crate) source_buffer: &'a [u8],
    pub(crate) bit_reader: bitter::LittleEndianReader<'a>,
    pub(crate) string_buffer: [u8; 512],
    pub(crate) source_offset: usize,
}

impl<'a> SliceReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        SliceReader {
            source_buffer: data,
            bit_reader: bitter::LittleEndianReader::new(data),
            string_buffer: [0; 512],
            source_offset: 0,
        }
    }

    #[inline]
    pub(crate) fn skip_bits(&mut self, mut amount: u32) {
        while amount > 0 {
            self.refill();
            let chunk = amount.min(32);
            self.read_bits_unchecked(chunk);
            amount -= chunk;
        }
    }

    #[inline]
    pub(crate) fn skip_bytes(&mut self, amount: u32) {
        self.skip_bits(amount * 8);
    }

    #[inline]
    pub(crate) fn read_bytes_into(&mut self, amount: u32, bytes: &mut Vec<u8>) {
        bytes.resize(amount as usize, 0);
        self.bit_reader.read_bytes(bytes);
    }

    #[inline]
    pub(crate) fn skip_cstring(&mut self) {
        self.refill();
        loop {
            let byte = self.read_bits_unchecked(8) as u8;
            if byte == 0 {
                return;
            }
            if self.bit_reader.lookahead_bits() < 8 {
                self.refill();
            }
        }
    }
}

impl<'a> BitsReader for SliceReader<'a> {
    #[inline]
    #[cfg(not(feature = "unsafe"))]
    fn refill(&mut self) {
        self.bit_reader.refill_lookahead();
    }

    #[inline]
    #[cfg(feature = "unsafe")]
    fn refill(&mut self) {
        #[cfg(debug_assertions)]
        self.bit_reader.refill_lookahead();
        #[cfg(not(debug_assertions))]
        unsafe {
            self.bit_reader.refill_lookahead_unchecked();
        }
    }

    #[inline]
    fn read_bits(&mut self, amount: u32) -> u32 {
        self.refill();
        self.read_bits_unchecked(amount)
    }

    #[inline(always)]
    fn read_bits_unchecked(&mut self, amount: u32) -> u32 {
        debug_assert!(amount <= 32);
        debug_assert!(self.bit_reader.has_bits_remaining(amount as usize));
        let x = self.bit_reader.peek(amount);
        self.bit_reader.consume(amount);
        x as u32
    }

    #[inline]
    fn read_bytes(&mut self, amount: u32) -> Vec<u8> {
        let mut bytes = vec![0; amount as usize];
        self.bit_reader.read_bytes(&mut bytes);
        bytes
    }

    #[inline]
    fn read_bool(&mut self) -> bool {
        self.read_bits_unchecked(1) != 0
    }

    #[inline]
    fn read_f32(&mut self) -> f32 {
        f32::from_bits(self.read_bits(32))
    }

    #[inline]
    fn read_var_u32(&mut self) -> u32 {
        let mut x: u32 = 0;
        let mut shift: u32 = 0;
        let mut byte: u8;

        self.refill();

        loop {
            byte = self.read_bits_unchecked(8) as u8;

            x |= ((byte & 0x7F) as u32) << shift;
            shift += 7;

            if (byte & 0x80) == 0 || shift == 35 {
                return x;
            }
        }
    }

    #[inline]
    fn read_var_u64(&mut self) -> u64 {
        let mut x: u64 = 0;
        let mut shift: u8 = 0;
        let mut byte: u8;
        loop {
            if self.bit_reader.lookahead_bits() < 8 {
                self.refill();
            }

            byte = self.read_bits_unchecked(8) as u8;

            x |= (byte as u64 & 0x7F) << shift;
            shift += 7;

            if (byte & 0x80) == 0 {
                return x;
            }
        }
    }

    #[inline]
    fn read_var_i32(&mut self) -> i32 {
        let ux = self.read_var_u32() as i32;
        if ux & 1 != 0 {
            return !(ux >> 1);
        }
        ux >> 1
    }

    #[inline]
    fn read_ubit_var(&mut self) -> u32 {
        self.refill();
        let a = self.read_bits_unchecked(6);
        let b = a >> 4;
        if a == 0 {
            return b;
        }
        (a & 15) | (self.read_bits_unchecked(UBIT_VAR_BIT_COUNTS[b as usize] as u32) << 4)
    }

    #[inline]
    fn read_ubit_var_fp(&mut self) -> i32 {
        let mut i: u8 = 0;
        self.refill();
        while i < 4 && !self.read_bool() {
            i += 1
        }
        self.read_bits_unchecked(UBIT_VAR_FIELDPATH_BIT_COUNTS[i as usize] as u32) as i32
    }

    #[inline]
    fn read_ubit_var_fp_unchecked(&mut self) -> i32 {
        let mut i: u8 = 0;
        while i < 4 && !self.read_bool() {
            i += 1
        }
        self.read_bits_unchecked(UBIT_VAR_FIELDPATH_BIT_COUNTS[i as usize] as u32) as i32
    }

    #[inline]
    fn read_normal(&mut self) -> f32 {
        let is_neg = self.read_bool();
        let len = self.read_bits_unchecked(11) as f32;
        let normal = len * NORMAL_RESOLUTION_FACTOR;
        match is_neg {
            true => -normal,
            false => normal,
        }
    }

    #[inline]
    fn read_normal_vec3(&mut self) -> [f32; 3] {
        self.refill();
        let mut vec = [0.0f32; 3];
        let x = self.read_bool();
        let y = self.read_bool();
        vec[0] = match x {
            true => self.read_normal(),
            false => vec[0],
        };
        vec[1] = match y {
            true => self.read_normal(),
            false => vec[1],
        };
        vec[2] = match (vec[0] * vec[0] + vec[1] * vec[1]) as f64 {
            x if x < 1.0 => (1.0 - x).sqrt() as f32,
            _ => vec[2],
        };
        vec[2] = match self.read_bool() {
            true => -vec[2],
            false => vec[2],
        };
        vec
    }

    #[inline]
    fn read_u64_le(&mut self) -> u64 {
        self.bit_reader.read_u64().unwrap()
    }

    #[inline]
    fn read_cstring(&mut self) -> String {
        let mut i = 0;
        let mut byte: u8;
        self.refill();
        loop {
            byte = self.read_bits_unchecked(8) as u8;

            if byte == 0 {
                return String::from_utf8_lossy(&self.string_buffer[..i]).into_owned();
            }

            self.string_buffer[i] = byte;
            i += 1;

            if self.bit_reader.lookahead_bits() < 8 {
                self.refill();
            }
        }
    }

    #[inline]
    fn read_coordinate(&mut self) -> f32 {
        self.refill();

        let mut value = 0f32;

        let mut int_val = self.read_bits_unchecked(1);
        let mut fract_val = self.read_bits_unchecked(1);

        if int_val != 0 || fract_val != 0 {
            let signbit = self.read_bits_unchecked(1);

            if int_val != 0 {
                int_val = self.read_bits_unchecked(14) + 1;
            }

            if fract_val != 0 {
                fract_val = self.read_bits_unchecked(5);
            }

            value = (int_val as f32) + (fract_val as f32) * COORDINATE_RESOLUTION_FACTOR;

            if signbit == 1 {
                value = -value;
            }
        }
        value
    }

    #[inline]
    fn read_angle(&mut self, n: u32) -> f32 {
        (self.read_bits(n) as f32) * 360.0 / (1 << n) as f32
    }

    #[inline]
    fn read_bits_as_bytes(&mut self, n: u32) -> Vec<u8> {
        let bits = n % 8;
        let mut tmp = vec![0; (n >> 3) as usize];
        self.bit_reader.read_bytes(&mut tmp);
        if bits > 0 {
            tmp.push(self.read_bits(bits) as u8);
        }
        tmp
    }

    #[inline]
    fn remaining_bytes(&self) -> usize {
        self.bit_reader.bytes_remaining()
    }

    #[inline]
    fn seek(&mut self, offset: usize) {
        assert!(offset <= self.source_buffer.len());
        self.bit_reader = bitter::LittleEndianReader::new(&self.source_buffer[offset..]);
        self.source_offset = offset;
    }
}
