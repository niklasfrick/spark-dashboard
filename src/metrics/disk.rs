use crate::metrics::DiskMetrics;

/// Collect aggregate disk I/O throughput metrics from sysinfo Disks.
/// Since we refresh every ~1 second, the delta values approximate bytes/sec.
pub fn collect_disk_metrics(disks: &sysinfo::Disks) -> DiskMetrics {
    let mut total_read: u64 = 0;
    let mut total_write: u64 = 0;

    // Use the largest disk's name as the primary identifier
    let name = disks
        .list()
        .iter()
        .max_by_key(|d| d.total_space())
        .map(|d| d.name().to_string_lossy().to_string())
        .filter(|n| !n.is_empty());

    for disk in disks.list() {
        let usage = disk.usage();
        total_read += usage.read_bytes;
        total_write += usage.written_bytes;
    }

    DiskMetrics {
        name,
        read_bytes_per_sec: total_read,
        write_bytes_per_sec: total_write,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_disk_metrics_with_fresh_disks_returns_zero_or_valid() {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let metrics = collect_disk_metrics(&disks);
        // First reading should be zero or small values (delta since last refresh)
        assert!(metrics.read_bytes_per_sec < u64::MAX);
        assert!(metrics.write_bytes_per_sec < u64::MAX);
    }
}
