//! <https://github.com/ValveSoftware/csgo-demoinfo/blob/master/demoinfogo/demofilebitbuf.cpp>

use super::BitsReader;
use std::io::{Read, Seek, SeekFrom};

#[doc(hidden)]
pub struct SeekableReader<R: Read + Seek> {
    underlying_stream: R,
    read_buffer: Vec<u8>,
    read_position: usize,
    bytes_in_buffer: usize,
    bytes_read_total: usize,
    lookahead_buffer: u64,
    lookahead_bit_count: u32,
    string_buffer: [u8; 512],
}

const BUFFER_SIZE: usize = 65536;

impl<R: Read + Seek> SeekableReader<R> {
    pub fn new(mut stream: R) -> std::io::Result<Self> {
        let mut buffer = vec![0u8; BUFFER_SIZE];
        let buffer_len = stream.read(&mut buffer)?;

        let mut reader = SeekableReader {
            underlying_stream: stream,
            read_buffer: buffer,
            read_position: 0,
            bytes_in_buffer: buffer_len,
            bytes_read_total: 0,
            lookahead_buffer: 0,
            lookahead_bit_count: 0,
            string_buffer: [0; 512],
        };

        reader.refill();
        Ok(reader)
    }

    fn refill_internal_buffer(&mut self) -> std::io::Result<usize> {
        if self.read_position < self.bytes_in_buffer / 2 {
            return Ok(0);
        }

        if self.read_position >= self.bytes_in_buffer {
            let bytes_read = self.underlying_stream.read(&mut self.read_buffer)?;
            self.bytes_in_buffer = bytes_read;
            self.read_position = 0;
            return Ok(bytes_read);
        }

        let remaining = self.bytes_in_buffer - self.read_position;
        if remaining > 0 {
            self.read_buffer
                .copy_within(self.read_position..self.bytes_in_buffer, 0);
        }

        let bytes_read = self
            .underlying_stream
            .read(&mut self.read_buffer[remaining..])?;
        self.bytes_in_buffer = remaining + bytes_read;
        self.read_position = 0;

        Ok(bytes_read)
    }
}

impl<R: Read + Seek> BitsReader for SeekableReader<R> {
    #[inline(always)]
    fn refill(&mut self) {
        unsafe {
            while self.lookahead_bit_count <= 32 {
                if self.read_position < self.bytes_in_buffer {
                    let remaining = self.bytes_in_buffer - self.read_position;

                    if remaining >= 4 {
                        let ptr = self.read_buffer.as_ptr().add(self.read_position) as *const u32;
                        self.lookahead_buffer |=
                            (ptr.read_unaligned().to_le() as u64) << self.lookahead_bit_count;
                        self.lookahead_bit_count += 32;
                        self.read_position += 4;
                        self.bytes_read_total += 4;
                    } else {
                        let byte = *self.read_buffer.get_unchecked(self.read_position);
                        self.lookahead_buffer |= (byte as u64) << self.lookahead_bit_count;
                        self.lookahead_bit_count += 8;
                        self.read_position += 1;
                        self.bytes_read_total += 1;
                    }
                } else {
                    if self.refill_internal_buffer().unwrap_or(0) == 0 {
                        break;
                    }
                }
            }
        }
    }

    #[inline(always)]
    fn read_bits(&mut self, amount: u32) -> u32 {
        if self.lookahead_bit_count < amount {
            self.refill();
        }
        self.read_bits_unchecked(amount)
    }

    #[inline(always)]
    fn read_bits_unchecked(&mut self, amount: u32) -> u32 {
        debug_assert!(amount <= 32);
        debug_assert!(self.lookahead_bit_count >= amount);

        let mask = if amount == 32 {
            u32::MAX
        } else {
            (1u32 << amount) - 1
        };

        let result = (self.lookahead_buffer as u32) & mask;
        self.lookahead_buffer >>= amount;
        self.lookahead_bit_count -= amount;
        result
    }

    #[inline(always)]
    fn read_bytes(&mut self, amount: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; amount as usize];
        let mut bytes_read = 0;

        unsafe {
            while self.lookahead_bit_count >= 8 && bytes_read < amount {
                *bytes.get_unchecked_mut(bytes_read as usize) =
                    (self.lookahead_buffer & 0xFF) as u8;
                self.lookahead_buffer >>= 8;
                self.lookahead_bit_count -= 8;
                bytes_read += 1;
            }

            while bytes_read < amount {
                if self.read_position >= self.bytes_in_buffer
                    && self.refill_internal_buffer().unwrap_or(0) == 0
                {
                    break;
                }

                let available = self.bytes_in_buffer - self.read_position;
                let needed = (amount - bytes_read) as usize;
                let to_copy = available.min(needed);

                if to_copy > 0 {
                    let src = self.read_buffer.as_ptr().add(self.read_position);
                    let dst = bytes.as_mut_ptr().add(bytes_read as usize);
                    std::ptr::copy_nonoverlapping(src, dst, to_copy);
                    self.read_position += to_copy;
                    self.bytes_read_total += to_copy;
                    bytes_read += to_copy as u32;
                } else {
                    break;
                }
            }
        }

