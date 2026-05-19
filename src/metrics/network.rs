use crate::metrics::NetworkMetrics;
use std::net::IpAddr;

/// Interface prefixes/names that are virtual (loopback, containers, VPNs, bridges).
/// Physical / Wi-Fi names (`en*`, `eth*`, `wl*`, `wlan*`, `ww*`, `ib*`) are intentionally
/// absent so they are never classified as virtual.
const VIRTUAL_PREFIXES: &[&str] = &[
    "lo",
    "docker",
    "veth",
    "br-",
    "virbr",
    "vnet",
    "vmnet",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "utun",
    "llw",
    "awdl",
    "bridge",
    "gif",
    "stf",
    "anpi",
    "cni",
    "flannel",
    "cali",
    "cilium",
    "kube",
    "dummy",
    "ifb",
    "lxc",
    "lxd",
    "nerdctl",
];

/// Flattened, testable view of one network interface.
struct InterfaceInfo {
    name: String,
    rx: u64,
    tx: u64,
    has_global_ip: bool,
    is_virtual: bool,
}

/// True for loopback and common virtual devices (containers, VPNs, bridges).
fn is_virtual_interface(name: &str) -> bool {
    VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// True if the address is globally routable enough to mark an interface as "real"
/// (not loopback, not unspecified, not link-local).
fn is_global_ip(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local(),
        IpAddr::V6(v6) => {
            // fe80::/10 is link-local for IPv6.
            let is_link_local = (v6.segments()[0] & 0xffc0) == 0xfe80;
            !v6.is_loopback() && !v6.is_unspecified() && !is_link_local
        }
    }
}

/// Collect aggregate network I/O throughput metrics from sysinfo Networks.
/// Since we refresh every ~1 second, the delta values approximate bytes/sec.
pub fn collect_network_metrics(networks: &sysinfo::Networks) -> NetworkMetrics {
    let interfaces: Vec<InterfaceInfo> = networks
        .iter()
        .map(|(iface, data)| InterfaceInfo {
            name: iface.to_string(),
            rx: data.received(),
            tx: data.transmitted(),
            has_global_ip: data.ip_networks().iter().any(|n| is_global_ip(&n.addr)),
            is_virtual: is_virtual_interface(iface),
        })
        .collect();

    select_network_metrics(&interfaces)
}

