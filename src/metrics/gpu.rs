use crate::metrics::GpuMetrics;

#[cfg(target_os = "linux")]
use nvml_wrapper::error::NvmlError;
#[cfg(target_os = "linux")]
use tracing::warn;

/// A GPU event detected from NVML throttle reasons.
#[derive(Clone, serde::Serialize, Debug)]
pub struct GpuEvent {
    pub timestamp_ms: u64,
    pub gpu_index: Option<u32>,
    pub event_type: String,
    pub detail: String,
}

/// Converts an NVML result into an Option, treating `NotSupported` as `None`
/// and logging a warning for other errors.
#[cfg(target_os = "linux")]
pub fn nvml_optional<T>(result: Result<T, NvmlError>) -> Option<T> {
    match result {
        Ok(val) => Some(val),
        Err(NvmlError::NotSupported) | Err(NvmlError::InvalidArg) => None,
        Err(e) => {
            warn!("NVML error: {}", e);
            None
        }
    }
}

/// Resolve the GPU power limit (in milliwatts) by trying NVML sources in order
/// of preference, returning the first supported, non-zero value.
///
/// On unified-memory SoCs like the DGX Spark GB10, `power_management_limit()`
/// returns `NotSupported` (nvidia-smi shows `Pwr:Usage/Cap` as `"4W / N/A"`), so
/// we fall through to the enforced/default/constraint limits. Some discrete GPUs
/// or future firmware expose a cap through one of these even when the primary
/// query is unsupported. Returns `None` when no source reports a usable limit.
#[cfg(target_os = "linux")]
fn resolve_power_limit_mw(device: &nvml_wrapper::Device) -> Option<u32> {
    nvml_optional(device.power_management_limit())
        .or_else(|| nvml_optional(device.enforced_power_limit()))
        .or_else(|| nvml_optional(device.power_management_limit_default()))
        .or_else(|| nvml_optional(device.power_management_limit_constraints()).map(|c| c.max_limit))
        .filter(|&mw| mw > 0)
}

/// Empty GPU metric used when NVML or a selected GPU is unavailable.
#[cfg(target_os = "linux")]
pub fn empty_gpu_metrics() -> GpuMetrics {
    GpuMetrics {
        index: None,
        name: None,
        utilization_percent: None,
        memory_total_bytes: None,
        memory_used_bytes: None,
        temperature_celsius: None,
        power_watts: None,
        power_limit_watts: None,
        clock_graphics_mhz: None,
        clock_sm_mhz: None,
        clock_memory_mhz: None,
        fan_speed_percent: None,
    }
}

/// Per-device compute-process PID lists from NVML — the source of truth for
/// engine→GPU association. Devices whose process list is unsupported or
/// unavailable (e.g. unified-memory systems) contribute an empty list.
#[cfg(target_os = "linux")]
pub fn collect_device_pids(devices: &[(u32, nvml_wrapper::Device)]) -> Vec<(u32, Vec<u32>)> {
    devices
        .iter()
        .map(|(index, device)| {
            let pids = nvml_optional(device.running_compute_processes())
                .map(|procs| procs.iter().map(|p| p.pid).collect())
                .unwrap_or_default();
            (*index, pids)
        })
        .collect()
}

/// Map an engine's process IDs to the GPU indexes those processes are
/// observed running on.
///
/// `device_pids` holds, per monitored device, the PIDs from NVML's
/// compute-process list. A PID appearing on several devices (tensor
/// parallel) yields every matching index, sorted and deduplicated. No match
/// — NVML unavailable, empty process lists, engine not yet on a GPU —
/// yields an empty vec so the UI shows nothing rather than a wrong guess.
pub fn gpu_indexes_for_pids(pids: &[u32], device_pids: &[(u32, Vec<u32>)]) -> Vec<u32> {
    let mut indexes: Vec<u32> = device_pids
        .iter()
        .filter(|(_, dev_pids)| dev_pids.iter().any(|p| pids.contains(p)))
        .map(|(index, _)| *index)
        .collect();
    indexes.sort_unstable();
    indexes.dedup();
    indexes
}

