use crate::metrics::MemoryMetrics;

/// Collect unified memory metrics from /proc/meminfo and estimate GPU usage from NVML.
#[cfg(target_os = "linux")]
pub fn collect_memory_metrics(device: &Option<nvml_wrapper::Device>) -> MemoryMetrics {
    use crate::metrics::gpu::nvml_optional;
    use procfs::Current;

    // Primary source: /proc/meminfo for unified memory pool
    let meminfo = procfs::Meminfo::current();

    let (total_bytes, available_bytes, cached_bytes) = match &meminfo {
        Ok(m) => {
            let total = m.mem_total;
            let available = m.mem_available.unwrap_or(0);
            let cached = m.cached;
            (total, available, cached)
        }
        Err(e) => {
            tracing::warn!("Failed to read /proc/meminfo: {}", e);
            (0, 0, 0)
        }
    };

    let used_bytes = total_bytes.saturating_sub(available_bytes);

    // Estimate GPU memory from running compute processes
    let gpu_estimated_bytes = device.as_ref().and_then(|d| {
        nvml_optional(d.running_compute_processes()).map(|procs| {
            procs
                .iter()
                .map(|p| match p.used_gpu_memory {
                    nvml_wrapper::enums::device::UsedGpuMemory::Used(bytes) => bytes,
                    nvml_wrapper::enums::device::UsedGpuMemory::Unavailable => 0,
                })
                .sum::<u64>()
        })
    });

    MemoryMetrics {
        total_bytes,
        used_bytes,
        available_bytes,
        cached_bytes,
        gpu_estimated_bytes,
        is_unified: true, // DGX Spark always has unified memory
    }
}

/// Memory metrics collector for non-Linux platforms using sysinfo.
#[cfg(not(target_os = "linux"))]
pub fn collect_memory_metrics(sys: &sysinfo::System) -> MemoryMetrics {
    let total_bytes = sys.total_memory();
    let available_bytes = sys.available_memory();
    let used_bytes = sys.used_memory();

    MemoryMetrics {
        total_bytes,
        used_bytes,
        available_bytes,
        cached_bytes: total_bytes
            .saturating_sub(used_bytes)
            .saturating_sub(available_bytes),
        gpu_estimated_bytes: None,
        is_unified: cfg!(target_os = "macos"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_memory_metrics_none_device_reads_meminfo() {
        let metrics = collect_memory_metrics(&None);
        // On Linux, /proc/meminfo should be available so total > 0
        assert!(metrics.total_bytes > 0);
        assert!(metrics.available_bytes > 0);
        assert!(metrics.gpu_estimated_bytes.is_none());
        assert!(metrics.is_unified);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn collect_memory_metrics_returns_real_values() {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let metrics = collect_memory_metrics(&sys);
        assert!(metrics.total_bytes > 0);
        assert!(metrics.available_bytes > 0);
    }
}
