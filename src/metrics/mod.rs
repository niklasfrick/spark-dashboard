pub mod cpu;
pub mod disk;
pub mod gpu;
pub mod memory;
pub mod network;

use crate::engines::EngineSnapshot;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// A complete snapshot of all hardware metrics at a point in time.
#[derive(Clone, serde::Serialize, Debug)]
pub struct MetricsSnapshot {
    pub timestamp_ms: u64,
    pub gpu: GpuMetrics,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disk: DiskMetrics,
    pub network: NetworkMetrics,
    pub engines: Vec<EngineSnapshot>,
    pub gpu_events: Vec<gpu::GpuEvent>,
}

/// Runs the metrics collection loop, broadcasting JSON snapshots to all subscribers.
///
/// This function is intended to be spawned as a background tokio task. It maintains
/// persistent sysinfo instances for accurate delta-based metrics (CPU, disk, network).
#[cfg(target_os = "linux")]
pub async fn metrics_collector(
    tx: broadcast::Sender<String>,
    poll_interval_ms: u64,
    gpu_index: u32,
    engine_state: std::sync::Arc<tokio::sync::RwLock<Vec<EngineSnapshot>>>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(poll_interval_ms));

    // Persistent sysinfo instances for delta-based metrics
    let mut sys = sysinfo::System::new();
    let mut networks = sysinfo::Networks::new_with_refreshed_list();
    let mut disks = sysinfo::Disks::new_with_refreshed_list();

    // Initialize NVML (gracefully handle absence)
    let nvml = nvml_wrapper::Nvml::init().ok();
    let device = match nvml.as_ref() {
        Some(n) => {
            let count = n.device_count().unwrap_or(0);
            tracing::info!("NVML initialized: {} GPU(s) available", count);
            if gpu_index >= count {
                tracing::warn!(
                    "--gpu-index {} is out of range (found {} GPU(s)); GPU metrics disabled",
                    gpu_index,
                    count
                );
                None
            } else {
                match n.device_by_index(gpu_index) {
                    Ok(d) => Some(d),
                    Err(e) => {
                        tracing::warn!(
                            "Failed to open GPU at index {}: {} — GPU metrics disabled",
                            gpu_index,
                            e
                        );
                        None
                    }
                }
            }
        }
        None => {
            tracing::warn!("NVML not available -- GPU metrics will be empty");
            None
        }
    };

    // Initial CPU refresh (first reading will be 0%, second will be accurate)
    sys.refresh_cpu_usage();

    loop {
        interval.tick().await;

        // Refresh sysinfo state (MUST use same instances for deltas)
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        networks.refresh(true);
        disks.refresh(true);

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Read latest engine snapshots (non-blocking read from shared state)
        let engines = engine_state.read().await.clone();

        let gpu_events = gpu::detect_gpu_events(&device, timestamp_ms);

        let snapshot = MetricsSnapshot {
            timestamp_ms,
            gpu: gpu::collect_gpu_metrics(&device),
            cpu: cpu::collect_cpu_metrics(&sys),
            memory: memory::collect_memory_metrics(&device),
            disk: disk::collect_disk_metrics(&disks),
            network: network::collect_network_metrics(&networks),
            engines,
            gpu_events,
        };

        match serde_json::to_string(&snapshot) {
            Ok(json) => {
                // Ignore error -- means no receivers connected (normal during startup)
                let _ = tx.send(json);
            }
            Err(e) => {
                tracing::error!("Failed to serialize metrics: {}", e);
            }
        }
    }
}

