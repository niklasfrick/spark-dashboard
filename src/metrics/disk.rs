use crate::metrics::DiskMetrics;
use std::time::{Duration, Instant};

/// Bytes per `/proc/diskstats` sector. The kernel always reports 512-byte
/// units here regardless of the device's physical block size.
const SECTOR_BYTES: u64 = 512;

/// Device-name prefixes whose traffic is never counted: loop devices (snaps,
/// mounted images) and RAM-backed block devices both re-read data that is
/// already in memory.
const EXCLUDED_PREFIXES: &[&str] = &["loop", "ram", "zram"];

/// Families whose whole-device name ends in a number (`mmcblk0`, `md0`,
/// `nbd0`, `rbd0`, `dm-0`). Their partitions append `p<n>`.
const NUMBERED_PREFIXES: &[&str] = &["mmcblk", "md", "nbd", "rbd", "dm-"];

/// Cumulative sector counters for one block device, as read from
/// `/proc/diskstats`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceCounters {
    pub name: String,
    pub sectors_read: u64,
    pub sectors_written: u64,
}

/// Parse the text of `/proc/diskstats` into per-device sector counters.
///
/// Accepts the 14-field (pre-4.18), 18-field (4.18+) and 20-field (5.5+)
/// layouts; lines with fewer than 14 fields or non-numeric counters are
/// skipped.
pub fn parse_diskstats(text: &str) -> Vec<DeviceCounters> {
    text.lines().filter_map(parse_diskstats_line).collect()
}

/// Parse one `/proc/diskstats` row. Fields are 1-indexed in the kernel docs:
/// 3 = device name, 6 = sectors read, 10 = sectors written.
fn parse_diskstats_line(line: &str) -> Option<DeviceCounters> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 14 {
        return None;
    }
    Some(DeviceCounters {
        name: fields[2].to_string(),
        sectors_read: fields[5].parse().ok()?,
        sectors_written: fields[9].parse().ok()?,
    })
}

/// True for whole block devices (`nvme0n1`, `sda`, `mmcblk0`, `dm-0`, `md0`),
/// false for partitions and for excluded pseudo-devices.
pub fn is_whole_device(name: &str) -> bool {
    if name.is_empty() || EXCLUDED_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return false;
    }
    // nvme<ctrl>n<ns> is the namespace (whole device); nvme<ctrl>n<ns>p<n> a partition.
    if let Some(rest) = name.strip_prefix("nvme") {
        let (ctrl, rest) = split_leading_digits(rest);
        let Some(rest) = rest.strip_prefix('n') else {
            return false;
        };
        let (ns, rest) = split_leading_digits(rest);
        return !ctrl.is_empty() && !ns.is_empty() && rest.is_empty();
    }
    // mmcblk<n>, md<n>, nbd<n>, rbd<n>, dm-<n> are whole; a trailing p<n> is a partition.
    for prefix in NUMBERED_PREFIXES {
        if let Some(rest) = name.strip_prefix(prefix) {
            let (number, rest) = split_leading_digits(rest);
            return !number.is_empty() && rest.is_empty();
        }
    }
    // Lettered devices (sda, vda, xvda, hda): partitions append a number.
    !name.ends_with(|c: char| c.is_ascii_digit())
}

/// Split `s` into its leading ASCII-digit run and the remainder.
fn split_leading_digits(s: &str) -> (&str, &str) {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    s.split_at(end)
}

/// One reading of the whole-device counters and the instant it was taken.
#[derive(Clone, Debug)]
struct Sample {
    taken_at: Instant,
    devices: Vec<DeviceCounters>,
}

/// Turns consecutive `/proc/diskstats` readings into bytes-per-second rates.
///
/// Holds the previous sample so the caller's poll loop does not have to; the
/// first sample after construction reports zero rates.
#[derive(Debug, Default)]
pub struct DiskIoSampler {
    previous: Option<Sample>,
}

