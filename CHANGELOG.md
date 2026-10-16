# Changelog

## [0.16.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.15.0...spark-dashboard-v0.16.0) (2026-10-16)


### Features

* **engines:** declare metric groups at the tile grain ([6fd615c](https://github.com/niklasfrick/spark-dashboard/commit/6fd615ce028d9162a440b257c1f335b0bc498671))
* **engines:** detect Ollama servers and containers without configuration ([f057946](https://github.com/niklasfrick/spark-dashboard/commit/f057946d6c3caba25fbc5e5ca2dca5da6be834d5)), closes [#132](https://github.com/niklasfrick/spark-dashboard/issues/132)
* **engines:** monitor SGLang engines, detected and reported per type ([e1997cb](https://github.com/niklasfrick/spark-dashboard/commit/e1997cbbe478df4dfba0869d229606313b755f67))
* **engines:** report an Ollama server and the models it has loaded ([aec8fb7](https://github.com/niklasfrick/spark-dashboard/commit/aec8fb7b191f8d8f7341b9694bc38af28dea9c96)), closes [#132](https://github.com/niklasfrick/spark-dashboard/issues/132)
* **frontend:** list an Ollama engine's loaded models in the Engine panel ([6d45c87](https://github.com/niklasfrick/spark-dashboard/commit/6d45c87c0629960a2628b09b066ca40dd4bf8689)), closes [#132](https://github.com/niklasfrick/spark-dashboard/issues/132)
* **frontend:** name an Ollama engine by the models it has loaded ([cbf451d](https://github.com/niklasfrick/spark-dashboard/commit/cbf451d4300ec3c60c427149bb71e1bcccf308fb)), closes [#132](https://github.com/niklasfrick/spark-dashboard/issues/132)


### Bug Fixes

* **engines:** build engine detection on macOS ([a580916](https://github.com/niklasfrick/spark-dashboard/commit/a580916225d1aedafa0604f99bb7dc2d79094e4a)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** combine every label series a metric is split across ([29d0d70](https://github.com/niklasfrick/spark-dashboard/commit/29d0d70e7b634fc46437d0dc30a091e4d6e61f9d)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** detect each process and container as one engine ([f9daa37](https://github.com/niklasfrick/spark-dashboard/commit/f9daa377c0bc2077aa1f07849a5298c3972f226e)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** detect SGLang releases that predate /ready ([d1d4075](https://github.com/niklasfrick/spark-dashboard/commit/d1d4075040c1247ad92d084ed52b598b02994a81))
* **engines:** end SGLang warmup on its own request counter ([e9c1aa1](https://github.com/niklasfrick/spark-dashboard/commit/e9c1aa1fed26cb135d0ba28d14ba91bb4fd272b7)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** identify SGLang by its cheap routes, with the API key ([add7b6b](https://github.com/niklasfrick/spark-dashboard/commit/add7b6bd430fdf75251a4a6dfe68f3874b0d6793)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** read command lines in the process scan ([d0b64e2](https://github.com/niklasfrick/spark-dashboard/commit/d0b64e2ede0254ee152eb5a578dcb011dc63a627))
* **engines:** read SGLang scrapes through the shared parser ([bc726a1](https://github.com/niklasfrick/spark-dashboard/commit/bc726a1cbd8872c1a77b721b1d1e54bc3df7136c)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** report SGLang's acceptance length without the bonus token ([d48e21d](https://github.com/niklasfrick/spark-dashboard/commit/d48e21ddcfb679c9de29a8a5c5d6f6233da35319)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** say SGLang metrics are off only when the route is missing ([7670758](https://github.com/niklasfrick/spark-dashboard/commit/7670758439f7164cdeab619942e9689f709bc9f3)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **engines:** SGLang declares no TPOT, batch size or preemption groups ([56c558e](https://github.com/niklasfrick/spark-dashboard/commit/56c558ebd3497e14a85aae8bea85926d8f9a04d5))
* **engines:** tell an idle SGLang drafter from a server without one ([3ff09a3](https://github.com/niklasfrick/spark-dashboard/commit/3ff09a3e7d262dd75e3bab2df034b1d69c46ce3e)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)
* **frontend:** combine SGLang's acceptance figures into all models ([2eb63c4](https://github.com/niklasfrick/spark-dashboard/commit/2eb63c4a7116ec6ea15433adac0bb8cd17cb8127)), closes [#129](https://github.com/niklasfrick/spark-dashboard/issues/129)

## [0.15.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.14.0...spark-dashboard-v0.15.0) (2026-10-15)


### Features

* **frontend:** add a GPU PCIe panel ([1ea2780](https://github.com/niklasfrick/spark-dashboard/commit/1ea2780c8f95286c84711b946b36dc5b86eb83b9)), closes [#98](https://github.com/niklasfrick/spark-dashboard/issues/98)
* **frontend:** combine only the engines that report a metric group ([23e9cd9](https://github.com/niklasfrick/spark-dashboard/commit/23e9cd9e6544ab8c53df1bf91228ccb5631a6d93)), closes [#130](https://github.com/niklasfrick/spark-dashboard/issues/130)
* **frontend:** file each engine metric under its metric group ([6ce64a1](https://github.com/niklasfrick/spark-dashboard/commit/6ce64a12a1a492ad574752a6dce191446fa90c19)), closes [#130](https://github.com/niklasfrick/spark-dashboard/issues/130)
* **frontend:** open an unconfigured page on an engine that reports metrics ([0bf40aa](https://github.com/niklasfrick/spark-dashboard/commit/0bf40aa219233b57e730dda3114152a949dd8099))
* **frontend:** rotate a page's engine for wall displays ([875a5aa](https://github.com/niklasfrick/spark-dashboard/commit/875a5aa443ad44b869bb924dc76750060bb77b7f))
* **frontend:** say how many engines all-models figures cover ([6ba4631](https://github.com/niklasfrick/spark-dashboard/commit/6ba4631e4d23b6e3eb8fd87479bb83a073908859)), closes [#130](https://github.com/niklasfrick/spark-dashboard/issues/130)
* **frontend:** say when an engine does not report a panel's metrics ([8b283ba](https://github.com/niklasfrick/spark-dashboard/commit/8b283bafe977437ba0a12e9ce7c8380b94d77c3d)), closes [#128](https://github.com/niklasfrick/spark-dashboard/issues/128)
* **frontend:** start a new page from the Legacy layout ([bb41e33](https://github.com/niklasfrick/spark-dashboard/commit/bb41e33a0819c89011768de6e95a833c3d038a9a))
* **frontend:** word all-models coverage and unreported groups ([7e2e24c](https://github.com/niklasfrick/spark-dashboard/commit/7e2e24cbf661c81e2192145d271a8384937a1dcb)), closes [#130](https://github.com/niklasfrick/spark-dashboard/issues/130)
* **metrics:** engines declare the metric groups they report ([091838b](https://github.com/niklasfrick/spark-dashboard/commit/091838b9947b9942b53f1205aab06e7b2e871212)), closes [#128](https://github.com/niklasfrick/spark-dashboard/issues/128)
* **metrics:** report per-GPU PCIe throughput ([e5887dd](https://github.com/niklasfrick/spark-dashboard/commit/e5887dd9769e8664931dc68a016014a8c9a19719)), closes [#98](https://github.com/niklasfrick/spark-dashboard/issues/98)


### Bug Fixes

* **frontend:** keep the engine's identity on one line in a wide, short panel ([91d2f7d](https://github.com/niklasfrick/spark-dashboard/commit/91d2f7dcc8d6f68816a4560ee550b24c1312daf4))
* **frontend:** keep the SLO settings dialog on its cog while the grid moves it ([130579e](https://github.com/niklasfrick/spark-dashboard/commit/130579e7b5c90d2f651fb0a11531706e8e056aca))
* **frontend:** keep the SLO settings dialog on screen and outside the panel's clip ([9db55bf](https://github.com/niklasfrick/spark-dashboard/commit/9db55bf078d2e9dad6e0c146c1a0483bd57022f9)), closes [#123](https://github.com/niklasfrick/spark-dashboard/issues/123)
* **frontend:** let a page take its measured row height without animating ([556b4ec](https://github.com/niklasfrick/spark-dashboard/commit/556b4ec0fad79ac9b3228db553296fd483f37da1))
* **frontend:** stack a page opened at phone width in reading order ([d628f4d](https://github.com/niklasfrick/spark-dashboard/commit/d628f4d87a59947fd1ec6fb3c98efd9d1c8ec1ca)), closes [#139](https://github.com/niklasfrick/spark-dashboard/issues/139)
* **metrics:** read disk I/O rates from /proc/diskstats ([53849d5](https://github.com/niklasfrick/spark-dashboard/commit/53849d55fe968166a44e3bf3c5cc2687e9d371b8)), closes [#118](https://github.com/niklasfrick/spark-dashboard/issues/118)


### Dependencies & Chores

* **deps:** update async-trait to 0.1.92 ([fad0b96](https://github.com/niklasfrick/spark-dashboard/commit/fad0b96cfc48e7a1a6083c2c4f9405b2ca07deac))

## [0.14.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.13.0...spark-dashboard-v0.14.0) (2026-09-04)


### ⚠ BREAKING CHANGES

* **frontend:** the fixed dashboard is retired, and three things it carried have no replacement in this release. The All Engines aggregate — running-engine count, summed throughput, weighted-mean latencies — has a panel type reserved (`engines-overview`) and no implementation yet. The auto-rotating engine tab carousel is gone with the tabs themselves; panels are pinned or follow the page selection instead. The log console is no longer a fixed drawer at the bottom of the page — logs are a panel an operator places, and the default preset places none.

### Features

* **deploy:** grant the state directory in the systemd unit ([9931ce8](https://github.com/niklasfrick/spark-dashboard/commit/9931ce865c54bcff24296cad25c688cc0ccff173))
* **docker:** persist the dashboard configuration in a named volume ([0b625c7](https://github.com/niklasfrick/spark-dashboard/commit/0b625c7ddb4c050b3c1588fd05cab01f1efa0129))
* **frontend:** a live-motion context that holds the dashboard still ([85fd9aa](https://github.com/niklasfrick/spark-dashboard/commit/85fd9aa05132f40489832a46490aab4a9d2becb6))
* **frontend:** a palette that places a panel in the first free slot ([265cf71](https://github.com/niklasfrick/spark-dashboard/commit/265cf710f5044829eaedd4f9a55c746943965b23))
* **frontend:** an engine panel that says what is being served ([524fd15](https://github.com/niklasfrick/spark-dashboard/commit/524fd1584c132fe8893794f8bc5047b81021e0f4))
* **frontend:** configuration load/save client and failure banners ([ed36d9c](https://github.com/niklasfrick/spark-dashboard/commit/ed36d9c571ae8824c7043796217bcfaa939aeeb4)), closes [#77](https://github.com/niklasfrick/spark-dashboard/issues/77)
* **frontend:** dashboard document schema, migrations and default preset ([0f4ae34](https://github.com/niklasfrick/spark-dashboard/commit/0f4ae34be5fc9e9f325b544fa9be0065c0108127)), closes [#76](https://github.com/niklasfrick/spark-dashboard/issues/76)
* **frontend:** dashboard grid geometry and panel type vocabulary ([328941a](https://github.com/niklasfrick/spark-dashboard/commit/328941a037c894a9e2c7851f42b420a98b1b4999)), closes [#76](https://github.com/niklasfrick/spark-dashboard/issues/76)
* **frontend:** edit-session rules for layout changes and refused drops ([6e3073b](https://github.com/niklasfrick/spark-dashboard/commit/6e3073b6f82fbc71ba992ef9fc8c7308828a004e))
* **frontend:** engine goodput, cache and speculative-decoding panels ([e9aae51](https://github.com/niklasfrick/spark-dashboard/commit/e9aae51f6674f32b5f861a46c620fd4c56333934)), closes [#81](https://github.com/niklasfrick/spark-dashboard/issues/81)
* **frontend:** engine throughput, latency and request panels ([555a3e9](https://github.com/niklasfrick/spark-dashboard/commit/555a3e9488363a0a0ae87459acc6d175fb5ec884)), closes [#81](https://github.com/niklasfrick/spark-dashboard/issues/81)
* **frontend:** explicit edit mode with save and discard ([c8fb6fd](https://github.com/niklasfrick/spark-dashboard/commit/c8fb6fdad769945fffa7d6856a3f6dad57a9112e))
* **frontend:** grid page shell rendering stored pages at their own URLs ([3ca685d](https://github.com/niklasfrick/spark-dashboard/commit/3ca685d014f9e214cd4b1db4c2959a998ce422f4))
* **frontend:** hardware metrics as individually placeable panels ([d67d106](https://github.com/niklasfrick/spark-dashboard/commit/d67d106175c791b270612150679d22cce5120042))
* **frontend:** history-based page routes with stable ids and slugs ([aa15972](https://github.com/niklasfrick/spark-dashboard/commit/aa159727087032d7d70c4658e966f2f31cc7b509))
* **frontend:** keep the provider mark where the grid names an engine ([d0ac733](https://github.com/niklasfrick/spark-dashboard/commit/d0ac73328715e28bfe91f76198419d396d04ffcc))
* **frontend:** latest-snapshot access and GPU series keys on the metrics store ([919744c](https://github.com/niklasfrick/spark-dashboard/commit/919744cdd9439dbcb905877571788bb6094fc770))
* **frontend:** lead the preset with what the machine is serving ([70f43dc](https://github.com/niklasfrick/spark-dashboard/commit/70f43dc702d3540b5429438719bd3bce768d24ce))
* **frontend:** let each page choose its model — one, or all combined ([0f430d0](https://github.com/niklasfrick/spark-dashboard/commit/0f430d00b1ee1e984c869700fe4082b38a65db89))
* **frontend:** logs as a placeable panel bound to an engine ([9c74096](https://github.com/niklasfrick/spark-dashboard/commit/9c74096904401384657ae7f34f5e29f08ef7e853))
* **frontend:** metrics history store with per-series subscriptions and windowed reads ([cca90ee](https://github.com/niklasfrick/spark-dashboard/commit/cca90ee073a9a00651d0aba324c60e47061d1e15))
* **frontend:** name the hardware each panel is reading ([fa8aa76](https://github.com/niklasfrick/spark-dashboard/commit/fa8aa7650a86adbca813a76bea96ca0f8e3af9e1))
* **frontend:** page-level GPU and engine selection for follow bindings ([1f6d1fc](https://github.com/niklasfrick/spark-dashboard/commit/1f6d1fcf035ba21ee02556c83a2dd813b3c0314e)), closes [#81](https://github.com/niklasfrick/spark-dashboard/issues/81)
* **frontend:** pages as header tabs, with their own URLs and resets ([f29d957](https://github.com/niklasfrick/spark-dashboard/commit/f29d9574fe89257e4372b22bd9bcb0fdd6585364))
* **frontend:** panel registry with tracer panels and slot-keeping placeholders ([1781bf5](https://github.com/niklasfrick/spark-dashboard/commit/1781bf524435b807f24dca1adff9cf9805385a4f))
* **frontend:** panel-list edits an operator makes by hand ([2394684](https://github.com/niklasfrick/spark-dashboard/commit/2394684fea296228dd782b6abff41af99dbb3357))
* **frontend:** per-panel settings for title, window, source and removal ([0237e79](https://github.com/niklasfrick/spark-dashboard/commit/0237e79890f7fdd6590cbc9aba99ca89b46f1c4b))
* **frontend:** recognize BAAI and Baidu provider icons ([f3b3439](https://github.com/niklasfrick/spark-dashboard/commit/f3b34395e6e5ee73d12b9c3c0f66276e1d373401))
* **frontend:** remove a panel with one click on its frame in edit mode ([09e16e2](https://github.com/niklasfrick/spark-dashboard/commit/09e16e2cce4a517bc995e5d61456c11c9b616795))
* **frontend:** removing the stored configuration on the operator's word ([7edc886](https://github.com/niklasfrick/spark-dashboard/commit/7edc8862b269a3ffc6b9fed6bb6d069bf7fd2749))
* **frontend:** render the five panel types the palette offered ([a26dd3b](https://github.com/niklasfrick/spark-dashboard/commit/a26dd3b284b67ccba4e5d317717fd730c50e622e))
* **frontend:** resolve panel bindings without silent substitution ([5195e2e](https://github.com/niklasfrick/spark-dashboard/commit/5195e2e06b750bdaf164ee5af8f761d8e1208d31)), closes [#76](https://github.com/niklasfrick/spark-dashboard/issues/76)
* **frontend:** serve the grid dashboard at the root URL ([ec2632e](https://github.com/niklasfrick/spark-dashboard/commit/ec2632edff3034092c2d048799bd9b2fca1a3185))
* **frontend:** subscribe the dashboard through the metrics store ([f80787c](https://github.com/niklasfrick/spark-dashboard/commit/f80787c7301cc643304ccf73d855d9745d9d4813))
* **frontend:** the All Engines overview, as a panel ([d57b30b](https://github.com/niklasfrick/spark-dashboard/commit/d57b30b21b42ff6d61e2f2a7c9341f9e04d89a42))
* **frontend:** the dashboard a fresh install opens on ([011cad6](https://github.com/niklasfrick/spark-dashboard/commit/011cad6a34dbf82c419fd933ae927e50d974b442))
* **frontend:** the page-list edits an operator makes by hand ([70855ea](https://github.com/niklasfrick/spark-dashboard/commit/70855ea6633c1de51aba8332ecec0cee8381c8e5))
* **frontend:** the targets a panel can be pinned to ([056f52c](https://github.com/niklasfrick/spark-dashboard/commit/056f52c8cfe55ea92442fc0a0262e27b7e35f8d2))
* **frontend:** which page tabs fit the header, and which go in a menu ([932aae5](https://github.com/niklasfrick/spark-dashboard/commit/932aae54bb399d15334d4d4cae7ce6e569537d46))
* **server:** store the dashboard configuration in a state directory ([8546a57](https://github.com/niklasfrick/spark-dashboard/commit/8546a5791b250990f1927fbe099e3dfab5b01264)), closes [#72](https://github.com/niklasfrick/spark-dashboard/issues/72)


### Bug Fixes

* **engines:** find a containerized vLLM that publishes no ports ([3601f6a](https://github.com/niklasfrick/spark-dashboard/commit/3601f6a0891e75ec495ffdb1ab5204fda1909dc0))
* **engines:** recover the real model name from a local-directory vLLM launch ([fcfd88f](https://github.com/niklasfrick/spark-dashboard/commit/fcfd88f79aba53b63ff12702df7a2083eb49c439))
* **engines:** report why /v1/models model metadata is missing ([470103a](https://github.com/niklasfrick/spark-dashboard/commit/470103a266671d2694c21bd09c8182977096b2b3))
* **frontend:** don't clip the bottom off the page tab you are on ([94ffd57](https://github.com/niklasfrick/spark-dashboard/commit/94ffd5776a5d3b73942353d538c33f66832dbd35))
* **frontend:** don't reconnect a log socket whose endpoint changed hands ([26d7ff8](https://github.com/niklasfrick/spark-dashboard/commit/26d7ff89237bfa2c7d0cf08a4d4c7b9d6763cafd))
* **frontend:** judge a refused gesture by the pointer, not by the panel ([9e4c492](https://github.com/niklasfrick/spark-dashboard/commit/9e4c4923470dbd0d04273deacff4b087495cbbdf))
* **frontend:** keep page navigation usable on a narrow header ([022d3e8](https://github.com/niklasfrick/spark-dashboard/commit/022d3e87200d4797d7cb7d79883512a295039000))
* **frontend:** stop a chart deriving its height from its own width ([aafae73](https://github.com/niklasfrick/spark-dashboard/commit/aafae73e27ed21fef9ab6f0baa1f9110b115a05b))
* **frontend:** stop the page compacting when edit mode ends ([97da66c](https://github.com/niklasfrick/spark-dashboard/commit/97da66cf0c32468d3df1e286c9c32c79d5def6a8))
* **frontend:** warn when reading the model name needs a provider API key ([07f062b](https://github.com/niklasfrick/spark-dashboard/commit/07f062b84c2ea674b43862630a51d2e76bc85cb8))


### Dependencies & Chores

* **deps:** drop the packages the deleted chrome was the last user of ([61eb8e8](https://github.com/niklasfrick/spark-dashboard/commit/61eb8e8c18d0f68f8f314a0eb4e08f2c0334d556))
* **frontend:** adopt gridstack 13.2.0, pinned exactly ([5df800d](https://github.com/niklasfrick/spark-dashboard/commit/5df800db19264b2c308e8419ff089dbb859244ac))

## [0.13.0](https://github.com/niklasfrick/spark-dashboard/compare/spark-dashboard-v0.12.0...spark-dashboard-v0.13.0) (2026-07-27)


### Features

* **config:** support explicit engine env vars ([05de286](https://github.com/niklasfrick/spark-dashboard/commit/05de28679c285d2b1266a706f528b44e1f950cb3))
* **dashboard:** sync GPU selection with active engine ([34387d2](https://github.com/niklasfrick/spark-dashboard/commit/34387d250a2bfabd03add9ae56213ab5c2437776))
* **docker:** pass the log-viewer flag through the compose deployment ([01ca470](https://github.com/niklasfrick/spark-dashboard/commit/01ca47044090f94e37f536728c5d3435ae564078))
* **frontend:** add collapsible log viewer with WebSocket streaming ([63bba8a](https://github.com/niklasfrick/spark-dashboard/commit/63bba8a716b176ba65668154af35dc1d295ffc67))
* **frontend:** sync log viewer with the selected engine tab ([1632394](https://github.com/niklasfrick/spark-dashboard/commit/1632394d74cbfece0abd140b6b249a6c2fd9cd4a))
* **logs:** container log streaming via bollard Docker API ([c4b2ada](https://github.com/niklasfrick/spark-dashboard/commit/c4b2ada523c0f162ed69503f9272037b112600ee))
* **logs:** engine-selected per-container log streams ([6f4cef1](https://github.com/niklasfrick/spark-dashboard/commit/6f4cef1c41781ad1ea0a7af78313b04dde4ad3e2))


### Bug Fixes

* **deps:** refresh Cargo.lock to latest compatible crate versions ([e2daca5](https://github.com/niklasfrick/spark-dashboard/commit/e2daca5b86cb591a32c0a3c390644dd72ed9a4f0))
* **frontend:** stop the auto-scroll indicator flickering on new log lines ([aeb52a7](https://github.com/niklasfrick/spark-dashboard/commit/aeb52a775488d6a6322429dffcac5d51eb0f2108))
* **logs:** address maintainer feedback on log streaming ([400b7f9](https://github.com/niklasfrick/spark-dashboard/commit/400b7f9b894f7a7426e1e355bb79d0e8931dba07))


### Dependencies & Chores

* **deps:** align @types/node with the Node 24 LTS toolchain ([9dca215](https://github.com/niklasfrick/spark-dashboard/commit/9dca21573fad9674f0e0ea349fe42564a66b3579))
* **deps:** bump Docker builder image to rust:1.97-slim ([bb97a34](https://github.com/niklasfrick/spark-dashboard/commit/bb97a3494c410ea7864925b9f8f41f514ba91c3c))
* **deps:** refresh npm lockfile to latest in-range versions ([2e1bf67](https://github.com/niklasfrick/spark-dashboard/commit/2e1bf67646e690ccfba814a9f5ede627e1ddfc51))

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