/// Collect GPU metrics from all opened NVML devices.
#[cfg(target_os = "linux")]
pub fn collect_gpu_metrics(devices: &[(u32, nvml_wrapper::Device)]) -> Vec<GpuMetrics> {
    devices
        .iter()
        .map(|(index, device)| collect_gpu_metrics_for_device(*index, device))
        .collect()
}

#[cfg(target_os = "linux")]
fn collect_gpu_metrics_for_device(index: u32, device: &nvml_wrapper::Device) -> GpuMetrics {
    let name = nvml_optional(device.name());

    let utilization_percent = nvml_optional(device.utilization_rates()).map(|u| u.gpu);
    let (memory_total_bytes, memory_used_bytes) = nvml_optional(device.memory_info())
        .map(|info| (Some(info.total), Some(info.used)))
        .unwrap_or((None, None));

    let temperature_celsius = nvml_optional(
        device.temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu),
    );

    // NVML returns milliwatts, convert to watts as f64
    let power_watts = nvml_optional(device.power_usage()).map(|mw| mw as f64 / 1000.0);
    let power_limit_watts = resolve_power_limit_mw(device).map(|mw| mw as f64 / 1000.0);

    // Each clock query wrapped individually -- memory clock may be N/A on some GPUs
    let clock_graphics_mhz =
        nvml_optional(device.clock_info(nvml_wrapper::enum_wrappers::device::Clock::Graphics));
    let clock_sm_mhz =
        nvml_optional(device.clock_info(nvml_wrapper::enum_wrappers::device::Clock::SM));
    let clock_memory_mhz =
        nvml_optional(device.clock_info(nvml_wrapper::enum_wrappers::device::Clock::Memory));

    // Fan speed may be N/A on some GPUs (e.g. chassis-managed fans)
    let fan_speed_percent = nvml_optional(device.fan_speed(0));

    GpuMetrics {
        index: Some(index),
        name,
        utilization_percent,
        memory_total_bytes,
        memory_used_bytes,
        temperature_celsius,
        power_watts,
        power_limit_watts,
        clock_graphics_mhz,
        clock_sm_mhz,
        clock_memory_mhz,
        fan_speed_percent,
    }
}

/// Detect GPU throttle/thermal events from NVML throttle reasons.
/// Returns empty vec if no device or no active throttle reasons.
#[cfg(target_os = "linux")]
pub fn detect_gpu_events(
    devices: &[(u32, nvml_wrapper::Device)],
    timestamp_ms: u64,
) -> Vec<GpuEvent> {
    let mut events = Vec::new();

    for (index, device) in devices {
        if let Some(reasons) = nvml_optional(device.current_throttle_reasons()) {
            use nvml_wrapper::bitmasks::device::ThrottleReasons;

            if reasons.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN)
                || reasons.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN)
            {
                events.push(GpuEvent {
                    timestamp_ms,
                    gpu_index: Some(*index),
                    event_type: "thermal".into(),
                    detail: "Thermal throttling active".into(),
                });
            }
            if reasons.contains(ThrottleReasons::HW_SLOWDOWN) {
                events.push(GpuEvent {
                    timestamp_ms,
                    gpu_index: Some(*index),
                    event_type: "throttle".into(),
                    detail: "Hardware slowdown engaged".into(),
                });
            }
            if reasons.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN) {
                events.push(GpuEvent {
                    timestamp_ms,
                    gpu_index: Some(*index),
                    event_type: "power_brake".into(),
                    detail: "Power brake engaged".into(),
                });
            }
            if reasons.contains(ThrottleReasons::SW_POWER_CAP) {
                events.push(GpuEvent {
                    timestamp_ms,
                    gpu_index: Some(*index),
                    event_type: "throttle".into(),
                    detail: "Software power cap limiting clocks".into(),
                });
            }
        }
    }

    events
}

/// Stub GPU event detector for non-Linux platforms (development only).
#[cfg(not(target_os = "linux"))]
pub fn detect_gpu_events(timestamp_ms: u64) -> Vec<GpuEvent> {
    let _ = timestamp_ms;
    Vec::new()
}

