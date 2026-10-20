//! Bakes the two outside keys the program trusts into the build, not into Config: the rollup
//! validator identity every delegate instruction delegates to (`HZ_VALIDATOR`), and the VRF oracle
//! queue `lock_army` requests randomness from (`HZ_VRF_QUEUE`). The deploy script, the local stack
//! and CI pass both (base58). An SBF build with the real rollup (no `inline-mock-magic`) refuses to
//! build without the validator, and one with the real VRF (no `inline-mock-vrf`) without the queue.
//! Host builds (unit tests, IDL, clippy) and the LiteSVM mock build fall back: the validator to the
//! all-zero key, since they delegate nothing, and the queue to the SDK's ephemeral test queue, which
//! the LiteSVM suite passes.
use std::env;
use std::fs;
use std::path::PathBuf;

const EPHEMERAL_TEST_QUEUE: &str = "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT";

fn decode(name: &str, text: &str) -> [u8; 32] {
    let decoded = bs58::decode(text).into_vec().unwrap_or_else(|err| panic!("{name} {text} is not base58: {err}"));
    let bytes: [u8; 32] = decoded.try_into().unwrap_or_else(|_| panic!("{name} {text} is not a 32-byte public key"));
    assert!(bytes != [0; 32], "{name} must not be the all-zero key");
    bytes
}

/// The key `name` holds, or `fallback` when it is unset and `required` is false.
fn key(name: &str, required: bool, hint: &str, fallback: impl FnOnce() -> [u8; 32]) -> [u8; 32] {
    println!("cargo:rerun-if-env-changed={name}");
    match env::var(name).map(|text| text.trim().to_string()) {
        Ok(text) if !text.is_empty() => decode(name, &text),
        _ if required => panic!("{name} is not set: {hint}. scripts/deploy.mjs and scripts/local-stack.mjs set it"),
        _ => fallback(),
    }
}

fn main() {
    let sbf = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("solana");
    let mock_magic = env::var_os("CARGO_FEATURE_INLINE_MOCK_MAGIC").is_some();
    let mock_vrf = env::var_os("CARGO_FEATURE_INLINE_MOCK_VRF").is_some();
    let validator = key(
        "HZ_VALIDATOR",
        sbf && !mock_magic,
        "an SBF build delegates to the rollup validator it names; set it to the rollup's identity (getIdentity)",
        || [0; 32],
    );
    let queue = key(
        "HZ_VRF_QUEUE",
        sbf && !mock_vrf,
        "an SBF build requests randomness only from the VRF oracle queue it names",
        || decode("the ephemeral test queue", EPHEMERAL_TEST_QUEUE),
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("keys.rs");
    fs::write(
        out,
        format!(
            "pub const VALIDATOR: Pubkey = Pubkey::new_from_array({validator:?});\npub const ORACLE_QUEUE: Pubkey = Pubkey::new_from_array({queue:?});\n"
        ),
    )
    .unwrap();
}