/// Pick the primary interface name and scope rx/tx totals to real (non-virtual)
/// interfaces. Falls back to the all-interfaces, most-traffic behavior only when no
/// real interface exists (headless/offline edge), so the result is always defined.
fn select_network_metrics(interfaces: &[InterfaceInfo]) -> NetworkMetrics {
    let mut candidates = interfaces.iter().filter(|i| !i.is_virtual).peekable();

    if candidates.peek().is_some() {
        let mut total_rx: u64 = 0;
        let mut total_tx: u64 = 0;
        let mut best: Option<&InterfaceInfo> = None;

        for iface in interfaces.iter().filter(|i| !i.is_virtual) {
            total_rx += iface.rx;
            total_tx += iface.tx;
            let better = match best {
                None => true,
                Some(b) => {
                    (iface.has_global_ip, iface.rx + iface.tx) > (b.has_global_ip, b.rx + b.tx)
                }
            };
            if better {
                best = Some(iface);
            }
        }

        return NetworkMetrics {
            name: best.map(|i| i.name.clone()),
            rx_bytes_per_sec: total_rx,
            tx_bytes_per_sec: total_tx,
        };
    }

    // Fallback: no real interface — preserve legacy all-interfaces behavior.
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;
    let mut max_traffic: u64 = 0;
    let mut primary_name: Option<String> = None;

    for iface in interfaces {
        let traffic = iface.rx + iface.tx;
        total_rx += iface.rx;
        total_tx += iface.tx;
        if primary_name.is_none() || traffic > max_traffic {
            max_traffic = traffic;
            primary_name = Some(iface.name.clone());
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

    fn iface(name: &str, rx: u64, tx: u64, has_global_ip: bool, is_virtual: bool) -> InterfaceInfo {
        InterfaceInfo {
            name: name.to_string(),
            rx,
            tx,
            has_global_ip,
            is_virtual,
        }
    }

    #[test]
    fn only_loopback_falls_back_to_loopback() {
        let ifaces = [iface("lo", 100, 200, false, true)];
        let m = select_network_metrics(&ifaces);
        assert_eq!(m.name.as_deref(), Some("lo"));
        assert_eq!(m.rx_bytes_per_sec, 100);
        assert_eq!(m.tx_bytes_per_sec, 200);
    }

    #[test]
    fn picks_real_interface_and_excludes_virtual_from_totals() {
        let ifaces = [
            iface("lo", 9_000, 9_000, false, true),
            iface("eth0", 100, 200, true, false),
            iface("docker0", 5_000, 5_000, false, true),
        ];
        let m = select_network_metrics(&ifaces);
        assert_eq!(m.name.as_deref(), Some("eth0"));
        // lo and docker0 excluded.
        assert_eq!(m.rx_bytes_per_sec, 100);
        assert_eq!(m.tx_bytes_per_sec, 200);
    }

    #[test]
    fn breaks_ties_by_traffic_among_global_interfaces() {
        let ifaces = [
            iface("lo", 0, 0, false, true),
            iface("wlan0", 10, 10, true, false),
            iface("eth0", 1_000, 1_000, true, false),
        ];
        let m = select_network_metrics(&ifaces);
        assert_eq!(m.name.as_deref(), Some("eth0"));
        assert_eq!(m.rx_bytes_per_sec, 1_010);
        assert_eq!(m.tx_bytes_per_sec, 1_010);
    }

    #[test]
    fn non_virtual_beats_virtual_even_without_global_ip() {
        let ifaces = [
            iface("eth0", 5, 5, false, false),
            iface("lo", 9_999, 9_999, false, true),
        ];
        let m = select_network_metrics(&ifaces);
        assert_eq!(m.name.as_deref(), Some("eth0"));
        assert_eq!(m.rx_bytes_per_sec, 5);
        assert_eq!(m.tx_bytes_per_sec, 5);
    }

    #[test]
    fn empty_yields_none_and_zero() {
        let m = select_network_metrics(&[]);
        assert_eq!(m.name, None);
        assert_eq!(m.rx_bytes_per_sec, 0);
        assert_eq!(m.tx_bytes_per_sec, 0);
    }

    #[test]
    fn virtual_classification() {
        for v in [
            "lo",
            "lo0",
            "docker0",
            "veth1234",
            "br-abc123",
            "virbr0",
            "tailscale0",
            "tun0",
            "wg0",
            "utun3",
        ] {
            assert!(is_virtual_interface(v), "{v} should be virtual");
        }
        for r in [
            "eth0", "enp3s0", "wlan0", "wlp2s0", "enP4p1s0", "ib0", "wwan0",
        ] {
            assert!(!is_virtual_interface(r), "{r} should not be virtual");
        }
    }

    #[test]
    fn global_ip_detection() {
        use std::net::{Ipv4Addr, Ipv6Addr};
        assert!(is_global_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 77))));
        assert!(!is_global_ip(&IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_global_ip(&IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(!is_global_ip(&IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(!is_global_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_global_ip(&IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(is_global_ip(&IpAddr::V6(Ipv6Addr::new(
            0x2001, 0xdb8, 0, 0, 0, 0, 0, 1
        ))));
    }

    #[test]
    fn collect_network_metrics_with_fresh_networks_returns_zero_or_valid() {
        let networks = sysinfo::Networks::new_with_refreshed_list();
        let metrics = collect_network_metrics(&networks);
        // First reading returns delta since process start, should be finite.
        assert!(metrics.rx_bytes_per_sec < u64::MAX);
        assert!(metrics.tx_bytes_per_sec < u64::MAX);
    }
}
