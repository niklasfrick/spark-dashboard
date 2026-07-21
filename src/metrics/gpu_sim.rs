//! Fictive-GPU simulator (development aid).
//!
//! `--simulate-gpus N` appends N synthetic GPUs after the real NVML devices so
//! multi-GPU UI paths (per-GPU history, selector, event overlays) can be
//! exercised on single-GPU hosts. The simulated entries flow through the exact
//! same `MetricsSnapshot.gpus` / `gpu_events` wire path as real devices — the
//! frontend cannot tell them apart except by name.
//!
//! All values are pure functions of `(index, timestamp_ms)`: smooth sine waves
//! over a 5-minute cycle (matching the UI's default history window), phase-
//! shifted per index so multiple fictive GPUs visibly differ. No RNG, no state
//! — restarts and unit tests are deterministic.

use crate::metrics::gpu::GpuEvent;
use crate::metrics::GpuMetrics;

/// One full utilization swing takes this long — the UI's default chart window,
/// so a single screen shows a complete wave.
const CYCLE_SECONDS: f64 = 300.0;
const POWER_LIMIT_WATTS: f64 = 300.0;
const VRAM_TOTAL_BYTES: u64 = 48 * 1024 * 1024 * 1024;
/// Simulated temperature at or above this emits a `thermal` event each poll —
/// mirroring NVML, where an active throttle reason reappears on every read.
/// Reached near utilization peaks (~30s per cycle).
const THERMAL_EVENT_CELSIUS: u32 = 79;

/// Utilization in percent as a smooth 5..95 wave, phase-shifted per index.
fn utilization(index: u32, timestamp_ms: u64) -> f64 {
    let t = timestamp_ms as f64 / 1000.0;
    let phase = t * std::f64::consts::TAU / CYCLE_SECONDS + f64::from(index) * 2.1;
    50.0 + 45.0 * phase.sin()
}

/// Temperature in °C derived from utilization: 44 at idle, 80 at peak.
fn temperature(index: u32, timestamp_ms: u64) -> u32 {
    (42.0 + utilization(index, timestamp_ms) * 0.4).round() as u32
}

/// Build `count` fictive GPUs with indices `base_index..base_index + count`.
///
/// `base_index` should be the number of GPUs NVML reports so simulated indices
/// never collide with real devices.
pub fn simulated_gpus(count: u32, base_index: u32, timestamp_ms: u64) -> Vec<GpuMetrics> {
    (0..count)
        .map(|offset| {
            let index = base_index + offset;
            let util = utilization(index, timestamp_ms);
            let clock_mhz = (1200.0 + util * 14.0).round() as u32;
            GpuMetrics {
                index: Some(index),
                name: Some(format!("Simulated GPU {index}")),
                utilization_percent: Some(util.round() as u32),
                memory_total_bytes: Some(VRAM_TOTAL_BYTES),
                memory_used_bytes: Some(
                    (VRAM_TOTAL_BYTES as f64 * (0.3 + 0.5 * util / 100.0)) as u64,
                ),
                temperature_celsius: Some(temperature(index, timestamp_ms)),
                power_watts: Some(POWER_LIMIT_WATTS * (0.2 + 0.7 * util / 100.0)),
                power_limit_watts: Some(POWER_LIMIT_WATTS),
                clock_graphics_mhz: Some(clock_mhz),
                clock_sm_mhz: Some(clock_mhz),
                clock_memory_mhz: Some(9001),
                fan_speed_percent: Some((30.0 + util / 2.0).round() as u32),
            }
        })
        .collect()
}

/// Thermal events for fictive GPUs currently above the event threshold.
///
/// Indexed with the same scheme as [`simulated_gpus`], so overlays land on the
/// simulated device that "caused" them.
pub fn simulated_gpu_events(count: u32, base_index: u32, timestamp_ms: u64) -> Vec<GpuEvent> {
    (0..count)
        .filter_map(|offset| {
            let index = base_index + offset;
            (temperature(index, timestamp_ms) >= THERMAL_EVENT_CELSIUS).then(|| GpuEvent {
                timestamp_ms,
                gpu_index: Some(index),
                event_type: "thermal".into(),
                detail: format!("Simulated thermal throttling (GPU {index})"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // For index 0 the utilization wave is sin(t·2π/300): peak (95%) at t=75s,
    // trough (5%) at t=225s. The peak/trough timestamps below rely on that.
    const PEAK_MS: u64 = 75_000;
    const TROUGH_MS: u64 = 225_000;

    #[test]
    fn simulated_gpus_assigns_sequential_indices_after_base() {
        let gpus = simulated_gpus(2, 1, 0);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].index, Some(1));
        assert_eq!(gpus[1].index, Some(2));
        assert_eq!(gpus[0].name.as_deref(), Some("Simulated GPU 1"));
        assert_eq!(gpus[1].name.as_deref(), Some("Simulated GPU 2"));
    }

    #[test]
    fn simulated_gpus_zero_count_is_empty() {
        assert!(simulated_gpus(0, 1, PEAK_MS).is_empty());
        assert!(simulated_gpu_events(0, 1, PEAK_MS).is_empty());
    }

    #[test]
    fn simulated_values_stay_in_plausible_ranges() {
        // Sample across a full cycle at poll granularity.
        for t_ms in (0..300_000).step_by(1_000) {
            for gpu in simulated_gpus(3, 1, t_ms) {
                let util = gpu.utilization_percent.unwrap();
                assert!(util <= 100, "util {util} out of range at t={t_ms}");
                let temp = gpu.temperature_celsius.unwrap();
                assert!((40..=85).contains(&temp), "temp {temp} out of range at t={t_ms}");
                let power = gpu.power_watts.unwrap();
                assert!(power > 0.0 && power <= gpu.power_limit_watts.unwrap());
                assert!(gpu.memory_used_bytes.unwrap() <= gpu.memory_total_bytes.unwrap());
            }
        }
    }

    #[test]
    fn simulation_is_deterministic() {
        let a = simulated_gpus(2, 1, 123_456);
        let b = simulated_gpus(2, 1, 123_456);
        assert_eq!(format!("{a:?}"), format!("{b:?}"));
    }

    #[test]
    fn phase_shift_makes_simulated_gpus_differ() {
        let gpus = simulated_gpus(2, 1, PEAK_MS);
        assert_ne!(gpus[0].utilization_percent, gpus[1].utilization_percent);
    }

    #[test]
    fn thermal_event_fires_at_utilization_peak_with_gpu_index() {
        let events = simulated_gpu_events(1, 0, PEAK_MS);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gpu_index, Some(0));
        assert_eq!(events[0].event_type, "thermal");
        assert_eq!(events[0].timestamp_ms, PEAK_MS);
    }

    #[test]
    fn no_thermal_event_at_utilization_trough() {
        assert!(simulated_gpu_events(1, 0, TROUGH_MS).is_empty());
    }
}
