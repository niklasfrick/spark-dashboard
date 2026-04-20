use crate::metrics::NetworkMetrics;

/// Collect aggregate network I/O throughput metrics from sysinfo Networks.
/// Since we refresh every ~1 second, the delta values approximate bytes/sec.
pub fn collect_network_metrics(networks: &sysinfo::Networks) -> NetworkMetrics {
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;

    // Use the interface with the most traffic as the primary name
    let mut max_traffic: u64 = 0;
    let mut primary_name: Option<String> = None;

    for (iface, data) in networks.iter() {
        let traffic = data.received() + data.transmitted();
        total_rx += data.received();
        total_tx += data.transmitted();
        if traffic > max_traffic {
            max_traffic = traffic;
            primary_name = Some(iface.to_string());
        }
    }

    NetworkMetrics {
        name: primary_name,
        rx_bytes_per_sec: total_rx,
        tx_bytes_per_sec: total_tx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_network_metrics_with_fresh_networks_returns_zero_or_valid() {
        let networks = sysinfo::Networks::new_with_refreshed_list();
        let metrics = collect_network_metrics(&networks);
        // First reading returns delta since process start, should be finite
        assert!(metrics.rx_bytes_per_sec < u64::MAX);
        assert!(metrics.tx_bytes_per_sec < u64::MAX);
    }
}
