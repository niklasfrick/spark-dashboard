use crate::metrics::{CoreMetrics, CpuMetrics};

/// Collect CPU usage metrics from a persistent sysinfo System instance.
/// The System must have had `refresh_cpu_usage()` called at least twice with a gap
/// between calls for accurate delta-based readings.
pub fn collect_cpu_metrics(sys: &sysinfo::System) -> CpuMetrics {
    let cpus = sys.cpus();
    let aggregate_percent = sys.global_cpu_usage();

    let name = cpus
        .first()
        .map(|c| c.brand().to_string())
        .filter(|b| !b.is_empty());

    let per_core: Vec<CoreMetrics> = cpus
        .iter()
        .enumerate()
        .map(|(id, cpu)| CoreMetrics {
            id,
            usage_percent: cpu.cpu_usage(),
        })
        .collect();

    CpuMetrics {
        name,
        aggregate_percent,
        per_core,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_cpu_metrics_returns_valid_struct() {
        let sys = sysinfo::System::new();
        let metrics = collect_cpu_metrics(&sys);
        // First call without refresh returns 0.0, which is valid
        assert!(metrics.aggregate_percent >= 0.0);
        // per_core should have entries for each logical CPU
        // (may be empty if sysinfo hasn't been refreshed)
    }

    #[test]
    fn collect_cpu_metrics_after_refresh_has_cores() {
        use sysinfo::System;
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        std::thread::sleep(std::time::Duration::from_millis(200));
        sys.refresh_cpu_usage();

        let metrics = collect_cpu_metrics(&sys);
        // After refresh, we should have per-core data
        assert!(!metrics.per_core.is_empty());
    }
}
