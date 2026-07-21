# Changelog

## [0.12.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.11.0...spark-dashboard-v0.12.0) (2026-07-21)


### Features

* **engines:** associate detected engines with the GPUs they run on ([e406a50](https://github.com/niklasfrick/spark-dashboard/commit/e406a505f52a606a1b6a0138d8e49cc81e660fc0))
* **frontend:** show per-engine GPU badge on multi-GPU hosts ([180e414](https://github.com/niklasfrick/spark-dashboard/commit/180e414f39550b5b1ace70918e0f749add6a7dd6)), closes [#45](https://github.com/niklasfrick/spark-dashboard/issues/45)
* **gpu:** add --simulate-gpus flag appending fictive GPUs to snapshots ([f6e29c5](https://github.com/niklasfrick/spark-dashboard/commit/f6e29c5b49ebb9178f3b03031aba4e95a0b02b32))
* **gpu:** make main Dashboard hardware panels switch between GPUs ([a34c31a](https://github.com/niklasfrick/spark-dashboard/commit/a34c31ab718bdd88d1cc4d955e71cecc00024670)), closes [#44](https://github.com/niklasfrick/spark-dashboard/issues/44)
* **gpu:** monitor all NVIDIA GPUs while preserving backward compatibility ([8d6033c](https://github.com/niklasfrick/spark-dashboard/commit/8d6033c3f94b6c00e50922aa1dbd423642441942))


### Bug Fixes

* **engines:** clear stale engine PIDs and test the detection merge ([6970153](https://github.com/niklasfrick/spark-dashboard/commit/69701531a5217ba2ba2fe1c7cd4d2d2c5baf0e37))
* **gpu:** keep Dashboard hook order stable across the first snapshot ([2afad09](https://github.com/niklasfrick/spark-dashboard/commit/2afad09e8b3be91c7c4a31bc942f8e59f0c45c11))


### Dependencies & Chores

* **dev:** forward SPARK_DASHBOARD_SIMULATE_GPUS in the bare-metal dev loop ([cd3290c](https://github.com/niklasfrick/spark-dashboard/commit/cd3290cbc0159c8917bb5eccf39b7da27b41233f))

## [0.11.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.10.0...spark-dashboard-v0.11.0) (2026-06-18)


### Features

* **docker:** harden runtime image with distroless base and self-probe healthcheck ([1ccc1db](https://github.com/niklasfrick/spark-dashboard/commit/1ccc1dbce75147a2667ecfc40549250d5d122fff))
* **engines:** parse vLLM speculative-decoding metrics ([ac512e9](https://github.com/niklasfrick/spark-dashboard/commit/ac512e9bca984b846834c43dc59949f07b513ae7))
* **frontend:** adapt hardware cards to vertical space ([68ee1ff](https://github.com/niklasfrick/spark-dashboard/commit/68ee1fffa58cafb9ad1dcb5c0d58b9e46dee1451))
* **frontend:** surface speculative-decoding metrics in cache card ([feb936a](https://github.com/niklasfrick/spark-dashboard/commit/feb936a1c78a71c6024b8570e0dcef2171194293))


### Bug Fixes

* **frontend:** scale GPU power gauge by observed peak when no cap ([e2d525e](https://github.com/niklasfrick/spark-dashboard/commit/e2d525eddc7a6becd55bccab5d9179986c6b4bcc))
* **metrics:** resolve GPU power limit via NVML fallback chain ([e68d7cb](https://github.com/niklasfrick/spark-dashboard/commit/e68d7cb2725d1f69f4a6648fe8738943ad24e776))


### Dependencies & Chores

* **ci:** bump github actions to latest stable ([49b68bd](https://github.com/niklasfrick/spark-dashboard/commit/49b68bd3d21d8b4ce77a50b4aaaa1b483993592a))
* **deps:** bump frontend deps to latest stable ([124ce79](https://github.com/niklasfrick/spark-dashboard/commit/124ce7983b67da628517592ebcc4bed02e03ce38))
* **deps:** bump rust crates to latest stable ([32d4e42](https://github.com/niklasfrick/spark-dashboard/commit/32d4e420327cbea34d979c4000d59d61f068f15e))

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
