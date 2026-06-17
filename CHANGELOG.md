# Changelog

## [0.10.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.9.0...spark-dashboard-v0.10.0) (2026-06-17)


### Features

* **dev:** add docker-dev.sh container test harness ([b6bbdca](https://github.com/niklasfrick/spark-dashboard/commit/b6bbdca008028de66bde77ecc6faed43c9cd0644))
* **docker:** add hardened multi-stage image and compose deployment ([6d0d700](https://github.com/niklasfrick/spark-dashboard/commit/6d0d700f72c4a5530062a2f0bc25873b6b814d7c))
* **server:** add /healthz liveness endpoint ([d7bc7f7](https://github.com/niklasfrick/spark-dashboard/commit/d7bc7f7f95c8cf1f72e0c9ed12510707597bc187))


### Bug Fixes

* **vllm:** quiet expected HuggingFace enrichment misses ([e1c079d](https://github.com/niklasfrick/spark-dashboard/commit/e1c079db220fd6b37dedc4af50612c3046067d27))


### Dependencies & Chores

* **deps:** bump docker base images to latest stable ([357cd0f](https://github.com/niklasfrick/spark-dashboard/commit/357cd0fb90604c930f59194f1fb76f3040784792))
* surface dependency & chore commits in release notes ([d650799](https://github.com/niklasfrick/spark-dashboard/commit/d650799c3b106f7c5937deffd14dd8b59bbd7139))

## [0.9.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.8.0...spark-dashboard-v0.9.0) (2026-05-19)


### Features

* add cumulative token totals to engine throughput cards ([dd80c8e](https://github.com/niklasfrick/spark-dashboard/commit/dd80c8efe7664bb4755631393c447ae269064e2a))
* add Time Per Output Token (TPOT) to engine latency card ([20bc677](https://github.com/niklasfrick/spark-dashboard/commit/20bc6772ce70320b330dd28656c4f87a11cb21e5))
* bracket chart units in titles and clean up hover tooltips ([d92a975](https://github.com/niklasfrick/spark-dashboard/commit/d92a975f8537a3aed448410c4c1c0a7ed8ea89f6))
* cache resolved model info and support per-endpoint engine API keys ([18fa2f8](https://github.com/niklasfrick/spark-dashboard/commit/18fa2f8ff53c6d9d60577e9a375e28b23d78397b))
* hide tooltip header on prefill and decode throughput charts too ([952d5ee](https://github.com/niklasfrick/spark-dashboard/commit/952d5ee85f680045217aefaf49bf9bd8baa57e65))
* move tok/s into engine throughput titles and fix hover header ([bc2292f](https://github.com/niklasfrick/spark-dashboard/commit/bc2292f4eb6315534dbe48078fd6342ed0dd9c33))
* plot prefix cache hit rate alongside KV cache over time ([4a105ca](https://github.com/niklasfrick/spark-dashboard/commit/4a105cae7dc1aaabdd2a090f5cf8bc53f51476af))
* select physical/Wi-Fi network interface instead of loopback ([d7cdfbf](https://github.com/niklasfrick/spark-dashboard/commit/d7cdfbfc38b6cd10d49f976e1ecd4cc711abd0bb))
* surface cumulative prefix cache queries on engine cache card ([0860324](https://github.com/niklasfrick/spark-dashboard/commit/08603248ddb94308d8ea4a24a83ace4cb6ab5051))

## [0.8.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.7.0...spark-dashboard-v0.8.0) (2026-05-01)


### Features

* slo goodput customization ([#23](https://github.com/niklasfrick/spark-dashboard/issues/23)) ([1576e43](https://github.com/niklasfrick/spark-dashboard/commit/1576e43f83460d3dfefc7145086a22b289dd8ac9))

## [0.7.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.6.0...spark-dashboard-v0.7.0) (2026-04-28)


### Features

* improvind dashboard and fixing data visibility ([#20](https://github.com/niklasfrick/spark-dashboard/issues/20)) ([c7851bd](https://github.com/niklasfrick/spark-dashboard/commit/c7851bd496f4d8c12b2cda163705e583b44fce6a))

## [0.6.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.5.0...spark-dashboard-v0.6.0) (2026-04-28)


### Features

* model detail tags ([#18](https://github.com/niklasfrick/spark-dashboard/issues/18)) ([c0633bc](https://github.com/niklasfrick/spark-dashboard/commit/c0633bc9fe8d98499713084899b781773d38d99b))

## [0.5.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.4.0...spark-dashboard-v0.5.0) (2026-04-25)


### Features

* **vllm:** expand vLLM observability with latency percentiles, SLO goodput, and dashboard polish ([082bd17](https://github.com/niklasfrick/spark-dashboard/commit/082bd17adcaf4da6dc577ce1cefcd91b90464cae))


### Bug Fixes

* compute vLLM prefix cache hit rate from counters ([#14](https://github.com/niklasfrick/spark-dashboard/issues/14)) ([1797e8a](https://github.com/niklasfrick/spark-dashboard/commit/1797e8a1b8f8208176771c727cd3d2a98dac4e10))

## [0.4.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.3.0...spark-dashboard-v0.4.0) (2026-04-23)


### Features

* multi-engine dashboard with auto-rotation and live vLLM metrics ([#12](https://github.com/niklasfrick/spark-dashboard/issues/12)) ([53b2af8](https://github.com/niklasfrick/spark-dashboard/commit/53b2af81b0a21f2779bfac26e5a6bc2546d8490e))

## [0.3.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.2.0...spark-dashboard-v0.3.0) (2026-04-22)


### Features

* make dashboard hardware- and host-agnostic ([3b77d5a](https://github.com/niklasfrick/spark-dashboard/commit/3b77d5a4ee95bdfd316f56a256a34ee06e339bda))
* make dashboard hardware- and host-agnostic ([9f0e3a6](https://github.com/niklasfrick/spark-dashboard/commit/9f0e3a6d2b321f42736a1ac03551da9b87072da2))
* surface engine deployment mode (Docker vs Direct) in tabs ([6e9de44](https://github.com/niklasfrick/spark-dashboard/commit/6e9de441bc13b0d451bbb47808373e3d8926b6d0))

## [0.2.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.1.0...spark-dashboard-v0.2.0) (2026-04-20)


### Features

* package and distribute via cargo install + systemd service ([b2a87d8](https://github.com/niklasfrick/spark-dashboard/commit/b2a87d8d42f29bd105c456bed581e657d6edafa0))


### Bug Fixes

* **dev:** prevent local tilde expansion of SPARK_DIR ([e1e8350](https://github.com/niklasfrick/spark-dashboard/commit/e1e8350d499c5b6c12470dee536d5d1c3be0b10b))
* **install:** refuse sudo invocation; let binary self-escalate ([942c796](https://github.com/niklasfrick/spark-dashboard/commit/942c7961b48fc01771ec5a34af659c4e8a2ddd5e))
* **install:** refuse sudo invocation; let binary self-escalate ([e778623](https://github.com/niklasfrick/spark-dashboard/commit/e77862341ddd62581e643643977c6cc9aa473bbe))
* **test:** align MemoryCard test selectors with current StackedBar markup ([e499da9](https://github.com/niklasfrick/spark-dashboard/commit/e499da9c94047fa0d848b8649fe9ee0bc9aafe63))
