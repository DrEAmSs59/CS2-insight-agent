mod bitstream;
mod message;
mod varint;

pub use crate::stream::bits::BitsWriter;
pub use crate::stream::msg::MessageWriter;
pub use bitstream::BitstreamWriter;
pub use message::{write_demo_message, write_demo_message_with_compression};
pub use varint::{
    write_var_u32_to_buf, write_var_u32_to_vec, write_var_u64_to_buf, write_var_u64_to_vec,
};
