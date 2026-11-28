//! Settings file for runs under systemd, where the unit passes no arguments:
//! the `[reader]` table of `/var/lib/mpamm/mpamm.toml` (or `--config`). A
//! flag given on the command line wins, then the file, then the built-in
//! default. The file is ours and holds no secrets; hosted RPC URLs come from
//! the environment (the unit's env file).

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReaderFile {
    pub ring: Option<PathBuf>,
    pub out_dir: Option<PathBuf>,
    pub rpc_url: Option<String>,
    pub archive_url_env: Option<String>,
    pub summary_secs: Option<u64>,
    pub stall_secs: Option<u64>,
    pub cpu: Option<usize>,
    pub keep_days: Option<u32>,
    pub finalize_wait_ms: Option<u64>,
}

/// The whole file; tables other than `[reader]` belong to other binaries.
#[derive(Debug, Default, Deserialize, PartialEq)]
pub struct FileConfig {
    #[serde(default)]
    pub reader: ReaderFile,
}

/// A missing file is an empty config; a malformed one is an error (a typo
/// must not silently fall back to defaults).
pub fn load(path: &Path) -> Result<FileConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => toml::from_str(&s).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileConfig::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_reader_table_and_ignores_others() {
        let dir = std::env::temp_dir().join(format!("mpamm-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("mpamm.toml");
        std::fs::write(&p, "[reader]\ncpu = 0\nkeep_days = 7\n\n[service]\nport = 8787\n").unwrap();
        let c = load(&p).unwrap();
        assert_eq!(c.reader.cpu, Some(0));
        assert_eq!(c.reader.keep_days, Some(7));
        assert_eq!(c.reader.out_dir, None);

        std::fs::write(&p, "[reader]\ncpus = 0\n").unwrap();
        assert!(load(&p).unwrap_err().contains("cpus"), "an unknown key is an error");
        assert_eq!(load(&dir.join("absent.toml")).unwrap(), FileConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