impl DiskIoSampler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a new set of counters taken at `now` and return the aggregate
    /// `(read_bytes_per_sec, write_bytes_per_sec)` over all whole devices
    /// since the previous sample.
    ///
    /// Only devices present in both samples contribute. A device whose counter
    /// went backwards (wrap or reset) contributes zero for this tick, as does
    /// a zero elapsed time.
    pub fn sample(&mut self, devices: Vec<DeviceCounters>, now: Instant) -> (u64, u64) {
        let devices: Vec<DeviceCounters> = devices
            .into_iter()
            .filter(|d| is_whole_device(&d.name))
            .collect();
        let current = Sample {
            taken_at: now,
            devices,
        };
        let rates = match &self.previous {
            Some(previous) => io_rates(previous, &current),
            None => (0, 0),
        };
        self.previous = Some(current);
        rates
    }
}

/// Aggregate `(read, write)` bytes per second between two samples.
fn io_rates(previous: &Sample, current: &Sample) -> (u64, u64) {
    let elapsed = current
        .taken_at
        .saturating_duration_since(previous.taken_at);
    if elapsed.is_zero() {
        return (0, 0);
    }
    let mut sectors_read: u64 = 0;
    let mut sectors_written: u64 = 0;
    for device in &current.devices {
        let Some(before) = previous.devices.iter().find(|d| d.name == device.name) else {
            continue;
        };
        sectors_read += device.sectors_read.saturating_sub(before.sectors_read);
        sectors_written += device
            .sectors_written
            .saturating_sub(before.sectors_written);
    }
    (
        bytes_per_second(sectors_read, elapsed),
        bytes_per_second(sectors_written, elapsed),
    )
}

fn bytes_per_second(sectors: u64, elapsed: Duration) -> u64 {
    ((sectors as f64 * SECTOR_BYTES as f64) / elapsed.as_secs_f64()).round() as u64
}

#[cfg(target_os = "linux")]
fn read_diskstats() -> Option<String> {
    std::fs::read_to_string("/proc/diskstats").ok()
}

#[cfg(not(target_os = "linux"))]
fn read_diskstats() -> Option<String> {
    None
}

