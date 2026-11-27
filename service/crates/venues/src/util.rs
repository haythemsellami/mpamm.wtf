//! Helpers every venue module uses, matching today's TypeScript exactly
//! where a number or an id depends on it (server/src/util.ts).

use alloy_primitives::{Address, U256};
use mpamm_ring::{hex, Addr, B32};

/// A raw token amount as a float, as today's `fromUnits` computes it:
/// whole + fraction / 10^decimals, each converted to the nearest double.
pub fn from_units(raw: U256, decimals: u8) -> f64 {
    if raw.is_zero() {
        return 0.0;
    }
    let base = U256::from(10u8).pow(U256::from(decimals));
    let (whole, frac) = raw.div_rem(base);
    to_f64(whole) + to_f64(frac) / to_f64(base)
}

/// A signed raw amount (two's complement int256 or a negated magnitude).
pub fn from_units_signed(raw: U256, negative: bool, decimals: u8) -> f64 {
    let v = from_units(raw, decimals);
    if negative {
        -v
    } else {
        v
    }
}

/// Nearest double, like JavaScript's `Number(bigint)`.
pub fn to_f64(x: U256) -> f64 {
    if let Ok(v) = u128::try_from(x) {
        return v as f64;
    }
    // Beyond 2^128: scale down by whole words (exact enough for any amount
    // a token could hold).
    let limbs = x.as_limbs();
    let mut out = 0.0;
    for (i, l) in limbs.iter().enumerate() {
        out += *l as f64 * 2f64.powi(64 * i as i32);
    }
    out
}

/// A float notional as a raw amount, as today's `toUnits`: fixed-point text
/// at min(decimals, 18) places, padded to `decimals`.
pub fn to_units(value: f64, decimals: u8) -> U256 {
    if !value.is_finite() || value <= 0.0 {
        return U256::ZERO;
    }
    let s = format!("{:.*}", usize::from(decimals.min(18)), value);
    let (whole, frac) = s.split_once('.').unwrap_or((s.as_str(), ""));
    let mut digits = whole.to_string();
    let mut f = frac.to_string();
    f.extend(std::iter::repeat_n('0', usize::from(decimals)));
    digits.push_str(&f[..usize::from(decimals)]);
    U256::from_str_radix(&digits, 10).unwrap_or(U256::ZERO)
}

/// `0x1234…abcd`, today's `shortHex`.
pub fn short_hex(h: &str) -> String {
    if !h.starts_with("0x") || h.len() <= 10 {
        return h.to_string();
    }
    format!("{}…{}", &h[..6], &h[h.len() - 4..])
}

pub fn addr_hex(a: &Addr) -> String {
    format!("0x{}", hex(a))
}

pub fn b32_hex(b: &B32) -> String {
    format!("0x{}", hex(b))
}

/// A trade's id: `venue-txHash-logIndex`, lower-case hash, block-level index.
pub fn fill_id(venue: &str, tx_hash: &B32, log_index: u32) -> String {
    format!("{venue}-0x{}-{log_index}", hex(tx_hash))
}

pub fn to_addr(a: Address) -> Addr {
    a.into_array()
}

pub fn from_addr(a: &Addr) -> Address {
    Address::from(*a)
}

/// The registry's address for a token key, as bytes.
pub fn token_addr(registry: &mpamm_registry::Registry, key: &str) -> Option<Addr> {
    registry.tokens.get(key).map(|t| t.address_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_match_typescript() {
        // fromUnits(1234567890123456789n, 18) = 1 + 0.234567890123456789
        assert_eq!(from_units(U256::from(1_234_567_890_123_456_789u128), 18), 1.0 + 234_567_890_123_456_789f64 / 1e18);
        assert_eq!(from_units(U256::from(1_500_000u64), 6), 1.5);
        assert_eq!(from_units(U256::ZERO, 6), 0.0);
        assert_eq!(from_units_signed(U256::from(2_000_000u64), true, 6), -2.0);
        assert_eq!(to_units(1.5, 6), U256::from(1_500_000u64));
        // As in TypeScript: (0.1).toFixed(18) is "0.100000000000000006".
        assert_eq!(to_units(0.1, 18), U256::from(100_000_000_000_000_006u128));
        assert_eq!(to_units(-1.0, 6), U256::ZERO);
        assert_eq!(to_units(33.333333333, 6), U256::from(33_333_333u64));
    }

    #[test]
    fn labels_and_ids() {
        assert_eq!(short_hex("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
        assert_eq!(short_hex("0x1234"), "0x1234");
        assert_eq!(fill_id("poe", &[0xab; 32], 7), format!("poe-0x{}-7", "ab".repeat(32)));
    }
}
