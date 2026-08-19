# Graph Report - .  (2026-08-19)

## Corpus Check
- 184 files · ~132,704 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1423 nodes · 2868 edges · 82 communities (72 shown, 10 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.78)
- Token cost: 641,400 input · 0 output

## Community Hubs (Navigation)
- Engine Module Core
- Systemd Service CLI
- HTTP Server & Config API
- Container Log Viewer
- Frontend Chart Components
- Frontend Lint & Toolchain Deps
- Frontend Package Manifest
- Engine Detection (Docker/Native)
- Memory Metrics Collection
- Dashboard View & Sizing
- Engine Card Components
- Dashboard Schema Bindings
- HEC Metric Event Building
- GPU NVML Collection
- TSConfig (App)
- Config Store (State Dir)
- Prometheus Parse & Warmup
- HEC Export UI
- Dashboard Config Client
- TSConfig (Node)
- Latency Histogram Estimation
- Metrics Core & Collector
- HEC Exporter Runtime
- Repo Docs & CI Workflows
- Component Alias Re-exports
- Dashboard Load & Migrations
- Core Header Charts
- vLLM Parameter Formatting
- Dashboard Grid Layout
- Demo Load Generator
- vLLM Adapter Client
- Engine Card Sub-components
- Network Metrics Collection
- Engine Stats & Latency UI
- UI Primitives (Badge/Button/Card)
- HEC Behavior Tests
- Configuration Test Server
- Format Utilities
- Export Dialog Component
- SLO Settings & Goodput
- Prometheus Counter Extraction
- Simulated GPU (Dev)
- HEC Mock Server Tests
- Log Viewer UI
- Tab Rotation Settings
- Engine Global Metrics UI
- Metrics History Buffer
- App Shell & Connection State
- Engine Aggregation Math
- HEC Status & Targets
- HEC Target & I/O
- Configuration Notices UI
- Global Tabs UI
- SLO Settings Dialog
- Circular Buffer (Ring)
- Dev Watch Script
- Docker Dev Script
- HuggingFace Model Config
- Host Installer Script
- Animated Counter UI
- Dashboard Panels Registry
- Release-Please Config
- GPU Power Scaling Math
- Log Viewer Test Mocks
- Healthcheck CLI
- CPU Metrics Collection
- Disk Metrics Collection
- Tooltip UI Primitive
- Export Dialog Tests
- TSConfig (Root)
- Stacked Bar Chart
- Vitest Config
- Out-of-Scope: Cost Analysis
- Out-of-Scope: Flip-Card Charts
- Vite Config
- SPA Entry HTML