/// Non-Linux metrics collector stub for development.
#[cfg(not(target_os = "linux"))]
pub async fn metrics_collector(
    tx: broadcast::Sender<String>,
    poll_interval_ms: u64,
    _gpu_index: u32,
    engine_state: std::sync::Arc<tokio::sync::RwLock<Vec<EngineSnapshot>>>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(poll_interval_ms));

    // Persistent sysinfo instances for delta-based metrics
    let mut sys = sysinfo::System::new();
    let mut networks = sysinfo::Networks::new_with_refreshed_list();
    let mut disks = sysinfo::Disks::new_with_refreshed_list();

    tracing::warn!("Running on non-Linux platform -- GPU metrics will be stubs");

    // Initial CPU refresh
    sys.refresh_cpu_usage();

    loop {
        interval.tick().await;

        sys.refresh_cpu_usage();
        sys.refresh_memory();
        networks.refresh(true);
        disks.refresh(true);

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Read latest engine snapshots (non-blocking read from shared state)
        let engines = engine_state.read().await.clone();

        let gpu_events = gpu::detect_gpu_events(timestamp_ms);

        let snapshot = MetricsSnapshot {
            timestamp_ms,
            gpu: gpu::collect_gpu_metrics(),
            cpu: cpu::collect_cpu_metrics(&sys),
            memory: memory::collect_memory_metrics(&sys),
            disk: disk::collect_disk_metrics(&disks),
            network: network::collect_network_metrics(&networks),
            engines,
            gpu_events,
        };

        match serde_json::to_string(&snapshot) {
            Ok(json) => {
                let _ = tx.send(json);
            }
            Err(e) => {
                tracing::error!("Failed to serialize metrics: {}", e);
            }
        }
    }
}

/// GPU metrics collected via NVML.
/// Fields are `Option` because some queries may return `NotSupported` depending on the GPU.
#[derive(Clone, serde::Serialize, Debug)]
pub struct GpuMetrics {
    pub name: Option<String>,
    pub utilization_percent: Option<u32>,
    pub temperature_celsius: Option<u32>,
    pub power_watts: Option<f64>,
    pub power_limit_watts: Option<f64>,
    pub clock_graphics_mhz: Option<u32>,
    pub clock_sm_mhz: Option<u32>,
    pub clock_memory_mhz: Option<u32>,
    pub fan_speed_percent: Option<u32>,
}

/// CPU metrics with aggregate and per-core breakdown.
#[derive(Clone, serde::Serialize, Debug)]
pub struct CpuMetrics {
    pub name: Option<String>,
    pub aggregate_percent: f32,
    pub per_core: Vec<CoreMetrics>,
}

/// Per-core CPU usage.
#[derive(Clone, serde::Serialize, Debug)]
pub struct CoreMetrics {
    pub id: usize,
    pub usage_percent: f32,
}

/// Memory metrics. `is_unified` flags unified-memory systems (e.g. DGX Spark GB10,
/// GH200) where CPU and GPU share one pool; on discrete-GPU systems GPU VRAM is
/// reported separately via `gpu_memory_total_bytes` / `gpu_memory_used_bytes`.
///
/// `display_total_bytes` is the value the UI should show as the headline pool
/// size: on unified systems the kernel reserves a few GiB for firmware/GPU
/// carve-outs, so `total_bytes` (from `/proc/meminfo`) under-reports the
/// marketed capacity. NVML reports the full hardware-addressable unified pool,
/// so we prefer it when available. Used/available stay sourced from the kernel
/// view to keep utilisation percentages honest.
#[derive(Clone, serde::Serialize, Debug)]
pub struct MemoryMetrics {
    pub total_bytes: u64,
    pub display_total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub cached_bytes: u64,
    pub gpu_estimated_bytes: Option<u64>,
    pub gpu_memory_total_bytes: Option<u64>,
    pub gpu_memory_used_bytes: Option<u64>,
    pub is_unified: bool,
}

/// Disk I/O throughput rates.
#[derive(Clone, serde::Serialize, Debug)]
pub struct DiskMetrics {
    pub name: Option<String>,
    pub read_bytes_per_sec: u64,
    pub write_bytes_per_sec: u64,
}

/// Network I/O throughput rates.
#[derive(Clone, serde::Serialize, Debug)]
pub struct NetworkMetrics {
    pub name: Option<String>,
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}
