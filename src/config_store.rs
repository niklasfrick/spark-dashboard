//! Storage for the dashboard configuration document.
//!
//! The document is a single instance-scoped file under the state directory. The
//! server treats it as **opaque bytes**: it never parses, validates or migrates
//! the contents. All schema knowledge lives in the frontend, which deliberately
//! avoids a second cross-language contract alongside the metrics contract.
//!
//! "No stored document" is a first-class state rather than an error — it is what
//! a fresh install looks like, and it is what a reset returns to. The frontend
//! reads it as "render the default preset".

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::io::AsyncWriteExt;

/// Largest document the server will store.
///
/// The document holds panel geometry and per-panel configuration for a handful
/// of pages — kilobytes in practice. The cap exists so an unauthenticated write
/// endpoint cannot fill the state volume, not because a real configuration is
/// expected to come close to it.
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;

const DOCUMENT_FILE_NAME: &str = "dashboards.json";

/// Reads and writes the dashboard configuration document.
#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    read_only: bool,
}

impl ConfigStore {
    /// Prepares the state directory and probes whether it can be written to.
    ///
    /// A directory that cannot be created or written is not fatal: the server
    /// still starts and still serves reads, and [`ConfigStore::is_read_only`]
    /// reports the degraded state so the client can show its banner. Falling
    /// back to browser-local storage is deliberately not an option — the
    /// configuration is shared by everyone who opens the instance.
    pub async fn new(state_dir: &Path) -> Self {
        let path = state_dir.join(DOCUMENT_FILE_NAME);

        let writable = match tokio::fs::create_dir_all(state_dir).await {
            Ok(()) => probe_writable(state_dir).await,
            Err(err) => {
                tracing::warn!(
                    "state directory {} could not be created ({err})",
                    state_dir.display()
                );
                false
            }
        };

        if !writable {
            tracing::warn!(
                "state directory {} is not writable; the dashboard configuration \
                 cannot be saved and the dashboard will run read-only",
                state_dir.display()
            );
        }

        Self {
            path,
            read_only: !writable,
        }
    }

    /// Returns the stored document, or `None` when nothing has been stored.
    pub async fn load(&self) -> io::Result<Option<Vec<u8>>> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Replaces the stored document wholesale.
    ///
    /// The write is atomic — the bytes land in a uniquely named temporary file
    /// in the same directory, are flushed to disk, and are then renamed over the
    /// target. A crash mid-write therefore leaves either the old document or the
    /// new one, never a truncated file that would brick the dashboard for every
    /// viewer at once.
    pub async fn store(&self, bytes: &[u8]) -> io::Result<()> {
        let tmp = self.path.with_extension(format!("tmp-{}", unique_suffix()));

        match write_and_sync(&tmp, bytes).await {
            Ok(()) => {}
            Err(err) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(err);
            }
        }

        // Same-directory rename is atomic, so concurrent writers race to be last
        // rather than corrupting each other. Last-write-wins is the documented
        // semantic for an instance-scoped configuration with no authentication.
        if let Err(err) = tokio::fs::rename(&tmp, &self.path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(err);
        }

        Ok(())
    }

    /// Removes the stored document. Deleting an absent document succeeds:
    /// "no document" is the state the caller asked for, and it is already true.
    pub async fn delete(&self) -> io::Result<()> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    /// Whether the state directory was unwritable at startup, meaning no write
    /// can succeed. A write that fails for some other reason later — a full or
    /// failing disk — is a plain error, not this.
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }
}

async fn write_and_sync(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(bytes).await?;
    // Without this the rename can be durable while the contents are not.
    file.sync_all().await?;
    Ok(())
}

async fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".write-probe-{}", unique_suffix()));
    match tokio::fs::write(&probe, b"").await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&probe).await;
            true
        }
        Err(_) => false,
    }
}