## God Nodes (most connected - your core abstractions)
1. `cn()` - 32 edges
2. `run_exporter()` - 25 edges
3. `spawn()` - 22 edges
4. `compilerOptions` - 21 edges
5. `EngineSnapshot` - 19 edges
6. `AppState` - 19 edges
7. `EngineCard()` - 18 edges
8. `compilerOptions` - 18 edges
9. `EngineState` - 18 edges
10. `parse_prometheus_text()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `vllm-multi docker-compose (3 vLLM instances + OpenResty proxy)` --semantically_similar_to--> `docker-compose.yml (host-network containerized deployment)`  [INFERRED] [semantically similar]
  dev/vllm-multi/docker-compose.yml → deploy/docker/docker-compose.yml
- `CI Workflow (ci.yml)` --references--> `docker.md — Docker deployment guide`  [INFERRED]
  .github/workflows/ci.yml → deploy/docker/docker.md
- `Docker Publish Workflow (GHCR multi-arch)` --references--> `docker.md — Docker deployment guide`  [INFERRED]
  .github/workflows/docker-publish.yml → deploy/docker/docker.md
- `CLAUDE.md — Project Agent Rules` --references--> `CI Workflow (ci.yml)`  [EXTRACTED]
  CLAUDE.md → .github/workflows/ci.yml
- `CLAUDE.md — Project Agent Rules` --references--> `CHANGELOG (release-please generated)`  [EXTRACTED]
  CLAUDE.md → CHANGELOG.md

## Import Cycles
- 1-file cycle: `src/cli/service.rs -> src/cli/service.rs`
- 2-file cycle: `src/cli/service.rs -> src/main.rs -> src/cli/service.rs`

## Hyperedges (group relationships)
- **Release pipeline: commits → release-please → publish + docker-publish + changelog** — _github_workflows_release_please, _github_workflows_publish, _github_workflows_docker_publish, changelog [EXTRACTED 1.00]
- **Containerized deployment surface (compose, bridge override, guide, README quick start)** — deploy_docker_docker_compose, deploy_docker_docker_compose_bridge, deploy_docker_docker, readme [INFERRED 0.85]
- **Agent skill guidance docs referenced by CLAUDE.md** — claude, docs_agents_domain, docs_agents_issue_tracker, docs_agents_triage_labels [EXTRACTED 1.00]

## Communities (82 total, 10 thin omitted)

### Community 0 - "Engine Module Core"
Cohesion: 0.08
Nodes (49): Debug, Display, Formatter, HashSet, Send, ago(), ApiKeyResolver, cached_model_is_not_refetched_within_interval() (+41 more)

### Community 1 - "Systemd Service CLI"
Cohesion: 0.08
Nodes (48): dispatch(), ensure_root_or_reexec(), ensure_user(), group_exists(), install(), install_binary(), install_config(), install_unit() (+40 more)

### Community 2 - "HTTP Server & Config API"
Cohesion: 0.08
Nodes (50): FromRef, HeaderName, Response, Router, a_document_the_server_cannot_interpret_round_trips_unchanged(), a_legacy_document_without_the_export_section_loads_as_disabled(), a_writable_instance_reports_that_it_is_not_read_only(), a_write_over_the_size_cap_is_rejected_and_leaves_the_document_alone() (+42 more)

### Community 3 - "Container Log Viewer"
Cohesion: 0.08
Nodes (42): Query, buffer_lines(), enable_log_viewer(), find_container(), finished_stream_is_removed_from_registry(), flush_trailing(), flush_trailing_empty_buffer_emits_nothing(), handle_logs_socket() (+34 more)

### Community 4 - "Frontend Chart Components"
Cohesion: 0.07
Nodes (33): react, BigNumberSparkline, BigNumberSparklineProps, trendIcons, Sparkline, SparklineProps, ChartSeries, DataPoint (+25 more)

### Community 5 - "Frontend Lint & Toolchain Deps"
Cohesion: 0.05
Nodes (43): eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, devDependencies, eslint, @eslint/js, eslint-plugin-react-hooks (+35 more)

### Community 6 - "Frontend Package Manifest"
Cohesion: 0.05
Nodes (37): @base-ui/react, class-variance-authority, clsx, dependencies, @base-ui/react, class-variance-authority, clsx, lucide-react (+29 more)

### Community 7 - "Engine Detection (Docker/Native)"
Cohesion: 0.12
Nodes (29): DeploymentMode, OsString, candidate(), detect_by_process(), detect_docker_engines(), detect_engines(), DetectedEngine, docker_merge_keeps_distinct_endpoints_separate() (+21 more)

### Community 8 - "Memory Metrics Collection"
Cohesion: 0.08
Nodes (11): collect_memory_metrics(), collect_memory_metrics_none_device_reads_meminfo(), collect_memory_metrics_returns_real_values(), detect_unified_memory(), matches_unified_gpu_name(), round_up_to_marketed_gib(), Device, MemoryMetrics (+3 more)

### Community 9 - "Dashboard View & Sizing"
Cohesion: 0.12
Nodes (17): Dashboard(), DashboardProps, ElementSize, useElementSize(), formatMhz(), EngineIdentity, engineKey(), findEngineByKey() (+9 more)

### Community 10 - "Engine Card Components"
Cohesion: 0.11
Nodes (21): ChartDataPoint, ENGINE_ICON, EngineChartData, EngineSection(), EngineTab(), EngineTabProps, portFromEndpoint(), shortenModelName() (+13 more)

### Community 11 - "Dashboard Schema Bindings"
Cohesion: 0.14
Nodes (21): BindingResolution, FOLLOW, isGpuIndex(), readBinding(), resolveGpuBinding(), UNREADABLE, isRecord(), DashboardPage (+13 more)

### Community 12 - "HEC Metric Event Building"
Cohesion: 0.11
Nodes (23): MetricsSnapshot, a_host_with_no_engines_is_idle(), a_recent_request_within_the_window_is_active(), a_request_exactly_at_the_window_edge_is_active(), build_metric_event(), empty_gpu(), engine_metrics_use_the_engine_type_prefix(), engine_type_key() (+15 more)

### Community 13 - "GPU NVML Collection"
Cohesion: 0.12
Nodes (21): NvmlError, collect_device_pids(), collect_gpu_metrics(), collect_gpu_metrics_for_device(), collect_gpu_metrics_none_device_returns_all_none(), collect_gpu_metrics_stub_returns_stub_name(), detect_gpu_events(), detect_gpu_events_no_device_returns_empty() (+13 more)

### Community 14 - "TSConfig (App)"
Cohesion: 0.07
Nodes (27): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+19 more)

### Community 15 - "Config Store (State Dir)"
Cohesion: 0.15
Nodes (22): PathBuf, a_failed_write_leaves_the_previous_document_intact(), a_missing_state_directory_is_created(), an_unwritable_state_directory_reports_read_only_and_still_reads(), can_still_write(), ConfigStore, delete_removes_the_document_and_load_reports_absent(), delete_succeeds_when_no_document_is_stored() (+14 more)

### Community 16 - "Prometheus Parse & Warmup"
Cohesion: 0.18
Nodes (24): ParsedMetrics, String, Vec, active_regression_resets_to_warming(), clone_passthrough(), counter_regression(), first_poll_captures_initial_total_and_warms_up(), HistogramBaseline (+16 more)

### Community 17 - "HEC Export UI"
Cohesion: 0.16
Nodes (18): ExportSettingsDialog(), HecStatusDot(), LIGHT_CLASS, ADR-0001, ADR-0001, useExportStatus(), ExportStatus, fetchExportStatus() (+10 more)

### Community 18 - "Dashboard Config Client"
Cohesion: 0.14
Nodes (19): ExportSettingsDialogProps, DashboardConfigurationState, SAVE_FAILURE_NOTICE, SaveFailureNotice, useDashboardConfiguration(), CONFIGURATION_URL, fetchStoredConfiguration(), isReadOnly() (+11 more)

### Community 19 - "TSConfig (Node)"
Cohesion: 0.08
Nodes (23): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+15 more)

### Community 20 - "Latency Histogram Estimation"
Cohesion: 0.13
Nodes (16): fraction_le(), fraction_le_above_finite_bounds_caps_at_finite_cum(), fraction_le_at_bucket_boundary(), fraction_le_below_first_bucket_is_linear_from_zero(), fraction_le_interpolates_within_bucket(), fraction_le_threshold_below_first_le_with_zero_or_negative_le(), fraction_le_threshold_well_above_finite_no_inf_saturates(), handles_single_finite_bucket() (+8 more)

### Community 21 - "Metrics Core & Collector"
Cohesion: 0.14
Nodes (22): CoreMetrics, CoreMetrics, CpuMetrics, DiskMetrics, GpuMetrics, MemoryMetrics, metrics_collector(), MetricsSnapshot (+14 more)

### Community 22 - "HEC Exporter Runtime"
Cohesion: 0.15
Nodes (19): build_gpu_event(), build_test_event(), Exporter, flush_events(), gpu_events_go_to_the_events_index_as_plain_events(), now_ms(), publish(), Client (+11 more)

### Community 23 - "Repo Docs & CI Workflows"
Cohesion: 0.13
Nodes (21): CI Workflow (ci.yml), Docker Publish Workflow (GHCR multi-arch), crates.io Publish Workflow, Release-Please Workflow, CHANGELOG (release-please generated), CLAUDE.md — Project Agent Rules, Metrics contract (Rust MetricsSnapshot ↔ frontend types), docker.md — Docker deployment guide (+13 more)

### Community 24 - "Component Alias Re-exports"
Cohesion: 0.09
Nodes (21): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+13 more)

### Community 25 - "Dashboard Load & Migrations"
Cohesion: 0.18
Nodes (17): documentVersion(), FAILED, fallback(), fresh(), loadDashboardConfiguration(), tryParseJson(), DASHBOARD_MIGRATION_PATH, DashboardMigration (+9 more)

### Community 26 - "Core Header Charts"
Cohesion: 0.12
Nodes (11): CoreHeatmap, CoreHeatmapProps, CoreMetrics, CpuMetrics, DiskMetrics, EngineMetrics, EngineStatus, EngineType (+3 more)

### Community 27 - "vLLM Parameter Formatting"
Cohesion: 0.12
Nodes (11): format_precision(), format_quant_method(), format_tensor_type_falls_back_to_first_key(), format_tensor_type_prefers_float_dtypes(), format_tensor_type_returns_none_for_empty(), OpenAIModel, OpenAIModelsResponse, Self (+3 more)

### Community 28 - "Dashboard Grid Layout"
Cohesion: 0.20
Nodes (15): PanelBinding, cell(), clamp(), firstFreeSlot(), GRID_COLUMNS, GRID_MAX_ROWS, isFree(), isOutOfRoom() (+7 more)

### Community 29 - "Demo Load Generator"
Cohesion: 0.13
Nodes (10): CHILD_PIDS, ENDPOINTS_RAW, jitter_sleep_ms(), OVERRIDE_MODELS, PROMPT_SEEDS, run_conversation(), demo-load.sh script, shutdown() (+2 more)

### Community 30 - "vLLM Adapter Client"
Cohesion: 0.14
Nodes (12): EngineMetrics, EngineStatus, ModelInfo, Mutex, RequestBuilder, is_expected_hf_miss(), Client, EngineType (+4 more)

### Community 31 - "Engine Card Sub-components"
Cohesion: 0.18
Nodes (16): GoodputTile(), GoodputTileProps, KvBar(), KvBarProps, LiveWithTotal(), LiveWithTotalProps, MetricTile(), MetricTileProps (+8 more)

### Community 32 - "Network Metrics Collection"
Cohesion: 0.21
Nodes (16): IpAddr, Networks, breaks_ties_by_traffic_among_global_interfaces(), collect_network_metrics(), collect_network_metrics_with_fresh_networks_returns_zero_or_valid(), empty_yields_none_and_zero(), iface(), InterfaceInfo (+8 more)

### Community 33 - "Engine Stats & Latency UI"
Cohesion: 0.19
Nodes (14): GlobalEngineCardProps, LatencyModeControl(), LatencyModeControlProps, OPTIONS, AggregateSnapshot, ChartDataPoint, computeTrend(), percentileSubline() (+6 more)

### Community 34 - "UI Primitives (Badge/Button/Card)"
Cohesion: 0.22
Nodes (13): Badge(), badgeVariants, Button(), buttonVariants, Card(), CardAction(), CardContent(), CardDescription() (+5 more)

### Community 35 - "HEC Behavior Tests"
Cohesion: 0.33
Nodes (15): FnMut, SocketAddr, a_403_counts_as_reachable_with_a_configuration_error(), a_429_queues_the_batch_and_retries_on_the_next_tick(), a_probe_rejected_with_403_reports_misconfigured_not_healthy(), active_json(), resolve_test_target_falls_back_to_the_stored_token_when_masked_or_empty(), Self (+7 more)

### Community 36 - "Configuration Test Server"
Cohesion: 0.18
Nodes (10): configurationResponse(), ConfigurationServerOptions, configurationWrites(), FetchMock, serveConfiguration(), serveNothing(), configurationSettles(), SilentWebSocket (+2 more)

### Community 37 - "Format Utilities"
Cohesion: 0.17
Nodes (7): formatBytes(), formatDurationMs(), formatDurationUnit(), formatDurationValue(), formatGiB(), formatGpuIndexes(), formatRate()

### Community 38 - "Export Dialog Component"
Cohesion: 0.18
Nodes (10): LIGHT_CLASS, ADR-0001, Dialog(), DialogContent(), DialogDescription(), DialogHeader(), DialogOverlay(), DialogTitle() (+2 more)

### Community 39 - "SLO Settings & Goodput"
Cohesion: 0.27
Nodes (10): parseStored(), readFromStorage(), storageKey(), useSloSettings(), clamp(), DEFAULT_SLO, fractionLe(), recomputeGoodputPct() (+2 more)

### Community 40 - "Prometheus Counter Extraction"
Cohesion: 0.17
Nodes (14): captures_histogram_buckets(), captures_inter_token_latency_histogram(), captures_prefix_cache_counters(), missing_prefix_cache_counters_parse_cleanly(), parse_prometheus_text(), HashMap, Option, prefix_cache_queries_roundtrip_from_metrics_body() (+6 more)

### Community 41 - "Simulated GPU (Dev)"
Cohesion: 0.25
Nodes (12): phase_shift_makes_simulated_gpus_differ(), GpuEvent, GpuMetrics, Vec, simulated_gpu_events(), simulated_gpus(), simulated_gpus_assigns_sequential_indices_after_base(), simulated_values_stay_in_plausible_ranges() (+4 more)

### Community 42 - "HEC Mock Server Tests"
Cohesion: 0.16
Nodes (14): AtomicUsize, HeaderMap, JoinHandle, mock_handler(), MockHec, MockState, retain_token_in_document(), retain_token_in_document_fills_an_empty_token_from_the_stored_one() (+6 more)

### Community 43 - "Log Viewer UI"
Cohesion: 0.22
Nodes (9): EngineCardProps, EngineSectionProps, LogConnState, LogViewer(), LogViewerProps, resolveEngineBinding(), findEngineByEndpoint(), InferenceRequest (+1 more)

### Community 44 - "Tab Rotation Settings"
Cohesion: 0.26
Nodes (11): OPTIONS, TabRotationControl(), TabRotationControlProps, DEFAULT_ROTATION_INTERVAL, isRotationInterval(), parseInterval(), parseRotationState(), RotationInterval (+3 more)

### Community 45 - "Engine Global Metrics UI"
Cohesion: 0.38
Nodes (11): decodeTokenSeries(), EngineCard(), formatE2eLabel(), prefillTokenSeries(), GlobalEngineCard(), fmtInt(), formatTps(), formatTtft() (+3 more)

### Community 46 - "Metrics History Buffer"
Cohesion: 0.24
Nodes (10): createBuffers(), DataPoint, extractGpuValue(), extractValue(), MetricKey, SYSTEM_METRIC_KEYS, useMetricsHistory(), baseSnapshot (+2 more)

### Community 47 - "App Shell & Connection State"
Cohesion: 0.31
Nodes (6): App(), ConnectionBadge(), statusConfig, ADR-0001, ConnectionStatus, useMetrics()

### Community 48 - "Engine Aggregation Math"
Cohesion: 0.31
Nodes (10): aggregateEngines(), aggregatePercentiles(), emptySnapshot(), meanOrNull(), ProviderGroup, NOTE: Cross-engine percentile averaging is approximate — true tail, sumOrNull(), Weighted (+2 more)

### Community 49 - "HEC Status & Targets"
Cohesion: 0.20
Nodes (11): Map, engine_with(), ExportState, ExportStatus, push_opt(), resolve_test_target(), resolve_test_target_prefers_the_override_over_the_stored_target(), resolve_test_target_uses_the_override_alone_when_nothing_is_stored() (+3 more)

### Community 50 - "HEC Target & I/O"
Cohesion: 0.22
Nodes (10): active_json_with_gpu_event(), default_events_index(), default_index(), HecTarget, idle_json(), misconfigured_reason(), post_events(), String (+2 more)

### Community 51 - "Configuration Notices UI"
Cohesion: 0.31
Nodes (7): ConfigurationNotices(), describe(), NoticeText, toneClass, ConfigurationFallbackReason, ConfigurationNotice, everyNotice

### Community 52 - "Global Tabs UI"
Cohesion: 0.24
Nodes (8): GLOBAL_TAB_VALUE, GlobalEngineTab(), GlobalEngineTabProps, Tabs(), TabsContent(), TabsList(), tabsListVariants, TabsTrigger()

### Community 53 - "SLO Settings Dialog"
Cohesion: 0.27
Nodes (7): FieldDraft, parseDraft(), SloFieldProps, SloSettingsControl(), SloSettingsControlProps, toDraft(), SloThresholds

### Community 55 - "Dev Watch Script"
Cohesion: 0.50
Nodes (7): build_frontend(), rebuild_backend(), rebuild_embedded(), dev.sh script, sync_backend(), watch_backend(), watch_frontend()

### Community 56 - "Docker Dev Script"
Cohesion: 0.50
Nodes (8): build_local(), deploy_ghcr(), deploy_remote(), needs_remote(), remote_down(), remote_logs(), docker-dev.sh script, usage()

### Community 57 - "HuggingFace Model Config"
Cohesion: 0.44
Nodes (9): format_param_size(), format_tensor_type(), HfConfig, HfModelResponse, HfQuantizationConfig, HfSafetensors, HashMap, Option (+1 more)

### Community 58 - "Host Installer Script"
Cohesion: 0.57
Nodes (7): install_from_source(), preflight(), refuse_root(), require(), install.sh script, uninstall(), usage()

### Community 59 - "Animated Counter UI"
Cohesion: 0.36
Nodes (5): AnimatedCounter(), AnimatedCounterProps, easeOut(), prefersReducedMotion(), rafQueue

### Community 60 - "Dashboard Panels Registry"
Cohesion: 0.50
Nodes (6): defaultPanelTitle(), isKnownPanelType(), PANEL_TYPE_IDS, PANEL_TYPES, panelBindingKind, PanelTypeSpec

### Community 61 - "Release-Please Config"
Cohesion: 0.29
Nodes (6): bump-minor-pre-major, changelog-sections, include-v-in-tag, packages, release-type, $schema

### Community 62 - "GPU Power Scaling Math"
Cohesion: 0.60
Nodes (4): computePowerScale(), niceCeiling(), powerPeak(), PowerScale

### Community 64 - "Healthcheck CLI"
Cohesion: 0.47
Nodes (3): probe(), ExitCode, run()

### Community 65 - "CPU Metrics Collection"
Cohesion: 0.47
Nodes (5): collect_cpu_metrics(), collect_cpu_metrics_after_refresh_has_cores(), collect_cpu_metrics_returns_valid_struct(), CpuMetrics, System

### Community 66 - "Disk Metrics Collection"
Cohesion: 0.60
Nodes (4): Disks, collect_disk_metrics(), collect_disk_metrics_with_fresh_disks_returns_zero_or_valid(), DiskMetrics

### Community 69 - "TSConfig (Root)"
Cohesion: 0.40
Nodes (4): compilerOptions, paths, files, references

## Knowledge Gaps
- **218 isolated node(s):** `OVERRIDE_MODELS`, `ENDPOINTS_RAW`, `CHILD_PIDS`, `PROMPT_SEEDS`, `TARGETS` (+213 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Frontend Package Manifest` to `Frontend Chart Components`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `react` connect `Frontend Chart Components` to `Frontend Package Manifest`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Why does `EngineAdapter` connect `Engine Module Core` to `vLLM Adapter Client`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `OVERRIDE_MODELS`, `ENDPOINTS_RAW`, `CHILD_PIDS` to the rest of the system?**
  _218 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Engine Module Core` be split into smaller, more focused modules?**
  _Cohesion score 0.07505827505827506 - nodes in this community are weakly interconnected._
- **Should `Systemd Service CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.07769423558897243 - nodes in this community are weakly interconnected._
- **Should `HTTP Server & Config API` be split into smaller, more focused modules?**
  _Cohesion score 0.0841799709724238 - nodes in this community are weakly interconnected._