# Graph Report - .  (2026-08-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1546 nodes · 2978 edges · 101 communities (79 shown, 22 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 28 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `84c6779d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- EngineCard.tsx
- engines/mod.rs
- service.rs
- server.rs
- logs.rs
- TimeSeriesChart.tsx
- ExportSettingsDialog.tsx
- devDependencies
- dependencies
- detector.rs
- hec.rs
- memory.rs
- gpu.rs
- compilerOptions
- config_store.rs
- warmup.rs
- schema.ts
- load.ts
- compilerOptions
- histogram.rs
- metrics/mod.rs
- identity.ts
- cn
- run_exporter
- components.json
- vllm.rs
- demo-load.sh
- Multi-engine vLLM test rig
- VllmAdapter
- Dashboard.tsx
- network.rs
- metrics.ts
- useDashboardConfiguration.ts
- client.ts
- EngineSection.tsx
- Changelog
- engineAggregate.ts
- useDashboardConfiguration.test.tsx
- Running spark-dashboard with Docker
- parse_prometheus_text
- gpu_sim.rs
- Dashboard.multiGpu.test.tsx
- grid.ts
- MockHec
- flush_events
- rotation.ts
- useMetricsHistory.ts
- Spark Dashboard
- spark-dashboard — Claude project rules
- Option
- Install on your Linux host
- App.tsx
- EngineSection
- dev/
- CircularBuffer
- dev.sh
- docker-dev.sh
- Option
- Contributing
- install.sh
- panels.ts
- providerLogo.ts
- Exporter
- Issue tracker: GitHub
- release-please-config.json
- Domain Docs
- MockWebSocket
- healthcheck.rs
- collect_cpu_metrics
- collect_disk_metrics
- useTabRotation.ts
- tsconfig.json
- Cost Analysis & Third-Party Pricing Lookups
- Flip-Card Chart Interaction
- StackedBar.tsx
- vitest.config.ts
- triage-labels.md
- vite.config.ts
- Bytes
- Client
- Duration
- EngineSnapshot
- EngineType
- FnOnce
- GpuEvent
- GpuMetrics
- Instant
- Option
- Receiver
- Vec
- Arc
- IntoResponse
- Path
- Sender

