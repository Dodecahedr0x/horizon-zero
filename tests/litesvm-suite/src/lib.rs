//! Host-side helpers shared with the LiteSVM integration test.
use sha2::{Digest, Sha256};

pub const PROGRAM_ID: &str = "zeroDcScmnx7TSvWvnKBa81Gcq34T1QSRWH182YdqRg";
pub const VRF_ID: &str = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";

pub fn sighash(name: &str) -> [u8; 8] {
    let mut hash = [0u8; 8];
    hash.copy_from_slice(&Sha256::digest(format!("global:{name}").as_bytes())[..8]);
    hash
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