/// Collect aggregate disk I/O throughput metrics.
///
/// The device name comes from the largest sysinfo disk; the rates come from
/// `/proc/diskstats` via `sampler`, because sysinfo's own per-disk deltas need
/// a `/dev` node to resolve the device name and stay at zero inside a
/// container that has none (#118).
pub fn collect_disk_metrics(disks: &sysinfo::Disks, sampler: &mut DiskIoSampler) -> DiskMetrics {
    // Use the largest disk's name as the primary identifier
    let name = disks
        .list()
        .iter()
        .max_by_key(|d| d.total_space())
        .map(|d| d.name().to_string_lossy().to_string())
        .filter(|n| !n.is_empty());

    let devices = read_diskstats()
        .map(|text| parse_diskstats(&text))
        .unwrap_or_default();
    let (read_bytes_per_sec, write_bytes_per_sec) = sampler.sample(devices, Instant::now());

    DiskMetrics {
        name,
        read_bytes_per_sec,
        write_bytes_per_sec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20-field `/proc/diskstats` (kernel 5.5+) captured on a DGX Spark,
    /// with a `sda`/`sda1` pair added.
    const FIXTURE: &str = "\
   7       0 loop0 14 0 34 0 0 0 0 0 0 1 0 0 0 0 0 0 0
   7       3 loop3 5448 0 260018 1028 0 0 0 0 0 997 1028 0 0 0 0 0 0
 259       0 nvme0n1 141767085 476731 21387648273 37815475 14915699 4065679 3230311532 70819539 0 15413636 109079386 100665 0 3432579160 99625 271567 344745
 259       1 nvme0n1p1 425 954 12907 104 2 0 2 0 0 26 107 4 0 583008 3 0 0
 259       2 nvme0n1p2 141766546 475777 21387630630 37815367 14915697 4065679 3230311530 70819539 0 17211266 108734529 100661 0 3431996152 99622 0 0
   8       0 sda 1000 0 8000 10 500 0 4000 5 0 10 15 0 0 0 0 0 0 0 0
   8       1 sda1 999 0 7990 10 500 0 4000 5 0 10 15 0 0 0 0 0 0 0 0
";

    fn counters(name: &str, sectors_read: u64, sectors_written: u64) -> DeviceCounters {
        DeviceCounters {
            name: name.to_string(),
            sectors_read,
            sectors_written,
        }
    }

    fn whole_device_names(devices: &[DeviceCounters]) -> Vec<&str> {
        devices
            .iter()
            .filter(|d| is_whole_device(&d.name))
            .map(|d| d.name.as_str())
            .collect()
    }

    #[test]
    fn parses_fixture_into_per_device_sector_counters() {
        let devices = parse_diskstats(FIXTURE);
        let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "loop0",
                "loop3",
                "nvme0n1",
                "nvme0n1p1",
                "nvme0n1p2",
                "sda",
                "sda1"
            ]
        );
        let nvme = devices.iter().find(|d| d.name == "nvme0n1").unwrap();
        assert_eq!(nvme.sectors_read, 21_387_648_273);
        assert_eq!(nvme.sectors_written, 3_230_311_532);
        let sda1 = devices.iter().find(|d| d.name == "sda1").unwrap();
        assert_eq!(sda1.sectors_read, 7_990);
        assert_eq!(sda1.sectors_written, 4_000);
    }

    #[test]
    fn whole_device_filter_keeps_only_nvme0n1_and_sda() {
        let devices = parse_diskstats(FIXTURE);
        assert_eq!(whole_device_names(&devices), ["nvme0n1", "sda"]);
    }

    #[test]
    fn parses_14_and_18_field_variants() {
        let text = "\
   8       0 sda 100 0 800 10 50 0 400 5 0 10 15
   8      16 sdb 100 0 1600 10 50 0 3200 5 0 10 15 1 2 3 4
";
        let devices = parse_diskstats(text);
        assert_eq!(
            devices,
            [counters("sda", 800, 400), counters("sdb", 1600, 3200)]
        );
    }

    #[test]
    fn skips_malformed_lines() {
        let text = "\
garbage
   8       0 sda 100 0
   8       0 sdb 100 0 x 10 50 0 400 5 0 10 15
   8       0 sdc 100 0 800 10 50 0 400 5 0 10 15

";
        assert_eq!(parse_diskstats(text), [counters("sdc", 800, 400)]);
    }

    #[test]
    fn whole_device_classification() {
        for whole in [
            "nvme0n1", "nvme1n2", "sda", "sdz", "vda", "xvda", "hda", "mmcblk0", "mmcblk1", "dm-0",
            "dm-12", "md0", "md127", "nbd0", "rbd0",
        ] {
            assert!(is_whole_device(whole), "{whole} should be a whole device");
        }
        for not_whole in [
            "nvme0n1p1",
            "nvme0n1p2",
            "sda1",
            "sda12",
            "vda2",
            "xvda1",
            "mmcblk0p1",
            "md0p1",
            "nbd0p1",
            "loop0",
            "loop15",
            "ram0",
            "zram0",
            "nvme0",
            "nvme",
            "",
        ] {
            assert!(
                !is_whole_device(not_whole),
                "{not_whole} should not be a whole device"
            );
        }
    }

    #[test]
    fn first_sample_reports_zero() {
        let mut sampler = DiskIoSampler::new();
        let rates = sampler.sample(parse_diskstats(FIXTURE), Instant::now());
        assert_eq!(rates, (0, 0));
    }

    #[test]
    fn consecutive_samples_yield_bytes_per_second_over_actual_elapsed_time() {
        let mut sampler = DiskIoSampler::new();
        let t0 = Instant::now();
        sampler.sample(parse_diskstats(FIXTURE), t0);

        // nvme0n1 +2000 sectors read / +1000 written, sda +200 / +100, over 2.5 s.
        // Partition and loop traffic must not be counted.
        let advanced = FIXTURE
            .replace("21387648273", "21387650273")
            .replace("3230311532", "3230312532")
            .replace(
                "sda 1000 0 8000 10 500 0 4000",
                "sda 1000 0 8200 10 500 0 4100",
            )
            .replace(
                "sda1 999 0 7990 10 500 0 4000",
                "sda1 999 0 8190 10 500 0 4100",
            )
            .replace("loop3 5448 0 260018", "loop3 5448 0 999999");
        let rates = sampler.sample(parse_diskstats(&advanced), t0 + Duration::from_millis(2500));
        assert_eq!(rates, (2200 * 512 / 25 * 10, 1100 * 512 / 25 * 10));
        assert_eq!(rates, (450_560, 225_280));
    }

    #[test]
    fn backwards_counter_reports_zero_for_that_tick() {
        let mut sampler = DiskIoSampler::new();
        let t0 = Instant::now();
        sampler.sample(vec![counters("sda", 10_000, 5_000)], t0);
        let rates = sampler.sample(
            vec![counters("sda", 9_000, 4_000)],
            t0 + Duration::from_secs(1),
        );
        assert_eq!(rates, (0, 0));

        // The next tick measures from the reset counters, not from the old ones.
        let rates = sampler.sample(
            vec![counters("sda", 9_100, 4_000)],
            t0 + Duration::from_secs(2),
        );
        assert_eq!(rates, (100 * 512, 0));
    }

    #[test]
    fn a_wrapped_counter_zeroes_only_that_counter() {
        let mut sampler = DiskIoSampler::new();
        let t0 = Instant::now();
        sampler.sample(vec![counters("sda", u64::MAX - 10, 1_000)], t0);
        let rates = sampler.sample(vec![counters("sda", 5, 1_100)], t0 + Duration::from_secs(1));
        assert_eq!(rates, (0, 100 * 512));
    }

    #[test]
    fn appearing_and_disappearing_devices_do_not_spike() {
        let mut sampler = DiskIoSampler::new();
        let t0 = Instant::now();
        sampler.sample(
            vec![counters("sda", 1_000, 0), counters("sdb", 1_000, 0)],
            t0,
        );
        // sdb unplugged, sdc hot-plugged with a lifetime of traffic behind it.
        let rates = sampler.sample(
            vec![counters("sda", 1_100, 0), counters("sdc", 9_000_000, 0)],
            t0 + Duration::from_secs(1),
        );
        assert_eq!(rates, (100 * 512, 0));
    }

    #[test]
    fn zero_elapsed_time_reports_zero() {
        let mut sampler = DiskIoSampler::new();
        let t0 = Instant::now();
        sampler.sample(vec![counters("sda", 1_000, 0)], t0);
        assert_eq!(sampler.sample(vec![counters("sda", 2_000, 0)], t0), (0, 0));
    }

    #[test]
    fn collect_disk_metrics_with_fresh_disks_returns_zero_rates() {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mut sampler = DiskIoSampler::new();
        let metrics = collect_disk_metrics(&disks, &mut sampler);
        assert_eq!(metrics.read_bytes_per_sec, 0);
        assert_eq!(metrics.write_bytes_per_sec, 0);
    }
}

#[cfg(test)]
mod serde_tests {
    use crate::metrics::DiskMetrics;

    #[test]
    fn disk_metrics_serializes_to_the_unchanged_ws_shape() {
        let metrics = DiskMetrics {
            name: Some("/dev/nvme0n1p2".to_string()),
            read_bytes_per_sec: 450_560,
            write_bytes_per_sec: 225_280,
        };
        assert_eq!(
            serde_json::to_string(&metrics).unwrap(),
            r#"{"name":"/dev/nvme0n1p2","read_bytes_per_sec":450560,"write_bytes_per_sec":225280}"#
        );
    }
}