## God Nodes (most connected - your core abstractions)
1. `cn()` - 32 edges
2. `run_exporter()` - 24 edges
3. `spawn()` - 22 edges
4. `compilerOptions` - 21 edges
5. `EngineSnapshot` - 19 edges
6. `AppState` - 19 edges
7. `EngineCard()` - 18 edges
8. `compilerOptions` - 18 edges
9. `EngineState` - 18 edges
10. `parse_prometheus_text()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `EngineTabProps` --references--> `EngineSnapshot`  [EXTRACTED]
  frontend/src/components/engines/EngineTab.tsx → frontend/src/types/metrics.ts
- `DialogOverlay()` --calls--> `cn()`  [EXTRACTED]
  frontend/src/components/ui/dialog.tsx → frontend/src/lib/utils.ts
- `occupancy()` --indirect_call--> `panel()`  [INFERRED]
  frontend/src/lib/dashboard/grid.ts → frontend/src/lib/dashboard/preset.ts
- `readPage()` --indirect_call--> `isRecord()`  [INFERRED]
  frontend/src/lib/dashboard/schema.ts → frontend/src/lib/dashboard/json.ts
- `warmup_tracker_excludes_first_observation_from_percentiles()` --calls--> `percentile()`  [INFERRED]
  src/engines/vllm.rs → src/engines/histogram.rs

## Import Cycles
- 1-file cycle: `src/cli/service.rs -> src/cli/service.rs`
- 2-file cycle: `src/cli/service.rs -> src/main.rs -> src/cli/service.rs`

## Communities (101 total, 22 thin omitted)

### Community 0 - "EngineCard.tsx"
Cohesion: 0.05
Nodes (67): AnimatedCounter(), AnimatedCounterProps, easeOut(), prefersReducedMotion(), decodeTokenSeries(), EngineCard(), EngineCardProps, formatE2eLabel() (+59 more)

### Community 1 - "engines/mod.rs"
Cohesion: 0.08
Nodes (48): Debug, Display, Formatter, HashSet, Send, ago(), ApiKeyResolver, cached_model_is_not_refetched_within_interval() (+40 more)

### Community 2 - "service.rs"
Cohesion: 0.08
Nodes (48): dispatch(), ensure_root_or_reexec(), ensure_user(), group_exists(), install(), install_binary(), install_config(), install_unit() (+40 more)

### Community 3 - "server.rs"
Cohesion: 0.08
Nodes (51): Arc, ConfigStore, FromRef, HeaderName, IntoResponse, Path, Response, Router (+43 more)

### Community 4 - "logs.rs"
Cohesion: 0.08
Nodes (43): Query, buffer_lines(), enable_log_viewer(), find_container(), finished_stream_is_removed_from_registry(), flush_trailing(), flush_trailing_empty_buffer_emits_nothing(), handle_logs_socket() (+35 more)

### Community 5 - "TimeSeriesChart.tsx"
Cohesion: 0.07
Nodes (33): react, BigNumberSparkline, BigNumberSparklineProps, trendIcons, Sparkline, SparklineProps, ChartSeries, DataPoint (+25 more)

### Community 6 - "ExportSettingsDialog.tsx"
Cohesion: 0.08
Nodes (31): ExportSettingsDialog(), ExportSettingsDialogProps, LIGHT_CLASS, ADR-0001, HecStatusDot(), LIGHT_CLASS, ADR-0001, Dialog() (+23 more)

### Community 7 - "devDependencies"
Cohesion: 0.05
Nodes (43): eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks (+35 more)

### Community 8 - "dependencies"
Cohesion: 0.05
Nodes (37): @base-ui/react, class-variance-authority, clsx, dependencies, @base-ui/react, class-variance-authority, clsx, lucide-react (+29 more)

### Community 9 - "detector.rs"
Cohesion: 0.12
Nodes (29): DeploymentMode, OsString, candidate(), detect_by_process(), detect_docker_engines(), detect_engines(), DetectedEngine, docker_merge_keeps_distinct_endpoints_separate() (+21 more)

### Community 10 - "hec.rs"
Cohesion: 0.10
Nodes (30): EngineType, FnOnce, GpuMetrics, Map, MetricsSnapshot, a_host_with_no_engines_is_idle(), a_recent_request_within_the_window_is_active(), a_request_exactly_at_the_window_edge_is_active() (+22 more)

### Community 11 - "memory.rs"
Cohesion: 0.08
Nodes (11): collect_memory_metrics(), collect_memory_metrics_none_device_reads_meminfo(), collect_memory_metrics_returns_real_values(), detect_unified_memory(), matches_unified_gpu_name(), round_up_to_marketed_gib(), Device, MemoryMetrics (+3 more)

### Community 12 - "gpu.rs"
Cohesion: 0.12
Nodes (21): NvmlError, collect_device_pids(), collect_gpu_metrics(), collect_gpu_metrics_for_device(), collect_gpu_metrics_none_device_returns_all_none(), collect_gpu_metrics_stub_returns_stub_name(), detect_gpu_events(), detect_gpu_events_no_device_returns_empty() (+13 more)

### Community 13 - "compilerOptions"
Cohesion: 0.07
Nodes (27): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+19 more)

### Community 14 - "config_store.rs"
Cohesion: 0.15
Nodes (22): PathBuf, a_failed_write_leaves_the_previous_document_intact(), a_missing_state_directory_is_created(), an_unwritable_state_directory_reports_read_only_and_still_reads(), can_still_write(), ConfigStore, delete_removes_the_document_and_load_reports_absent(), delete_succeeds_when_no_document_is_stored() (+14 more)

### Community 15 - "warmup.rs"
Cohesion: 0.18
Nodes (24): ParsedMetrics, String, Vec, active_regression_resets_to_warming(), clone_passthrough(), counter_regression(), first_poll_captures_initial_total_and_warms_up(), HistogramBaseline (+16 more)

### Community 16 - "schema.ts"
Cohesion: 0.16
Nodes (20): BindingResolution, FOLLOW, isGpuIndex(), PanelBinding, readBinding(), PanelGeometry, PanelType, panel() (+12 more)

### Community 17 - "load.ts"
Cohesion: 0.17
Nodes (19): isRecord(), documentVersion(), FAILED, fallback(), fresh(), loadDashboardConfiguration(), tryParseJson(), DASHBOARD_MIGRATION_PATH (+11 more)

### Community 18 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+15 more)

### Community 19 - "histogram.rs"
Cohesion: 0.13
Nodes (16): fraction_le(), fraction_le_above_finite_bounds_caps_at_finite_cum(), fraction_le_at_bucket_boundary(), fraction_le_below_first_bucket_is_linear_from_zero(), fraction_le_interpolates_within_bucket(), fraction_le_threshold_below_first_le_with_zero_or_negative_le(), fraction_le_threshold_well_above_finite_no_inf_saturates(), handles_single_finite_bucket() (+8 more)

### Community 20 - "metrics/mod.rs"
Cohesion: 0.14
Nodes (22): CoreMetrics, CoreMetrics, CpuMetrics, DiskMetrics, GpuMetrics, MemoryMetrics, metrics_collector(), MetricsSnapshot (+14 more)

### Community 21 - "identity.ts"
Cohesion: 0.13
Nodes (11): LogConnState, LogViewer(), LogViewerProps, resolveEngineBinding(), resolveGpuBinding(), UNREADABLE, EngineIdentity, findEngineByEndpoint() (+3 more)

### Community 22 - "cn"
Cohesion: 0.16
Nodes (14): Badge(), badgeVariants, Button(), buttonVariants, Card(), CardAction(), CardContent(), CardDescription() (+6 more)

### Community 23 - "run_exporter"
Cohesion: 0.23
Nodes (18): Duration, FnMut, Receiver, SocketAddr, a_403_counts_as_reachable_with_a_configuration_error(), a_429_queues_the_batch_and_retries_on_the_next_tick(), active_json(), resolve_test_target_falls_back_to_the_stored_token_when_masked_or_empty() (+10 more)

### Community 24 - "components.json"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 25 - "vllm.rs"
Cohesion: 0.12
Nodes (11): format_precision(), format_quant_method(), format_tensor_type_falls_back_to_first_key(), format_tensor_type_prefers_float_dtypes(), format_tensor_type_returns_none_for_empty(), OpenAIModel, OpenAIModelsResponse, Self (+3 more)

### Community 26 - "demo-load.sh"
Cohesion: 0.13
Nodes (10): CHILD_PIDS, ENDPOINTS_RAW, jitter_sleep_ms(), OVERRIDE_MODELS, PROMPT_SEEDS, run_conversation(), demo-load.sh script, shutdown() (+2 more)

### Community 27 - "Multi-engine vLLM test rig"
Cohesion: 0.11
Nodes (18): Chat completion (routes by `model`), Dashboard says "No inference engines detected" even though containers are healthy, Direct per-instance access, Explicit per-upstream paths (debugging only), Generating demo load, Health, List every model, Multi-engine vLLM test rig (+10 more)

### Community 28 - "VllmAdapter"
Cohesion: 0.14
Nodes (12): EngineMetrics, EngineStatus, ModelInfo, Mutex, RequestBuilder, is_expected_hf_miss(), Client, EngineType (+4 more)

### Community 29 - "Dashboard.tsx"
Cohesion: 0.22
Nodes (14): Dashboard(), ElementSize, useElementSize(), formatBytes(), formatGiB(), formatMhz(), formatRate(), computePowerScale() (+6 more)

### Community 30 - "network.rs"
Cohesion: 0.21
Nodes (16): IpAddr, Networks, breaks_ties_by_traffic_among_global_interfaces(), collect_network_metrics(), collect_network_metrics_with_fresh_networks_returns_zero_or_valid(), empty_yields_none_and_zero(), iface(), InterfaceInfo (+8 more)

### Community 31 - "metrics.ts"
Cohesion: 0.13
Nodes (12): CoreHeatmap, CoreHeatmapProps, CoreMetrics, CpuMetrics, DeploymentMode, DiskMetrics, EngineMetrics, EngineStatus (+4 more)

### Community 32 - "useDashboardConfiguration.ts"
Cohesion: 0.18
Nodes (14): ConfigurationNotices(), describe(), NoticeText, toneClass, DashboardConfigurationState, SAVE_FAILURE_NOTICE, SaveFailureNotice, SaveOutcome (+6 more)

### Community 33 - "client.ts"
Cohesion: 0.18
Nodes (13): useDashboardConfiguration(), CONFIGURATION_URL, fetchStoredConfiguration(), isReadOnly(), READ_ONLY_HEADER, saveStoredConfiguration(), StoredConfiguration, readOnly (+5 more)

### Community 34 - "EngineSection.tsx"
Cohesion: 0.18
Nodes (12): ChartDataPoint, ENGINE_ICON, EngineChartData, GLOBAL_TAB_VALUE, GlobalEngineTab(), GlobalEngineTabProps, Tabs(), TabsContent() (+4 more)

### Community 35 - "Changelog"
Cohesion: 0.28
Nodes (16): [0.10.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.9.0...spark-dashboard-v0.10.0) (2026-06-17), [0.11.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.10.0...spark-dashboard-v0.11.0) (2026-06-18), [0.12.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.11.0...spark-dashboard-v0.12.0) (2026-07-21), [0.13.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.12.0...spark-dashboard-v0.13.0) (2026-07-27), [0.2.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.1.0...spark-dashboard-v0.2.0) (2026-04-20), [0.3.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.2.0...spark-dashboard-v0.3.0) (2026-04-22), [0.4.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.3.0...spark-dashboard-v0.4.0) (2026-04-23), [0.5.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.4.0...spark-dashboard-v0.5.0) (2026-04-25) (+8 more)

### Community 36 - "engineAggregate.ts"
Cohesion: 0.20
Nodes (11): aggregateEngines(), aggregatePercentiles(), emptySnapshot(), groupRunningByProvider(), meanOrNull(), ProviderGroup, NOTE: Cross-engine percentile averaging is approximate — true tail, sumOrNull() (+3 more)

### Community 37 - "useDashboardConfiguration.test.tsx"
Cohesion: 0.19
Nodes (9): configurationResponse(), ConfigurationServerOptions, configurationWrites(), FetchMock, serveConfiguration(), serveNothing(), configurationSettles(), SilentWebSocket (+1 more)

### Community 38 - "Running spark-dashboard with Docker"
Cohesion: 0.13
Nodes (15): Bridge (opt-in), Building / testing locally, Compose, Environment variables, GPU passthrough, Health, Host (default), Networking modes (+7 more)

### Community 39 - "parse_prometheus_text"
Cohesion: 0.17
Nodes (14): captures_histogram_buckets(), captures_inter_token_latency_histogram(), captures_prefix_cache_counters(), missing_prefix_cache_counters_parse_cleanly(), parse_prometheus_text(), HashMap, Option, prefix_cache_queries_roundtrip_from_metrics_body() (+6 more)

### Community 40 - "gpu_sim.rs"
Cohesion: 0.25
Nodes (12): phase_shift_makes_simulated_gpus_differ(), GpuEvent, GpuMetrics, Vec, simulated_gpu_events(), simulated_gpus(), simulated_gpus_assigns_sequential_indices_after_base(), simulated_values_stay_in_plausible_ranges() (+4 more)

### Community 41 - "Dashboard.multiGpu.test.tsx"
Cohesion: 0.16
Nodes (7): EngineSectionProps, DashboardProps, gpu0, gpu1, GpuEvent, InferenceRequest, TIME_WINDOW_SECONDS

### Community 42 - "grid.ts"
Cohesion: 0.30
Nodes (10): cell(), clamp(), firstFreeSlot(), GRID_COLUMNS, GRID_MAX_ROWS, isFree(), isOutOfRoom(), occupancy() (+2 more)

### Community 43 - "MockHec"
Cohesion: 0.18
Nodes (12): AtomicUsize, HeaderMap, JoinHandle, mock_handler(), MockHec, MockState, Bytes, State (+4 more)

### Community 44 - "flush_events"
Cohesion: 0.23
Nodes (12): Client, GpuEvent, build_gpu_event(), build_test_event(), flush_events(), gpu_events_go_to_the_events_index_as_plain_events(), HecTarget, now_ms() (+4 more)

### Community 45 - "rotation.ts"
Cohesion: 0.26
Nodes (11): OPTIONS, TabRotationControl(), TabRotationControlProps, DEFAULT_ROTATION_INTERVAL, isRotationInterval(), parseInterval(), parseRotationState(), RotationInterval (+3 more)

### Community 46 - "useMetricsHistory.ts"
Cohesion: 0.23
Nodes (11): createBuffers(), DataPoint, extractGpuValue(), extractValue(), MetricKey, SYSTEM_METRIC_KEYS, useMetricsHistory(), baseSnapshot (+3 more)

### Community 47 - "Spark Dashboard"
Cohesion: 0.15
Nodes (13): Architecture, Configuration, Contributing, Development, Features, How the proxy works, License, Prerequisites (+5 more)

### Community 48 - "spark-dashboard — Claude project rules"
Cohesion: 0.17
Nodes (11): Agent skills, Branches & PRs, Commits drive releases, Dependencies — pick the latest stable, Domain docs, Issue tracker, Metrics contract (Rust ↔ frontend), Pre-commit checks (run before pushing) (+3 more)

### Community 49 - "Option"
Cohesion: 0.18
Nodes (12): EngineSnapshot, Option, engine_with(), hec_target_from_document(), resolve_test_target(), resolve_test_target_prefers_the_override_over_the_stored_target(), resolve_test_target_uses_the_override_alone_when_nothing_is_stored(), retain_token_in_document() (+4 more)

### Community 50 - "Install on your Linux host"
Cohesion: 0.17
Nodes (12): CLI options, Dashboard configuration API, Develop locally, Install on your Linux host, Log viewer (`--enable-log-viewer`, Linux only, opt-in), Managing the service, Option A — via cargo (recommended), Option B — from a local checkout (+4 more)

### Community 51 - "App.tsx"
Cohesion: 0.31
Nodes (6): App(), ConnectionBadge(), statusConfig, ADR-0001, ConnectionStatus, useMetrics()

### Community 52 - "EngineSection"
Cohesion: 0.29
Nodes (8): EngineSection(), EngineTab(), EngineTabProps, portFromEndpoint(), shortenModelName(), engineDisplayName(), engineKey(), findEngineByKey()

### Community 53 - "dev/"
Cohesion: 0.20
Nodes (10): dev/, `./dev/dev.sh` — development loop, `./dev/docker-dev.sh` — containerized deployment loop, Optional environment variables, Prerequisites, Required environment variables, Scripts, Simulating extra GPUs (+2 more)

### Community 55 - "dev.sh"
Cohesion: 0.50
Nodes (7): build_frontend(), rebuild_backend(), rebuild_embedded(), dev.sh script, sync_backend(), watch_backend(), watch_frontend()

### Community 56 - "docker-dev.sh"
Cohesion: 0.50
Nodes (8): build_local(), deploy_ghcr(), deploy_remote(), needs_remote(), remote_down(), remote_logs(), docker-dev.sh script, usage()

### Community 57 - "Option"
Cohesion: 0.44
Nodes (9): format_param_size(), format_tensor_type(), HfConfig, HfModelResponse, HfQuantizationConfig, HfSafetensors, HashMap, Option (+1 more)

### Community 58 - "Contributing"
Cohesion: 0.25
Nodes (8): Commits and PRs, Contributing, Local setup, One-time repo setup, Releases, Reporting issues, Style, Tests

### Community 59 - "install.sh"
Cohesion: 0.57
Nodes (7): install_from_source(), preflight(), refuse_root(), require(), install.sh script, uninstall(), usage()

### Community 60 - "panels.ts"
Cohesion: 0.50
Nodes (6): defaultPanelTitle(), isKnownPanelType(), PANEL_TYPE_IDS, PANEL_TYPES, PanelBindingKind, PanelTypeSpec

### Community 61 - "providerLogo.ts"
Cohesion: 0.36
Nodes (6): buildLogo(), getProviderLogo(), KEYWORD_FALLBACKS, ORG_ALIAS, ORG_IDENTITY, SLUG_EXTENSION

### Community 62 - "Exporter"
Cohesion: 0.32
Nodes (7): Instant, Exporter, ExportState, ExportStatus, publish(), SharedExportStatus, VecDeque

### Community 63 - "Issue tracker: GitHub"
Cohesion: 0.29
Nodes (6): Conventions, Issue tracker: GitHub, Pull requests as a triage surface, Wayfinding operations, When a skill says "fetch the relevant ticket", When a skill says "publish to the issue tracker"

### Community 64 - "release-please-config.json"
Cohesion: 0.29
Nodes (6): bump-minor-pre-major, changelog-sections, include-v-in-tag, packages, release-type, $schema

### Community 65 - "Domain Docs"
Cohesion: 0.33
Nodes (5): Before exploring, read these, Domain Docs, File structure, Flag ADR conflicts, Use the glossary's vocabulary

### Community 67 - "healthcheck.rs"
Cohesion: 0.47
Nodes (3): probe(), ExitCode, run()

### Community 68 - "collect_cpu_metrics"
Cohesion: 0.47
Nodes (5): collect_cpu_metrics(), collect_cpu_metrics_after_refresh_has_cores(), collect_cpu_metrics_returns_valid_struct(), CpuMetrics, System

### Community 70 - "collect_disk_metrics"
Cohesion: 0.60
Nodes (4): Disks, collect_disk_metrics(), collect_disk_metrics_with_fresh_disks_returns_zero_or_valid(), DiskMetrics

### Community 71 - "useTabRotation.ts"
Cohesion: 0.40
Nodes (4): ROTATION_INTERVAL_MS, useTabRotation(), UseTabRotationArgs, UseTabRotationResult

### Community 72 - "tsconfig.json"
Cohesion: 0.40
Nodes (4): compilerOptions, paths, files, references

### Community 73 - "Cost Analysis & Third-Party Pricing Lookups"
Cohesion: 0.40
Nodes (4): Cost Analysis & Third-Party Pricing Lookups, Prior requests, What *is* in scope instead, Why this is out of scope

### Community 74 - "Flip-Card Chart Interaction"
Cohesion: 0.50
Nodes (3): Flip-Card Chart Interaction, Prior requests, Why this is out of scope

## Knowledge Gaps
- **297 isolated node(s):** `Why this is out of scope`, `What *is* in scope instead`, `Prior requests`, `Why this is out of scope`, `Prior requests` (+292 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `EngineAdapter` connect `engines/mod.rs` to `logs.rs`, `VllmAdapter`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `VllmAdapter` connect `VllmAdapter` to `vllm.rs`, `warmup.rs`, `engines/mod.rs`, `Option`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `react` connect `TimeSeriesChart.tsx` to `dependencies`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `Why this is out of scope`, `What *is* in scope instead`, `Prior requests` to the rest of the system?**
  _297 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `EngineCard.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.05083986562150056 - nodes in this community are weakly interconnected._
- **Should `engines/mod.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `service.rs` be split into smaller, more focused modules?**
  _Cohesion score 0.07769423558897243 - nodes in this community are weakly interconnected._