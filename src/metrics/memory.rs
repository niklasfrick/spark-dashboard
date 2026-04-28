use crate::metrics::MemoryMetrics;

/// Returns `true` when CPU and GPU share one physical memory pool, by either:
/// - GPU name matching a known unified-memory family (Grace Blackwell GB10/GB200,
///   Grace Hopper GH200, Jetson Orin/Xavier, Tegra) — needed because NVML's
///   `memory_info()` returns `NotSupported` on GB10, so the size-comparison
///   heuristic alone fails on Spark; or
/// - NVML-reported VRAM total within 10% of system RAM total — covers future
///   unified-memory devices we haven't enumerated by name.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn detect_unified_memory(
    gpu_name: Option<&str>,
    gpu_total_bytes: Option<u64>,
    sys_total_bytes: u64,
) -> bool {
    if matches_unified_gpu_name(gpu_name) {
        return true;
    }
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

/// Case-insensitive check for known unified-memory NVIDIA platforms. Covers
/// every shipping family where CPU and GPU share one physical pool — Grace
/// CPU superchips, the Jetson edge SoCs (current + legacy), DRIVE automotive
/// SoCs, and the DGX Spark workstation.
fn matches_unified_gpu_name(name: Option<&str>) -> bool {
    const UNIFIED_FAMILIES: &[&str] = &[
        // --- Grace / Grace Blackwell / Grace Hopper superchips ---
        "GB10",  // DGX Spark (Grace Blackwell desktop)
        "GB200", // Grace Blackwell datacenter superchip
        "GB300", // Grace Blackwell Ultra (next-gen)
        "GH200", // Grace Hopper superchip
        "Grace", // Catch-all for any Grace-CPU SKU
        "Spark", // DGX Spark system identifier (some NVML builds expose this)
        // --- Jetson edge SoCs (all unified Tegra-based) ---
        "Jetson", // Generic Jetson prefix
        "Tegra",  // Underlying SoC family — covers TX1/Nano (Tegra X1) etc.
        "Orin",   // Jetson Orin AGX / NX / Nano
        "Xavier", // Jetson Xavier AGX / NX
        "Thor",   // Jetson Thor (Blackwell-based, upcoming)
        "TX1",    // Jetson TX1 (legacy)
        "TX2",    // Jetson TX2 (legacy)
        "Nano",   // Jetson Nano variants
        "AGX",    // AGX form factor — Jetson AGX *, DRIVE AGX *
        // --- NVIDIA DRIVE (automotive) ---
        "DRIVE", // DRIVE AGX Pegasus / Xavier / Orin / Thor
    ];
    let Some(name) = name else { return false };
    let lower = name.to_ascii_lowercase();
    UNIFIED_FAMILIES
        .iter()
        .any(|family| lower.contains(&family.to_ascii_lowercase()))
}

/// Round a kernel-visible byte count up to the marketed capacity. NVIDIA's
/// unified-memory platforms reserve a few GiB of the physical pool for firmware
/// and GPU carve-outs before exposing memory to Linux, so `MemTotal` is always
/// a few GiB shy of the marketing spec (e.g. 122 GiB visible on a "128 GB"
/// Spark, 56 GiB visible on a "64 GB" Orin AGX). All shipping SKUs are
/// power-of-two GiB, so rounding up to the next power of two recovers the
/// marketed value reliably.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn round_up_to_marketed_gib(bytes: u64) -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    if bytes == 0 {
        return 0;
    }
    let gib_ceil = bytes.div_ceil(GIB);
    let next_pow2 = gib_ceil.next_power_of_two();
    next_pow2.saturating_mul(GIB)
}

