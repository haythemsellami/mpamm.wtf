//! Kraken WS v2 book checksum
//! (https://docs.kraken.com/exchange/guides/websockets/book-checksum-v2):
//! CRC32 over the top 10 asks (ascending) then the top 10 bids (descending),
//! each level as its price digits then its quantity digits, decimal point
//! removed and leading zeros stripped, using the exact decimal text Kraken
//! sent (a trailing zero matters, so prices are kept as received).

/// The digits of a decimal (or exponent) lexeme as the checksum wants them.
pub fn digits(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let (mantissa, exponent) = match lower.split_once('e') {
        Some((m, e)) => (m.to_string(), e.parse::<i64>().unwrap_or(0)),
        None => (lower.clone(), 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa.as_str(), ""));
    let all = format!("{whole}{fraction}");
    let places = whole.len() as i64 + exponent;
    let plain = if places <= 0 {
        format!("{}{all}", "0".repeat((-places) as usize))
    } else if places as usize >= all.len() {
        format!("{all}{}", "0".repeat(places as usize - all.len()))
    } else {
        all
    };
    plain.trim_start_matches('0').to_string()
}

/// The checksum of a book: `asks` ascending and `bids` descending, as
/// (price text, quantity text).
pub fn checksum<'a>(
    asks: impl IntoIterator<Item = (&'a str, &'a str)>,
    bids: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> u32 {
    let mut s = String::new();
    for (p, q) in asks.into_iter().take(10) {
        s.push_str(&digits(p));
        s.push_str(&digits(q));
    }
    for (p, q) in bids.into_iter().take(10) {
        s.push_str(&digits(p));
        s.push_str(&digits(q));
    }
    crc32fast::hash(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_follow_kraken_rules() {
        assert_eq!(digits("0.05005"), "5005");
        assert_eq!(digits("0.00000500"), "500");
        assert_eq!(digits("45285.2"), "452852");
        assert_eq!(digits("1.0E-5"), "10");
        assert_eq!(digits("2.5e2"), "250");
        assert_eq!(digits("12.50"), "1250", "trailing zeros are kept");
    }
}
