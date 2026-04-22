use crate::metrics::MemoryMetrics;

/// Returns `true` when GPU VRAM total is within 10% of system RAM total — the
/// signature of a unified-memory system (e.g. DGX Spark GB10, GH200, Jetson)
/// where CPU and GPU share one physical pool. Discrete GPUs (PCIe cards) report
/// VRAM that is a small fraction of system RAM and return `false`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn detect_unified_memory(gpu_total_bytes: Option<u64>, sys_total_bytes: u64) -> bool {
    let Some(gpu_total) = gpu_total_bytes else {
        return false;
    };
    if sys_total_bytes == 0 {
        return false;
    }
    let diff = gpu_total.abs_diff(sys_total_bytes) as f64;
    let tolerance = sys_total_bytes as f64 * 0.10;
    diff <= tolerance
}

/// Collect memory metrics from /proc/meminfo, and GPU VRAM from NVML when a
/// device is available. Detects unified vs discrete memory topology by
/// comparing NVML VRAM total to system RAM total.
#[cfg(target_os = "linux")]
pub fn collect_memory_metrics(device: &Option<nvml_wrapper::Device>) -> MemoryMetrics {
    use crate::metrics::gpu::nvml_optional;
    use procfs::Current;

    // Primary source: /proc/meminfo for system RAM
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

    // GPU VRAM total/used via NVML (accurate on discrete GPUs; on unified-memory
    // systems this reports the same pool as /proc/meminfo).
    let (gpu_memory_total_bytes, gpu_memory_used_bytes) = device
        .as_ref()
        .and_then(|d| nvml_optional(d.memory_info()))
        .map(|info| (Some(info.total), Some(info.used)))
        .unwrap_or((None, None));

    // Estimate GPU memory from running compute processes (process-list sum).
    // Retained because it's the only per-process breakdown signal we have —
    // useful on unified-memory systems where memory_info mirrors /proc/meminfo.
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

    let is_unified = detect_unified_memory(gpu_memory_total_bytes, total_bytes);

    MemoryMetrics {
        total_bytes,
        used_bytes,
        available_bytes,
        cached_bytes,
        gpu_estimated_bytes,
        gpu_memory_total_bytes,
        gpu_memory_used_bytes,
        is_unified,
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
        gpu_memory_total_bytes: None,
        gpu_memory_used_bytes: None,
        is_unified: cfg!(target_os = "macos"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    #[test]
    fn detect_unified_returns_true_when_gpu_equals_system() {
        assert!(detect_unified_memory(Some(128 * GB), 128 * GB));
    }

    #[test]
    fn detect_unified_returns_true_within_tolerance() {
        // GB10 reports a few GB less than system total for reserved regions
        assert!(detect_unified_memory(Some(120 * GB), 128 * GB));
    }

    #[test]
    fn detect_unified_returns_false_for_discrete_gpu() {
        // 24GB discrete VRAM on a 128GB workstation
        assert!(!detect_unified_memory(Some(24 * GB), 128 * GB));
    }

    #[test]
    fn detect_unified_returns_false_for_80gb_discrete_on_large_host() {
        // H100 80GB PCIe in a 512GB server
        assert!(!detect_unified_memory(Some(80 * GB), 512 * GB));
    }

    #[test]
    fn detect_unified_returns_false_when_gpu_missing() {
        assert!(!detect_unified_memory(None, 128 * GB));
    }

    #[test]
    fn detect_unified_returns_false_when_system_total_zero() {
        assert!(!detect_unified_memory(Some(128 * GB), 0));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_memory_metrics_none_device_reads_meminfo() {
        let metrics = collect_memory_metrics(&None);
        // On Linux, /proc/meminfo should be available so total > 0
        assert!(metrics.total_bytes > 0);
        assert!(metrics.available_bytes > 0);
        assert!(metrics.gpu_estimated_bytes.is_none());
        assert!(metrics.gpu_memory_total_bytes.is_none());
        assert!(metrics.gpu_memory_used_bytes.is_none());
        // Without a GPU device we cannot be on a unified-memory system
        assert!(!metrics.is_unified);
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