        bytes
    }

    #[inline]
    fn read_bool(&mut self) -> bool {
        self.read_bits_unchecked(1) == 1
    }

    #[inline]
    fn read_f32(&mut self) -> f32 {
        f32::from_bits(self.read_bits(32))
    }

    #[inline]
    fn read_var_u32(&mut self) -> u32 {
        let mut x: u32 = 0;
        let mut shift: u32 = 0;

        loop {
            if self.lookahead_bit_count < 8 {
                self.refill();
            }

            let byte = self.read_bits_unchecked(8) as u8;
            x |= ((byte & 0x7F) as u32) << shift;

            if (byte & 0x80) == 0 || shift == 35 {
                return x;
            }

            shift += 7;
        }
    }

    #[inline]
    fn read_var_u64(&mut self) -> u64 {
        let mut x: u64 = 0;
        let mut y: u8 = 0;
        let mut byte: u8;
        loop {
            if self.lookahead_bit_count < 8 {
                self.refill();
            }

            byte = self.read_bits_unchecked(8) as u8;

            x |= (byte as u64 & 0x7F) << y;
            y += 7;

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
        const UBV_COUNT: [u8; 4] = [0, 4, 8, 28];

        self.refill();
        let a = self.read_bits_unchecked(6);
        let b = a >> 4;
        if a == 0 {
            return b;
        }
        (a & 15) | (self.read_bits_unchecked(UBV_COUNT[b as usize] as u32) << 4)
    }

    #[inline]
    fn read_ubit_var_fp(&mut self) -> i32 {
        const UBVFP_COUNT: [u8; 5] = [2, 4, 10, 17, 31];

        let mut i: u8 = 0;
        self.refill();
        while i < 4 && !self.read_bool() {
            i += 1
        }
        self.read_bits_unchecked(UBVFP_COUNT[i as usize] as u32) as i32
    }

    #[inline]
    fn read_ubit_var_fp_unchecked(&mut self) -> i32 {
        const UBVFP_COUNT: [u8; 5] = [2, 4, 10, 17, 31];

        let mut i: u8 = 0;
        while i < 4 && !self.read_bool() {
            i += 1
        }
        self.read_bits_unchecked(UBVFP_COUNT[i as usize] as u32) as i32
    }

    #[inline]
    fn read_normal(&mut self) -> f32 {
        const NORMAL_FACTOR: f32 = (1.0 / (1 << 11) as f32) - 1.0;

        let is_neg = self.read_bool();
        let len = self.read_bits_unchecked(11) as f32;
        let normal = len * NORMAL_FACTOR;
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
        let b1 = self.read_bits(8) as u64;
        let b2 = self.read_bits(8) as u64;
        let b3 = self.read_bits(8) as u64;
        let b4 = self.read_bits(8) as u64;
        let b5 = self.read_bits(8) as u64;
        let b6 = self.read_bits(8) as u64;
        let b7 = self.read_bits(8) as u64;
        let b8 = self.read_bits(8) as u64;

        b1 | (b2 << 8) | (b3 << 16) | (b4 << 24) | (b5 << 32) | (b6 << 40) | (b7 << 48) | (b8 << 56)
    }

    #[inline]
    fn read_cstring(&mut self) -> String {
        let mut i = 0;
        let mut byte: u8;
        self.refill();
        loop {
            if self.lookahead_bit_count < 8 {
                self.refill();
                if self.lookahead_bit_count < 8 {
                    break;
                }
            }

            byte = self.read_bits_unchecked(8) as u8;

            if byte == 0 {
                return String::from_utf8_lossy(&self.string_buffer[..i]).into_owned();
            }

            if i >= self.string_buffer.len() {
                break;
            }

            self.string_buffer[i] = byte;
            i += 1;
        }

        String::from_utf8_lossy(&self.string_buffer[..i]).into_owned()
    }

    #[inline]
    fn read_coordinate(&mut self) -> f32 {
        const COORD_FACTOR: f32 = 1.0 / (1 << 5) as f32;

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

            value = (int_val as f32) + (fract_val as f32) * COORD_FACTOR;

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
        let bytes = (n / 8) as usize;
        let mut tmp = vec![0; bytes];

        for byte in tmp.iter_mut().take(bytes) {
            *byte = self.read_bits(8) as u8;
        }

        if bits > 0 {
            tmp.push(self.read_bits(bits) as u8);
        }
        tmp
    }

    #[inline]
    fn remaining_bytes(&self) -> usize {
        (self.bytes_in_buffer - self.read_position) + (self.lookahead_bit_count as usize / 8)
    }

    #[inline]
    fn seek(&mut self, offset: usize) {
        if self
            .underlying_stream
            .seek(SeekFrom::Start(offset as u64))
            .is_ok()
        {
            self.read_position = 0;
            self.bytes_in_buffer = 0;
            self.bytes_read_total = offset;
            self.lookahead_buffer = 0;
            self.lookahead_bit_count = 0;

            if let Ok(bytes_read) = self.underlying_stream.read(&mut self.read_buffer) {
                self.bytes_in_buffer = bytes_read;
            }

            self.refill();
        }
    }
}
