//! Keeps the deployment files honest about where state lives.
//!
//! `DEFAULT_STATE_DIR` is one constant, but the path it names has to be spelled
//! out again in every deployment artifact that has to agree with it — starting
//! with the systemd unit that grants the directory. Nothing in the build links
//! those copies together, and a mismatch produces no error: the service starts
//! and the dashboard silently comes up read-only.
//!
//! So the files are read as text and asserted against the constant. That is a
//! weaker check than executing them, which is what the installer CI job is for;
//! it is a fast one that catches drift the moment it is introduced rather than
//! at deploy time.

use crate::DEFAULT_STATE_DIR;

pub const UNIT: &str = include_str!("../deploy/host/systemd/spark-dashboard.service");

/// Value of the first `Name=value` directive in a systemd unit, ignoring
/// section headers and comments.
pub fn directive<'a>(unit: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    unit.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(prefix.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_systemd_unit_grants_the_binarys_default_state_directory() {
        let granted = directive(UNIT, "StateDirectory").expect("unit grants a state directory");

        // systemd creates /var/lib/<name> for a system unit and chowns it to the
        // service user. That derived path is what the binary must default to,
        // otherwise a fresh install writes somewhere ProtectSystem=strict
        // forbids and the dashboard silently comes up read-only.
        assert_eq!(format!("/var/lib/{granted}"), DEFAULT_STATE_DIR);
    }
}