/// Choose the byte count the UI should headline.
/// - If NVML reports a total ≥ kernel total (the full hardware pool on systems
///   where `memory_info()` works), use it directly.
/// - Otherwise, on unified-memory systems, round MemTotal up to the marketed
///   capacity — needed for GB10 where NVML's `memory_info()` returns
///   `NotSupported` and `/proc/meminfo` shows ~122 GiB on a 128 GB box.
/// - Otherwise fall back to the kernel-visible total.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn select_display_total(
    is_unified: bool,
    gpu_total_bytes: Option<u64>,
    sys_total_bytes: u64,
) -> u64 {
    if let Some(nvml_total) = gpu_total_bytes {
        if nvml_total >= sys_total_bytes {
            return nvml_total;
        }
    }
    if is_unified {
        return round_up_to_marketed_gib(sys_total_bytes);
    }
    sys_total_bytes
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
    // systems this reports the same pool as /proc/meminfo, and on GB10 it
    // returns NotSupported entirely).
    let (gpu_memory_total_bytes, gpu_memory_used_bytes) = device
        .as_ref()
        .and_then(|d| nvml_optional(d.memory_info()))
        .map(|info| (Some(info.total), Some(info.used)))
        .unwrap_or((None, None));

    // GPU name powers the unified-memory family check (Grace/GB10/Jetson/etc.)
    // when NVML's memory_info isn't available to do the size-comparison check.
    let gpu_name = device.as_ref().and_then(|d| nvml_optional(d.name()));

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

    let is_unified =
        detect_unified_memory(gpu_name.as_deref(), gpu_memory_total_bytes, total_bytes);
    let display_total_bytes = select_display_total(is_unified, gpu_memory_total_bytes, total_bytes);

    MemoryMetrics {
        total_bytes,
        display_total_bytes,
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
        display_total_bytes: total_bytes,
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

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn detect_unified_returns_true_when_gpu_equals_system() {
        assert!(detect_unified_memory(None, Some(128 * GB), 128 * GB));
    }

    #[test]
    fn detect_unified_returns_true_within_tolerance() {
        // Older size-comparison heuristic: GPU reports a few GB less than system.
        assert!(detect_unified_memory(None, Some(120 * GB), 128 * GB));
    }

    #[test]
    fn detect_unified_returns_false_for_discrete_gpu() {
        // 24GB discrete VRAM on a 128GB workstation, unrecognised name.
        assert!(!detect_unified_memory(
            Some("NVIDIA GeForce RTX 4090"),
            Some(24 * GB),
            128 * GB
        ));
    }

    #[test]
    fn detect_unified_returns_false_for_80gb_discrete_on_large_host() {
        // H100 80GB PCIe in a 512GB server
        assert!(!detect_unified_memory(
            Some("NVIDIA H100 80GB PCIe"),
            Some(80 * GB),
            512 * GB
        ));
    }

    #[test]
    fn detect_unified_returns_false_when_gpu_missing() {
        assert!(!detect_unified_memory(None, None, 128 * GB));
    }

    #[test]
    fn detect_unified_returns_false_when_system_total_zero() {
        assert!(!detect_unified_memory(None, Some(128 * GB), 0));
    }

    #[test]
    fn detect_unified_recognises_gb10_by_name_when_nvml_memory_info_missing() {
        // DGX Spark: NVML returns NotSupported for memory_info, so size check fails.
        // Name match must keep is_unified=true.
        assert!(detect_unified_memory(
            Some("NVIDIA GB10"),
            None,
            130_663_821_312
        ));
    }

    #[test]
    fn detect_unified_recognises_grace_hopper_by_name() {
        assert!(detect_unified_memory(
            Some("NVIDIA GH200 480GB"),
            None,
            500 * GB
        ));
    }

    #[test]
    fn detect_unified_recognises_jetson_by_name() {
        assert!(detect_unified_memory(
            Some("Jetson AGX Orin"),
            None,
            60 * GB
        ));
    }

    #[test]
    fn detect_unified_recognises_extended_nvidia_unified_families() {
        // Spot-check every additional family added beyond the original list.
        for name in [
            "NVIDIA GB200",
            "NVIDIA GB300 Ultra",
            "NVIDIA Jetson Orin Nano",
            "NVIDIA Jetson Xavier NX",
            "NVIDIA Jetson Thor",
            "NVIDIA Jetson TX2",
            "NVIDIA Tegra X1",
            "NVIDIA DRIVE AGX Orin",
            "NVIDIA DGX Spark",
        ] {
            assert!(
                detect_unified_memory(Some(name), None, 32 * GB),
                "{name} should be recognised as unified memory",
            );
        }
    }

    #[test]
    fn detect_unified_still_rejects_discrete_consumer_and_datacenter_gpus() {
        // Regression guard: none of the unified substrings should cross-match
        // discrete cards. Covers consumer (GeForce), workstation (RTX PRO /
        // RTX A / Quadro), and datacenter (H/A/L) lines across Ampere through
        // Blackwell generations.
        for name in [
            // GeForce consumer — Ampere / Ada / Blackwell
            "NVIDIA GeForce RTX 3090",
            "NVIDIA GeForce RTX 3090 Ti",
            "NVIDIA GeForce RTX 4090",
            "NVIDIA GeForce RTX 5090",
            // Workstation
            "NVIDIA RTX A6000",
            "NVIDIA RTX 6000 Ada Generation",
            "NVIDIA RTX PRO 4000 Blackwell",
            "NVIDIA RTX PRO 6000 Blackwell",
            "Quadro RTX 8000",
            // Datacenter
            "NVIDIA H100 80GB PCIe",
            "NVIDIA H200",
            "NVIDIA A100-SXM4-80GB",
            "NVIDIA L40S",
            "NVIDIA L4",
        ] {
            assert!(
                !detect_unified_memory(Some(name), Some(24 * GB), 256 * GB),
                "{name} should NOT be flagged as unified memory",
            );
        }
    }

    #[test]
    fn round_up_to_marketed_gib_handles_spark() {
        // 122 GiB visible -> 128 GiB marketed.
        assert_eq!(round_up_to_marketed_gib(130_663_821_312), 128 * GIB);
    }

    #[test]
    fn round_up_to_marketed_gib_handles_jetson_orin() {
        // 56 GiB visible -> 64 GiB marketed.
        assert_eq!(round_up_to_marketed_gib(56 * GIB), 64 * GIB);
    }

    #[test]
    fn round_up_to_marketed_gib_passes_through_exact_power_of_two() {
        assert_eq!(round_up_to_marketed_gib(128 * GIB), 128 * GIB);
        assert_eq!(round_up_to_marketed_gib(32 * GIB), 32 * GIB);
    }

    #[test]
    fn round_up_to_marketed_gib_zero_is_zero() {
        assert_eq!(round_up_to_marketed_gib(0), 0);
    }

    #[test]
    fn select_display_total_prefers_nvml_when_it_reports_full_pool() {
        // Kernel sees ~122 GiB, NVML reports the full ~128 GiB pool — use NVML.
        let kernel = 131_000_000_000;
        let nvml = 137_438_953_472; // 128 GiB
        assert_eq!(select_display_total(true, Some(nvml), kernel), nvml);
    }

    #[test]
    fn select_display_total_rounds_up_when_unified_and_nvml_missing() {
        // GB10 case: NVML memory_info returns NotSupported.
        let kernel = 130_663_821_312; // ~122 GiB visible to Linux
        assert_eq!(select_display_total(true, None, kernel), 128 * GIB);
    }

    #[test]
    fn select_display_total_ignores_nvml_when_smaller_than_kernel() {
        // Don't trust an NVML total smaller than what Linux already sees.
        let kernel = 130_663_821_312;
        let nvml_smaller = 100 * GIB;
        // Falls through to the unified rounding path.
        assert_eq!(
            select_display_total(true, Some(nvml_smaller), kernel),
            128 * GIB
        );
    }

    #[test]
    fn select_display_total_falls_back_when_not_unified() {
        // Discrete GPU: report the OS-visible total even though NVML has VRAM.
        let kernel = 128 * GB;
        let vram = 24 * GB;
        assert_eq!(select_display_total(false, Some(vram), kernel), kernel);
    }

    #[test]
    fn select_display_total_falls_back_when_nvml_missing_and_not_unified() {
        let kernel = 16 * GB;
        assert_eq!(select_display_total(false, None, kernel), kernel);
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
        // Without NVML we have to fall back to the kernel-visible total.
        assert_eq!(metrics.display_total_bytes, metrics.total_bytes);
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
