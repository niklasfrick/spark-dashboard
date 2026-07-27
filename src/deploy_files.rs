//! Keeps the deployment files honest about where state lives.
//!
//! `DEFAULT_STATE_DIR` is one constant, but the path it names has to be spelled
//! out again in every deployment artifact: the systemd unit grants it, the
//! container image pre-creates it, Compose mounts a volume at it. Nothing in the
//! build links those copies together — a Dockerfile typo produces a perfectly
//! good image whose dashboard silently comes up read-only, and no Rust test
//! would notice.
//!
//! So the files are read as text and asserted against the constant. That is a
//! weaker check than executing them, which is what `dev/docker-dev.sh` and the
//! installer CI job are for; it is a fast one that catches drift the moment it
//! is introduced rather than at deploy time.

use crate::DEFAULT_STATE_DIR;

pub const UNIT: &str = include_str!("../deploy/host/systemd/spark-dashboard.service");
const DOCKERFILE: &str = include_str!("../deploy/docker/Dockerfile");
const COMPOSE: &str = include_str!("../deploy/docker/docker-compose.yml");

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

    #[test]
    fn the_image_pre_creates_the_binarys_default_state_directory() {
        // Owned by the runtime uid, because Docker seeds a fresh named volume
        // from the image — including ownership — and a distroless runtime has no
        // shell to fix it up afterwards.
        let expected = format!(
            "COPY --from=builder --chown=65532:65532 --chmod=750 /state {DEFAULT_STATE_DIR}"
        );
        assert!(
            DOCKERFILE.lines().any(|line| line.trim() == expected),
            "Dockerfile should contain `{expected}`"
        );
    }

    #[test]
    fn compose_mounts_the_state_volume_where_the_container_looks_for_it() {
        // One variable feeds both the mount point and the app, so an operator
        // who overrides it cannot leave the two pointing at different paths.
        let path = format!("${{SPARK_DASHBOARD_STATE_DIR:-{DEFAULT_STATE_DIR}}}");
        for expected in [
            format!("- spark-dashboard-state:{path}"),
            format!("- SPARK_DASHBOARD_STATE_DIR={path}"),
        ] {
            assert!(
                COMPOSE.lines().any(|line| line.trim() == expected),
                "docker-compose.yml should contain `{expected}`"
            );
        }
    }

    #[test]
    fn the_state_volume_keeps_its_name_across_projects() {
        // Without an explicit `name:`, Compose prefixes the project name and the
        // volume becomes `docker_spark-dashboard-state` — which every
        // `docker volume` command in the docs would miss.
        assert!(
            COMPOSE
                .lines()
                .any(|l| l.trim() == "name: spark-dashboard-state"),
            "the state volume should pin its own name"
        );
    }
}
