//! systemd service management subcommand.
//!
//! Exposes `spark-dashboard service {install,uninstall,status}` so both install
//! paths (`cargo install` and `packaging/install.sh`) share the same logic.
//! Linux-only; stubs return a helpful error on other platforms.

use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install the systemd service and copy the binary into PREFIX/bin.
    Install {
        /// Install prefix for the binary
        #[arg(long, default_value = "/usr/local")]
        prefix: String,
    },
    /// Stop and remove the systemd service + installed binary.
    Uninstall {
        /// Also remove /etc/spark-dashboard/
        #[arg(long)]
        purge: bool,
    },
    /// Show `systemctl status spark-dashboard`.
    Status,
}

pub fn dispatch(cmd: ServiceCommand) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        linux::run(cmd)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cmd;
        Err("`service` is only supported on Linux with systemd".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::ServiceCommand;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const SERVICE_NAME: &str = "spark-dashboard";
    const SERVICE_USER: &str = "spark-dashboard";
    const UNIT_PATH: &str = "/etc/systemd/system/spark-dashboard.service";
    const CONFIG_DIR: &str = "/etc/spark-dashboard";
    const CONFIG_PATH: &str = "/etc/spark-dashboard/config.env";
    const CONFIG_EXAMPLE_PATH: &str = "/etc/spark-dashboard/config.env.example";

    const UNIT_FILE: &str = include_str!("../../packaging/systemd/spark-dashboard.service");
    const CONFIG_EXAMPLE: &str = include_str!("../../packaging/config.env.example");

    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

    pub fn run(cmd: ServiceCommand) -> Result<()> {
        match cmd {
            ServiceCommand::Install { prefix } => install(&prefix),
            ServiceCommand::Uninstall { purge } => uninstall(purge),
            ServiceCommand::Status => status(),
        }
    }

    fn install(prefix: &str) -> Result<()> {
        ensure_root_or_reexec()?;

        let bin_src = std::env::current_exe()?;
        let bin_dst = PathBuf::from(prefix).join("bin").join(SERVICE_NAME);

        if is_active(SERVICE_NAME)? {
            println!("==> Stopping active service for binary swap");
            run_checked(Command::new("systemctl").args(["stop", SERVICE_NAME]))?;
        }

        ensure_user()?;
        install_binary(&bin_src, &bin_dst)?;
        install_config()?;
        install_unit()?;

        println!("==> Reloading systemd");
        run_checked(Command::new("systemctl").arg("daemon-reload"))?;

        println!("==> Enabling and starting {SERVICE_NAME}");
        run_checked(Command::new("systemctl").args(["enable", "--now", SERVICE_NAME]))?;

        println!();
        println!("spark-dashboard is installed.");
        println!("  binary:  {}", bin_dst.display());
        println!("  unit:    {UNIT_PATH}");
        println!("  config:  {CONFIG_PATH}");
        println!();
        println!("  systemctl status {SERVICE_NAME}");
        println!("  journalctl -u {SERVICE_NAME} -f");
        println!();
        println!("Dashboard: http://<spark-host>:3000");
        Ok(())
    }

    fn uninstall(purge: bool) -> Result<()> {
        ensure_root_or_reexec()?;

        if unit_exists() {
            println!("==> Stopping and disabling {SERVICE_NAME}");
            // Best-effort; ignore failures if already stopped/disabled.
            let _ = Command::new("systemctl")
                .args(["disable", "--now", SERVICE_NAME])
                .status();
            println!("==> Removing unit file {UNIT_PATH}");
            let _ = fs::remove_file(UNIT_PATH);
            run_checked(Command::new("systemctl").arg("daemon-reload"))?;
        }

        for prefix in ["/usr/local", "/usr"] {
            let bin = PathBuf::from(prefix).join("bin").join(SERVICE_NAME);
            if bin.exists() {
                println!("==> Removing binary {}", bin.display());
                let _ = fs::remove_file(&bin);
            }
        }

        if user_exists(SERVICE_USER)? {
            println!("==> Removing system user {SERVICE_USER}");
            // `userdel` removes from groups automatically.
            let _ = Command::new("userdel").arg(SERVICE_USER).status();
        }

        if purge && Path::new(CONFIG_DIR).exists() {
            println!("==> Purging {CONFIG_DIR}");
            let _ = fs::remove_dir_all(CONFIG_DIR);
        } else if Path::new(CONFIG_DIR).exists() {
            println!("(keeping {CONFIG_DIR} — pass --purge to remove)");
        }

        println!();
        println!("spark-dashboard is uninstalled.");
        Ok(())
    }

    fn status() -> Result<()> {
        // Pass through to systemctl — it already does the right thing for non-root.
        let status = Command::new("systemctl")
            .args(["status", SERVICE_NAME])
            .status()?;
        // `systemctl status` exits non-zero for stopped/inactive units; that's
        // informational rather than an installer failure. Pass the code through.
        std::process::exit(status.code().unwrap_or(0));
    }

    fn install_binary(src: &Path, dst: &Path) -> Result<()> {
        let dst_dir = dst.parent().ok_or("invalid binary destination")?;
        fs::create_dir_all(dst_dir)?;

        // Atomic-ish swap: copy to .new, then rename.
        let tmp = dst.with_extension("new");
        fs::copy(src, &tmp)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
        fs::rename(&tmp, dst)?;
        println!("==> Installed binary to {}", dst.display());
        Ok(())
    }

    fn install_config() -> Result<()> {
        fs::create_dir_all(CONFIG_DIR)?;
        fs::set_permissions(CONFIG_DIR, fs::Permissions::from_mode(0o755))?;

        // Always write the example so users can see fresh defaults after upgrades.
        fs::write(CONFIG_EXAMPLE_PATH, CONFIG_EXAMPLE)?;
        fs::set_permissions(CONFIG_EXAMPLE_PATH, fs::Permissions::from_mode(0o644))?;

        // Write config.env only if it doesn't already exist — never clobber operator edits.
        if !Path::new(CONFIG_PATH).exists() {
            fs::write(CONFIG_PATH, CONFIG_EXAMPLE)?;
            fs::set_permissions(CONFIG_PATH, fs::Permissions::from_mode(0o644))?;
            println!("==> Wrote default {CONFIG_PATH}");
        } else {
            println!("==> Kept existing {CONFIG_PATH}");
        }
        Ok(())
    }

    fn install_unit() -> Result<()> {
        fs::write(UNIT_PATH, UNIT_FILE)?;
        fs::set_permissions(UNIT_PATH, fs::Permissions::from_mode(0o644))?;
        println!("==> Wrote unit file {UNIT_PATH}");
        Ok(())
    }

    fn ensure_user() -> Result<()> {
        if !user_exists(SERVICE_USER)? {
            println!("==> Creating system user {SERVICE_USER}");
            run_checked(Command::new("useradd").args([
                "--system",
                "--no-create-home",
                "--shell",
                "/usr/sbin/nologin",
                "--comment",
                "Spark Dashboard",
                SERVICE_USER,
            ]))?;
        }

        for group in ["video", "render", "docker"] {
            if !group_exists(group) {
                eprintln!("note: group `{group}` does not exist — skipping");
                continue;
            }
            // usermod -aG is idempotent.
            let _ = Command::new("usermod")
                .args(["-aG", group, SERVICE_USER])
                .status();
        }
        Ok(())
    }

    fn user_exists(name: &str) -> Result<bool> {
        let status = Command::new("getent").args(["passwd", name]).status()?;
        Ok(status.success())
    }

    fn group_exists(name: &str) -> bool {
        Command::new("getent")
            .args(["group", name])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn unit_exists() -> bool {
        Path::new(UNIT_PATH).exists()
    }

    fn is_active(name: &str) -> Result<bool> {
        let status = Command::new("systemctl")
            .args(["is-active", "--quiet", name])
            .status()?;
        Ok(status.success())
    }

    fn run_checked(cmd: &mut Command) -> Result<()> {
        let status = cmd.status()?;
        if !status.success() {
            return Err(format!("command failed: {cmd:?} (exit {status})").into());
        }
        Ok(())
    }

    fn is_root() -> bool {
        // Zero-dep EUID check via /proc/self/status.
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("Uid:"))
                    .and_then(|l| l.split_whitespace().nth(1).map(str::to_owned))
            })
            .map(|euid| euid == "0")
            .unwrap_or(false)
    }

    /// Re-exec self under sudo if not running as root. Returns only when already root.
    fn ensure_root_or_reexec() -> Result<()> {
        if is_root() {
            return Ok(());
        }
        if Command::new("sudo").arg("-v").status().is_err() {
            return Err("this command requires root. Install sudo or run as root.".into());
        }
        let exe = std::env::current_exe()?;
        let args: Vec<String> = std::env::args().skip(1).collect();
        let status = Command::new("sudo")
            .arg("--")
            .arg(&exe)
            .args(&args)
            .status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
}