/// Distinguishes temporary files belonging to concurrent writers, in this
/// process and across processes sharing a state directory.
fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Root ignores directory permissions, so the read-only tests below cannot
    /// hold when the suite runs privileged (a root container, say). CI runs as
    /// an unprivileged user, where they do exercise the real path.
    #[cfg(unix)]
    async fn can_still_write(dir: &Path) -> bool {
        let probe = dir.join(".privilege-check");
        match tokio::fs::write(&probe, b"").await {
            Ok(()) => {
                let _ = tokio::fs::remove_file(&probe).await;
                true
            }
            Err(_) => false,
        }
    }

    #[tokio::test]
    async fn load_reports_absent_when_nothing_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        assert_eq!(store.load().await.unwrap(), None);
    }

    #[tokio::test]
    async fn store_then_load_round_trips_byte_identically() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        store.store(b"{\"schemaVersion\":1}").await.unwrap();

        assert_eq!(
            store.load().await.unwrap().as_deref(),
            Some(&b"{\"schemaVersion\":1}"[..])
        );
    }

    #[tokio::test]
    async fn store_round_trips_bytes_the_server_cannot_interpret() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        // Not JSON, not even UTF-8. The store must not care.
        let opaque = [0xff, 0xfe, 0x00, 0x01, b'n', b'o', b't', b' ', b'j'];
        store.store(&opaque).await.unwrap();

        assert_eq!(store.load().await.unwrap().as_deref(), Some(&opaque[..]));
    }

    #[tokio::test]
    async fn store_replaces_the_previous_document_wholesale() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        store.store(b"first-and-considerably-longer").await.unwrap();
        store.store(b"second").await.unwrap();

        assert_eq!(store.load().await.unwrap().as_deref(), Some(&b"second"[..]));
    }

    #[tokio::test]
    async fn store_leaves_no_temporary_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        store.store(b"{}").await.unwrap();

        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec![DOCUMENT_FILE_NAME.to_string()]);
    }

    #[tokio::test]
    async fn delete_removes_the_document_and_load_reports_absent() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        store.store(b"{}").await.unwrap();
        store.delete().await.unwrap();

        assert_eq!(store.load().await.unwrap(), None);
    }

    #[tokio::test]
    async fn delete_succeeds_when_no_document_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path()).await;

        store.delete().await.expect("deleting an absent document");
    }

    #[tokio::test]
    async fn a_missing_state_directory_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("deeper").join("still");

        let store = ConfigStore::new(&nested).await;

        assert!(!store.is_read_only());
        assert!(nested.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unwritable_state_directory_reports_read_only_and_still_reads() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();

        // Seed a document while the directory is still writable, so the read
        // path has something to return once it is locked down.
        tokio::fs::write(state_dir.join(DOCUMENT_FILE_NAME), b"{\"seeded\":true}")
            .await
            .unwrap();
        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();

        if can_still_write(&state_dir).await {
            tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        let store = ConfigStore::new(&state_dir).await;

        assert!(store.is_read_only(), "read-only directory must be detected");
        assert_eq!(
            store.load().await.unwrap().as_deref(),
            Some(&b"{\"seeded\":true}"[..]),
            "reads must keep working while writes cannot"
        );
        assert!(store.store(b"{}").await.is_err());

        // Restore permissions so the temp dir can clean itself up.
        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_write_leaves_the_previous_document_intact() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        tokio::fs::create_dir(&state_dir).await.unwrap();

        let store = ConfigStore::new(&state_dir).await;
        store.store(b"original").await.unwrap();

        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o555))
            .await
            .unwrap();
        let privileged = can_still_write(&state_dir).await;
        if !privileged {
            assert!(store.store(b"replacement").await.is_err());
        }
        tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        if privileged {
            eprintln!("skipping: running privileged, directory permissions do not apply");
            return;
        }

        assert_eq!(
            store.load().await.unwrap().as_deref(),
            Some(&b"original"[..])
        );
    }
}
