//! Query parameters read as Express read them: a repeated key is an array,
//! whose first element the number parameters take and the string ones refuse
//! (`typeof req.query.x === 'string'`), and numbers parse as `Number()` does.

pub(crate) struct Query(Vec<(String, String)>);

impl Query {
    pub(crate) fn parse(raw: Option<&str>) -> Query {
        Query(raw.map(|q| form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default())
    }

    fn all<'a>(&'a self, key: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.0.iter().filter(move |(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The first value of a key, repeated or not.
    pub(crate) fn first<'a>(&'a self, key: &'a str) -> Option<&'a str> {
        self.all(key).next()
    }

    /// The value of a key given exactly once.
    pub(crate) fn single<'a>(&'a self, key: &'a str) -> Option<&'a str> {
        let mut values = self.all(key);
        let first = values.next()?;
        values.next().is_none().then_some(first)
    }

    /// Today's `positiveNumberParam`: a finite number above zero.
    pub(crate) fn positive(&self, key: &str) -> Option<f64> {
        let raw = self.first(key)?;
        if raw.trim().is_empty() {
            return None;
        }
        js_number(raw).filter(|n| n.is_finite() && *n > 0.0)
    }
}

/// JavaScript's `Number(string)` for the inputs a query can carry: trimmed,
/// decimal or exponent notation, or a `0x`/`0o`/`0b` integer.
pub(crate) fn js_number(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    // Rust also reads `inf`/`nan`, which JavaScript doesn't; callers reject
    // every non-finite value anyway.
    t.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_parse_as_javascript_does() {
        let q =
            Query::parse(Some("days=7&limit=%201e3%20&size=0x10&bad=abc&zero=0&neg=-1&nan=NaN&inf=Infinity&blank=%20"));
        assert_eq!(q.positive("days"), Some(7.0));
        assert_eq!(q.positive("limit"), Some(1000.0));
        assert_eq!(q.positive("size"), Some(16.0));
        for key in ["bad", "zero", "neg", "nan", "inf", "blank", "missing"] {
            assert_eq!(q.positive(key), None, "{key}");
        }
    }

    #[test]
    fn repeated_keys_are_arrays() {
        let q = Query::parse(Some("days=7&days=1&market=MON%2FUSDC&volume=1&volume=1"));
        assert_eq!(q.positive("days"), Some(7.0), "a number parameter takes the first");
        assert_eq!(q.single("market"), Some("MON/USDC"));
        assert_eq!(q.single("volume"), None, "a string parameter refuses an array");
        assert_eq!(q.first("volume"), Some("1"));
    }
}
