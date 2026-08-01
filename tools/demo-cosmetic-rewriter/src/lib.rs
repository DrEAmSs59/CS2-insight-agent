pub mod config;
mod entity;
pub mod header;
mod rewrite;
pub mod verify;
mod workflow;

pub use workflow::{
    rewrite_demo_atomically, verify_demo_pair, RewriteOptions, RewriteOutcome, VerifyOptions,
    VerifyOutcome,
};

pub const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;