/// Stub GPU metrics collector for non-Linux platforms (development only).
#[cfg(not(target_os = "linux"))]
pub fn collect_gpu_metrics() -> GpuMetrics {
    GpuMetrics {
        index: Some(0),
        name: Some("Stub (non-Linux)".to_string()),
        utilization_percent: None,
        memory_total_bytes: None,
        memory_used_bytes: None,
        temperature_celsius: None,
        power_watts: None,
        power_limit_watts: None,
        clock_graphics_mhz: None,
        clock_sm_mhz: None,
        clock_memory_mhz: None,
        fan_speed_percent: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    mod linux_tests {
        use super::*;
        use nvml_wrapper::error::NvmlError;

        #[test]
        fn nvml_optional_returns_some_on_ok() {
            assert_eq!(nvml_optional(Ok::<u32, NvmlError>(42)), Some(42));
        }

        #[test]
        fn nvml_optional_returns_none_on_not_supported() {
            assert_eq!(
                nvml_optional(Err::<u32, NvmlError>(NvmlError::NotSupported)),
                None
            );
        }

        #[test]
        fn collect_gpu_metrics_none_device_returns_all_none() {
            let metrics = empty_gpu_metrics();
            assert!(metrics.index.is_none());
            assert!(metrics.name.is_none());
            assert!(metrics.utilization_percent.is_none());
            assert!(metrics.memory_total_bytes.is_none());
            assert!(metrics.memory_used_bytes.is_none());
            assert!(metrics.temperature_celsius.is_none());
            assert!(metrics.power_watts.is_none());
            assert!(metrics.power_limit_watts.is_none());
            assert!(metrics.clock_graphics_mhz.is_none());
            assert!(metrics.clock_sm_mhz.is_none());
            assert!(metrics.clock_memory_mhz.is_none());
            assert!(metrics.fan_speed_percent.is_none());
        }
    }

    #[cfg(not(target_os = "linux"))]
    mod non_linux_tests {
        use super::*;

        #[test]
        fn collect_gpu_metrics_stub_returns_stub_name() {
            let metrics = collect_gpu_metrics();
            assert_eq!(metrics.index, Some(0));
            assert_eq!(metrics.name, Some("Stub (non-Linux)".to_string()));
            assert!(metrics.utilization_percent.is_none());
            assert!(metrics.memory_total_bytes.is_none());
        }

        #[test]
        fn detect_gpu_events_stub_returns_empty() {
            let events = detect_gpu_events(1000);
            assert!(events.is_empty());
        }
    }

    mod gpu_association_tests {
        use super::*;

        #[test]
        fn engine_pinned_to_one_gpu_yields_that_index() {
            let device_pids = vec![(0, vec![999]), (1, vec![4242, 4243])];
            assert_eq!(gpu_indexes_for_pids(&[4242], &device_pids), vec![1]);
        }

        #[test]
        fn pid_on_two_devices_yields_both_indexes() {
            let device_pids = vec![(0, vec![4242]), (1, vec![4242]), (2, vec![999])];
            assert_eq!(gpu_indexes_for_pids(&[4242], &device_pids), vec![0, 1]);
        }

        #[test]
        fn unknown_pids_yield_empty() {
            let device_pids = vec![(0, vec![999]), (1, vec![998])];
            assert!(gpu_indexes_for_pids(&[4242], &device_pids).is_empty());
        }

        #[test]
        fn empty_device_process_lists_yield_empty() {
            let device_pids = vec![(0, vec![]), (1, vec![])];
            assert!(gpu_indexes_for_pids(&[4242], &device_pids).is_empty());
        }

        #[test]
        fn no_engine_pids_yield_empty() {
            let device_pids = vec![(0, vec![999])];
            assert!(gpu_indexes_for_pids(&[], &device_pids).is_empty());
        }

        #[test]
        fn multiple_engine_pids_on_one_device_dedup_to_one_index() {
            let device_pids = vec![(0, vec![10, 11])];
            assert_eq!(gpu_indexes_for_pids(&[10, 11], &device_pids), vec![0]);
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_gpu_event_tests {
        use super::*;

        #[test]
        fn detect_gpu_events_no_device_returns_empty() {
            let events = detect_gpu_events(&[], 1000);
            assert!(events.is_empty());
        }
    }
}
