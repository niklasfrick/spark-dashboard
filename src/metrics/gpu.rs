use crate::metrics::GpuMetrics;

#[cfg(target_os = "linux")]
use nvml_wrapper::error::NvmlError;
#[cfg(target_os = "linux")]
use tracing::warn;

/// A GPU event detected from NVML throttle reasons.
#[derive(Clone, serde::Serialize, Debug)]
pub struct GpuEvent {
    pub timestamp_ms: u64,
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

/// Collect GPU metrics from an NVML device.
/// Returns all-None GpuMetrics when no device is available.
#[cfg(target_os = "linux")]
pub fn collect_gpu_metrics(device: &Option<nvml_wrapper::Device>) -> GpuMetrics {
    let Some(device) = device else {
        return GpuMetrics {
            name: None,
            utilization_percent: None,
            temperature_celsius: None,
            power_watts: None,
            power_limit_watts: None,
            clock_graphics_mhz: None,
            clock_sm_mhz: None,
            clock_memory_mhz: None,
            fan_speed_percent: None,
        };
    };

    let name = nvml_optional(device.name());

    let utilization_percent = nvml_optional(device.utilization_rates()).map(|u| u.gpu);

    let temperature_celsius = nvml_optional(
        device.temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu),
    );

    // NVML returns milliwatts, convert to watts as f64
    let power_watts = nvml_optional(device.power_usage()).map(|mw| mw as f64 / 1000.0);
    let power_limit_watts =
        nvml_optional(device.power_management_limit()).map(|mw| mw as f64 / 1000.0);

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
        name,
        utilization_percent,
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
    device: &Option<nvml_wrapper::Device>,
    timestamp_ms: u64,
) -> Vec<GpuEvent> {
    let Some(device) = device else {
        return Vec::new();
    };
    let mut events = Vec::new();

    if let Some(reasons) = nvml_optional(device.current_throttle_reasons()) {
        use nvml_wrapper::bitmasks::device::ThrottleReasons;

        if reasons.contains(ThrottleReasons::HW_THERMAL_SLOWDOWN)
            || reasons.contains(ThrottleReasons::SW_THERMAL_SLOWDOWN)
        {
            events.push(GpuEvent {
                timestamp_ms,
                event_type: "thermal".into(),
                detail: "Thermal throttling active".into(),
            });
        }
        if reasons.contains(ThrottleReasons::HW_SLOWDOWN) {
            events.push(GpuEvent {
                timestamp_ms,
                event_type: "throttle".into(),
                detail: "Hardware slowdown engaged".into(),
            });
        }
        if reasons.contains(ThrottleReasons::HW_POWER_BRAKE_SLOWDOWN) {
            events.push(GpuEvent {
                timestamp_ms,
                event_type: "power_brake".into(),
                detail: "Power brake engaged".into(),
            });
        }
        if reasons.contains(ThrottleReasons::SW_POWER_CAP) {
            events.push(GpuEvent {
                timestamp_ms,
                event_type: "throttle".into(),
                detail: "Software power cap limiting clocks".into(),
            });
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
        name: Some("Stub (non-Linux)".to_string()),
        utilization_percent: None,
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
            let metrics = collect_gpu_metrics(&None);
            assert!(metrics.name.is_none());
            assert!(metrics.utilization_percent.is_none());
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
            assert_eq!(metrics.name, Some("Stub (non-Linux)".to_string()));
            assert!(metrics.utilization_percent.is_none());
        }

        #[test]
        fn detect_gpu_events_stub_returns_empty() {
            let events = detect_gpu_events(1000);
            assert!(events.is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_gpu_event_tests {
        use super::*;

        #[test]
        fn detect_gpu_events_no_device_returns_empty() {
            let events = detect_gpu_events(&None, 1000);
            assert!(events.is_empty());
        }
    }
}
