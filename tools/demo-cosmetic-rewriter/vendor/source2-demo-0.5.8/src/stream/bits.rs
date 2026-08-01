use std::io;

#[doc(hidden)]
pub trait BitsReader {
    fn refill(&mut self);
    fn read_bits(&mut self, amount: u32) -> u32;
    fn read_bits_unchecked(&mut self, amount: u32) -> u32;
    fn read_bytes(&mut self, amount: u32) -> Vec<u8>;
    fn read_bool(&mut self) -> bool;
    fn read_f32(&mut self) -> f32;
    fn read_var_u32(&mut self) -> u32;
    fn read_var_u64(&mut self) -> u64;
    fn read_var_i32(&mut self) -> i32;
    fn read_ubit_var(&mut self) -> u32;
    fn read_ubit_var_fp(&mut self) -> i32;
    fn read_ubit_var_fp_unchecked(&mut self) -> i32;
    fn read_normal(&mut self) -> f32;
    fn read_normal_vec3(&mut self) -> [f32; 3];
    fn read_u64_le(&mut self) -> u64;
    fn read_cstring(&mut self) -> String;
    fn read_coordinate(&mut self) -> f32;
    fn read_angle(&mut self, n: u32) -> f32;
    fn read_bits_as_bytes(&mut self, n: u32) -> Vec<u8>;
    fn remaining_bytes(&self) -> usize;
    fn seek(&mut self, offset: usize);
}

#[doc(hidden)]
pub trait BitsWriter {
    fn write_bits(&mut self, amount: u32, value: u64) -> io::Result<()>;
    fn write_bits_unchecked(&mut self, amount: u32, value: u64) -> io::Result<()>;
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()>;
    fn write_bit(&mut self, value: bool) -> io::Result<()>;
    fn write_f32(&mut self, value: f32) -> io::Result<()>;
    fn write_var_u32(&mut self, value: u32) -> io::Result<()>;
    fn write_var_u64(&mut self, value: u64) -> io::Result<()>;
    fn write_var_i32(&mut self, value: i32) -> io::Result<()>;
    fn write_ubit_var(&mut self, value: u32) -> io::Result<()>;
    fn write_ubit_var_fp(&mut self, value: i32) -> io::Result<()>;
    fn write_ubit_var_fp_unchecked(&mut self, value: i32) -> io::Result<()>;
    fn write_normal(&mut self, value: f32) -> io::Result<()>;
    fn write_normal_vec3(&mut self, value: [f32; 3]) -> io::Result<()>;
    fn write_u64_le(&mut self, value: u64) -> io::Result<()>;
    fn write_cstring(&mut self, value: &str) -> io::Result<()>;
    fn write_coordinate(&mut self, value: f32) -> io::Result<()>;
    fn write_angle(&mut self, value: f32, n: u32) -> io::Result<()>;
    fn write_bits_as_bytes(&mut self, bytes: &[u8], n: u32) -> io::Result<()>;
    fn flush(&mut self) -> io::Result<()>;
}
