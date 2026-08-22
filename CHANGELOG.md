# Changelog

## [0.9.1](https://github.com/ecoma-io/reeve/compare/v0.9.0...v0.9.1) (2026-08-22)


### Bug Fixes

* **review:** the answer skeleton that taught 0.0, and the labels that said dry-run ([#130](https://github.com/ecoma-io/reeve/issues/130)) ([45ba283](https://github.com/ecoma-io/reeve/commit/45ba2832d5a502bf4b5637958c62c52f6ba910a9))
* **translate,harmonise:** rank what a draft lost, and make a language a run lost findable again ([#131](https://github.com/ecoma-io/reeve/issues/131)) ([17f85e9](https://github.com/ecoma-io/reeve/commit/17f85e9e59dfa91c0feba64622c8b039d31bb92e))
* **translate:** escape an unbalanced `<details>` tag instead of refusing the draft ([#133](https://github.com/ecoma-io/reeve/issues/133)) ([29c290b](https://github.com/ecoma-io/reeve/commit/29c290b1128232180eae731339ad209b13ab9613))
* **workspace:** seven defects a hardening round found, and the tests that caught them ([#126](https://github.com/ecoma-io/reeve/issues/126)) ([99ca6b0](https://github.com/ecoma-io/reeve/commit/99ca6b0082163e67d7e791407e25de6a0e6e6ecd))
* **workspace:** what run 48 was actually for, and the four defects between it and that ([#128](https://github.com/ecoma-io/reeve/issues/128)) ([0decf5b](https://github.com/ecoma-io/reeve/commit/0decf5b1cfdc07caa441301cb2e6b21afec1773a))

## [0.9.0](https://github.com/ecoma-io/reeve/compare/v0.8.0...v0.9.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **provider:** unify model roster grammar and stop model-id leaks ([#109](https://github.com/ecoma-io/reeve/issues/109))

### Features

* **dependa:** close the Renovate discovery gaps and dogfood for real ([#125](https://github.com/ecoma-io/reeve/issues/125)) ([185154d](https://github.com/ecoma-io/reeve/commit/185154de7f46c5ea5919f7d734dba65f2d5f357e))
* **docs:** bootstrap README.vi.md and README.zh.md for harmonise ([#116](https://github.com/ecoma-io/reeve/issues/116)) ([cd8d12d](https://github.com/ecoma-io/reeve/commit/cd8d12dcfadcd7d7952617aee2e395c4aa6cb92e))
* **harmonise:** bootstrap missing locale files and localise internal links ([#121](https://github.com/ecoma-io/reeve/issues/121)) ([42cde8c](https://github.com/ecoma-io/reeve/commit/42cde8c4feb2a69304542c7af6aa74a6faa2bd89))
* **provider:** unify model roster grammar and stop model-id leaks ([#109](https://github.com/ecoma-io/reeve/issues/109)) ([4f91e3b](https://github.com/ecoma-io/reeve/commit/4f91e3b3a2ebcd3b9690ebd5bd4c02e01dd1dd48))
* **review:** agentic mode — the diff served by bounded read-only tools ([#119](https://github.com/ecoma-io/reeve/issues/119)) ([5784e48](https://github.com/ecoma-io/reeve/commit/5784e480a89dba5f571883d44448527472aaa776))
* **review:** enable review comment on dogfood PRs ([#114](https://github.com/ecoma-io/reeve/issues/114)) ([e933f3d](https://github.com/ecoma-io/reeve/commit/e933f3d5d0903e22545b52381af20f350c36b371))
* **review:** generated-skip defaults, SARIF export, and the tool-loop doctrine ([#118](https://github.com/ecoma-io/reeve/issues/118)) ([2d408f0](https://github.com/ecoma-io/reeve/commit/2d408f0a6b08e4ebc759ebf1d57733678b36587c))
* **review:** triple default budget to 12000, override to 600k/300k in dogfood ([#113](https://github.com/ecoma-io/reeve/issues/113)) ([d6ddcca](https://github.com/ecoma-io/reeve/commit/d6ddcca547fe31244eba8e41458461100891a8d0))
* **translate:** branding line, shared glossary enforcement, and runtime-first README ([#122](https://github.com/ecoma-io/reeve/issues/122)) ([f67d69e](https://github.com/ecoma-io/reeve/commit/f67d69e70625c2e333267c478c5613df48b58369))
* **translate:** fold boundary note and footer into each language's section ([#115](https://github.com/ecoma-io/reeve/issues/115)) ([44788ec](https://github.com/ecoma-io/reeve/commit/44788ec1509f9ed003e2c85b6fa902383363d4a8))


### Bug Fixes

* **ci:** repair fabricated action digest pins and run scripts self-tests ([#100](https://github.com/ecoma-io/reeve/issues/100)) ([79485df](https://github.com/ecoma-io/reeve/commit/79485df6d50b11a24f88df26a943f6a4fbe1eede))
* **dependa:** parse pnpm-lock.yaml v9 with a real YAML parser ([#123](https://github.com/ecoma-io/reeve/issues/123)) ([48deb12](https://github.com/ecoma-io/reeve/commit/48deb124fe01db7d4a99fd55eddbd148108875e0))
* **harmonise:** paths filter scopes document groups, not raw file paths ([#124](https://github.com/ecoma-io/reeve/issues/124)) ([e81b73a](https://github.com/ecoma-io/reeve/commit/e81b73ada7a6be41e4062eae4913359be30e7d16))
* **review:** drop empty generated suffixes at the parse boundary ([#107](https://github.com/ecoma-io/reeve/issues/107)) ([752ff8e](https://github.com/ecoma-io/reeve/commit/752ff8e7ec8cd712f59f34222e575faa9e7862b3))
* **review:** fail red when every pass is exhausted by protocol errors ([#103](https://github.com/ecoma-io/reeve/issues/103)) ([79adbb2](https://github.com/ecoma-io/reeve/commit/79adbb2b4d0ec497af026138da7ab3ad75909fa5))
* **workspace:** determinism P1 — same input, same bytes, in any environment or listing order ([#104](https://github.com/ecoma-io/reeve/issues/104)) ([c39d2be](https://github.com/ecoma-io/reeve/commit/c39d2be1dee37f79dee548419576f861bb533d06))

## [0.8.0](https://github.com/ecoma-io/reeve/compare/v0.7.0...v0.8.0) (2026-08-18)


### Features

* **eval:** close review evaluation gaps — PR language, update path, shadow fixtures ([#72](https://github.com/ecoma-io/reeve/issues/72)) ([dbd1969](https://github.com/ecoma-io/reeve/commit/dbd1969f734b339f489f365327c619feff3e2987))
* **eval:** publish Stage-6 worst-language measurements (3 providers, all 100%) ([#84](https://github.com/ecoma-io/reeve/issues/84)) ([bebe295](https://github.com/ecoma-io/reeve/commit/bebe295700e3225eb41ea61be387154f1773aa5d))
* **review:** architecture and dependency-boundary review ([#75](https://github.com/ecoma-io/reeve/issues/75)) ([c84e58a](https://github.com/ecoma-io/reeve/commit/c84e58a4ed39161f979083bc44d078696ebb8973))
* **review:** deep repository context engine ([#82](https://github.com/ecoma-io/reeve/issues/82)) ([06562ca](https://github.com/ecoma-io/reeve/commit/06562caf30a505780d0e5a8b3cc42adcc4525217))
* **review:** evidence-based verification of model findings ([#76](https://github.com/ecoma-io/reeve/issues/76)) ([58bfd9c](https://github.com/ecoma-io/reeve/commit/58bfd9cac1756c82be8e40bc23033c2dd659e326))
* **review:** finding lifecycle 2.0 — evidence, human disposition, audit ([#81](https://github.com/ecoma-io/reeve/issues/81)) ([fec2feb](https://github.com/ecoma-io/reeve/commit/fec2feb98d1df076a057696f423ae7af9b8fee92))
* **review:** inline findings with owned review threads ([#85](https://github.com/ecoma-io/reeve/issues/85)) ([76f5162](https://github.com/ecoma-io/reeve/commit/76f5162322025e720054ca169439c48c8134f3a1))
* **review:** multi-pass adversarial review engine with synthesis ([#77](https://github.com/ecoma-io/reeve/issues/77)) ([b7780d5](https://github.com/ecoma-io/reeve/commit/b7780d525dc64b57cf7287896a3442e59b314fac))
* **review:** remediation proposals for blocked findings ([#83](https://github.com/ecoma-io/reeve/issues/83)) ([5076774](https://github.com/ecoma-io/reeve/commit/507677498418033a846121fc78e8e7750816d147))
* **review:** risk-based review profiles ([#78](https://github.com/ecoma-io/reeve/issues/78)) ([c2aed45](https://github.com/ecoma-io/reeve/commit/c2aed45e75caea7ef46f217858659bdb3ad93873))
* **review:** test-aware change-completeness review ([#80](https://github.com/ecoma-io/reeve/issues/80)) ([b02ad18](https://github.com/ecoma-io/reeve/commit/b02ad18676ff5bf8e84a24a356dca5126d085ccb))
* **review:** versioned composed rule packs ([#79](https://github.com/ecoma-io/reeve/issues/79)) ([d3f557f](https://github.com/ecoma-io/reeve/commit/d3f557f597244d00ed368e6135fc36d32d57c95c))
* **workspace:** shared format/lint/doc-link hooks for all three agents ([#95](https://github.com/ecoma-io/reeve/issues/95)) ([73bda1e](https://github.com/ecoma-io/reeve/commit/73bda1e2c7cb6659c779dce16751ca4462a778f2))


### Bug Fixes

* **harmonise:** run on push events without requiring a thread number ([#71](https://github.com/ecoma-io/reeve/issues/71)) ([a731ba2](https://github.com/ecoma-io/reeve/commit/a731ba234eba2a820c79d82ba47fefca9729f4b7))
* **model-consumption:** uniform roster rotation for harmonise classify; cheap detect roster for respond ([#87](https://github.com/ecoma-io/reeve/issues/87)) ([8a0ebda](https://github.com/ecoma-io/reeve/commit/8a0ebda08c36745e70aa16108002bb9caba659d9))
* **review:** api-freeze era — adjudicated respond/harmonise behaviors, orphaned exports, cleanup ([#93](https://github.com/ecoma-io/reeve/issues/93)) ([f08d0f8](https://github.com/ecoma-io/reeve/commit/f08d0f8481da264799a24d03334f60066f19f327))
* **review:** skip interior lines of multi-line block comments during edge extraction ([#86](https://github.com/ecoma-io/reeve/issues/86)) ([2635c90](https://github.com/ecoma-io/reeve/commit/2635c90587e00a25b2f37eedce505f82660e0751))

## [0.7.0](https://github.com/ecoma-io/reeve/compare/v0.6.0...v0.7.0) (2026-08-17)


### Features

* **dependa:** add dogfood conformance comparison against Renovate ([#63](https://github.com/ecoma-io/reeve/issues/63)) ([6351ce6](https://github.com/ecoma-io/reeve/commit/6351ce6d150b43351fb5104f26aa7d76ce51d515))
* **workspace:** single-authority warrant, review duty, 8-duty eval gate — 1.0 prep ([#70](https://github.com/ecoma-io/reeve/issues/70)) ([8e57d08](https://github.com/ecoma-io/reeve/commit/8e57d0824f02ef5812e884729d4afb8cb52388cf))


### Bug Fixes

* close N1 fail-open on advisory auth + CI doc-links guards ([#69](https://github.com/ecoma-io/reeve/issues/69)) ([6650ed5](https://github.com/ecoma-io/reeve/commit/6650ed5777e0a56c2834727f792dd7570cbd1966))
* **dependa:** f1 edit recomposition + d3 compareCommits + fail-closed attribution ([#67](https://github.com/ecoma-io/reeve/issues/67)) ([564fb04](https://github.com/ecoma-io/reeve/commit/564fb046368d9a4bb386b16e49d678aa7f149ac0))
* first-contact usability audit — P0/P1 fixes, doc drift, protocol exhaustion ([#66](https://github.com/ecoma-io/reeve/issues/66)) ([efb5162](https://github.com/ecoma-io/reeve/commit/efb516276a0fd550b9f43506c4c943a58fc40ef8))
* harden 0.6.x — dependa, harmonise, respond, translate, triage, core ([#65](https://github.com/ecoma-io/reeve/issues/65)) ([acfc4a9](https://github.com/ecoma-io/reeve/commit/acfc4a9b5dd56bce6e43f105f0b77cc15f053d11))

## [0.6.0](https://github.com/ecoma-io/reeve/compare/v0.5.0...v0.6.0) (2026-08-14)


### Features

* **dependa:** add dependency maintenance duty ([#61](https://github.com/ecoma-io/reeve/issues/61)) ([c83d397](https://github.com/ecoma-io/reeve/commit/c83d3975004753248c63a91459ba2cce7b02d67d))
* harmonise sweep pattern, capacity error guards, standardised outputs, tighter isCapacityError ([#60](https://github.com/ecoma-io/reeve/issues/60)) ([779b23b](https://github.com/ecoma-io/reeve/commit/779b23b34d3008c53052917eee9bb69cc1d2f139))
* **harmonise:** add dogfood workflow for README.md translation to vi and zh ([8d230c9](https://github.com/ecoma-io/reeve/commit/8d230c90c0d5dc34254d2728408152e73f772fe7))


### Bug Fixes

* **dependa:** harden against adversarial findings from correctness + security review ([#62](https://github.com/ecoma-io/reeve/issues/62)) ([3c65ffb](https://github.com/ecoma-io/reeve/commit/3c65ffb6b9dad8f770b1b1c5d1c8e6044e7e2c4d))

## [0.5.0](https://github.com/ecoma-io/reeve/compare/v0.4.0...v0.5.0) (2026-08-14)


### Features

* configurable branch target for provenance and corrections ([#51](https://github.com/ecoma-io/reeve/issues/51)) ([ad4925f](https://github.com/ecoma-io/reeve/commit/ad4925ff477f9a09adc6cbd904844c637ff49f17))
* default state-branch to dedicated branches, rename storage inputs to -dir suffix ([#55](https://github.com/ecoma-io/reeve/issues/55)) ([1364d6b](https://github.com/ecoma-io/reeve/commit/1364d6b75b008bc51c4c6656e38d8ea7e260fa0e))
* **harmonise:** add chunk-chars input for large document drafting ([#54](https://github.com/ecoma-io/reeve/issues/54)) ([31c812d](https://github.com/ecoma-io/reeve/commit/31c812d06cc55f98cc79f3024c2624e226c3f3c6))


### Bug Fixes

* **harmonise:** address medium and low findings from adversarial review ([#53](https://github.com/ecoma-io/reeve/issues/53)) ([3fb39c8](https://github.com/ecoma-io/reeve/commit/3fb39c8156682948f00a30518e0da407da906080))
* **harmonise:** implement draft loop, judge panel, budget enforcement, and script verification ([#52](https://github.com/ecoma-io/reeve/issues/52)) ([2e2821b](https://github.com/ecoma-io/reeve/commit/2e2821b5c12684ff07edf40c378c182e896185ff))
* **harmonise:** prevent adjacent ignore markers from consuming each other ([#57](https://github.com/ecoma-io/reeve/issues/57)) ([9b6fd9f](https://github.com/ecoma-io/reeve/commit/9b6fd9f724c3e0728df0d7bb451bfde6af43dd5d))
* **harmonise:** resolve sourceRevision blob SHA to historical content before diffing ([#46](https://github.com/ecoma-io/reeve/issues/46)) ([64cd304](https://github.com/ecoma-io/reeve/commit/64cd304d5d8a29f2b42e4a74726e85427cd21061))

## [0.4.0](https://github.com/ecoma-io/reeve/compare/v0.3.0...v0.4.0) (2026-08-13)


### Features

* **chrome:** add 18 languages to chrome table ([#45](https://github.com/ecoma-io/reeve/issues/45)) ([ebf6a8a](https://github.com/ecoma-io/reeve/commit/ebf6a8aee8fbda6d0fc044635f367b8e2521bc71))
* complete self-dogfood and feedback loop (Phase 1 + Phase 2) ([#42](https://github.com/ecoma-io/reeve/issues/42)) ([673cf43](https://github.com/ecoma-io/reeve/commit/673cf439b9ec783f227be3627e458c5f0abddc28))
* **harmonise:** implement the harmonise duty ([#44](https://github.com/ecoma-io/reeve/issues/44)) ([f359740](https://github.com/ecoma-io/reeve/commit/f359740adbf1bdfb2d3c59f63caad8c5b6c804d0))

## [0.3.0](https://github.com/ecoma-io/reeve/compare/v0.2.1...v0.3.0) (2026-08-13)


### Features

* **chrome:** localize chrome and add read-only doctor mode ([#34](https://github.com/ecoma-io/reeve/issues/34)) ([3aadab4](https://github.com/ecoma-io/reeve/commit/3aadab49eaef88f86219ebdda7056a9c48036347))
* **lifecycle:** add the lifecycle duty, atlas core module, and triage's propose capability ([#32](https://github.com/ecoma-io/reeve/issues/32)) ([ba81131](https://github.com/ecoma-io/reeve/commit/ba81131001a3ed5b2b5e3af4ae914c900b20fd41))
* **memory:** learn from reversals and gate re-closes against them ([#31](https://github.com/ecoma-io/reeve/issues/31)) ([5f109bf](https://github.com/ecoma-io/reeve/commit/5f109bf04ad04773cdc0b69dabb9410b7e8ae4f5))
* **provider:** multi-endpoint rosters, chunked translation, honest sweep paging ([db73109](https://github.com/ecoma-io/reeve/commit/db731092df3827fc72bd9ac663d756cfefd202a5))
* **warrant:** close out P2/P3 review findings across warrant, memory, translate and triage ([#29](https://github.com/ecoma-io/reeve/issues/29)) ([0f31cc6](https://github.com/ecoma-io/reeve/commit/0f31cc6892f4af66783aff4e12852d2363aa9896))


### Bug Fixes

* **action:** shorten marketplace description under 125 characters ([#39](https://github.com/ecoma-io/reeve/issues/39)) ([86718c8](https://github.com/ecoma-io/reeve/commit/86718c8177b339f015e51a04c0d04ac5840fe6fb))
* **ci:** rebuild only the bundle each integration test drives ([#38](https://github.com/ecoma-io/reeve/issues/38)) ([867b0b8](https://github.com/ecoma-io/reeve/commit/867b0b870c0ad0a24fe6ed3d7877901c3ada266e))

## [0.2.1](https://github.com/ecoma-io/reeve/compare/v0.2.0...v0.2.1) (2026-08-11)


### Bug Fixes

* **respond:** render the withheld draft in the job summary ([af4171a](https://github.com/ecoma-io/reeve/commit/af4171a1871a9253164a66fc32dcbc401b4e1ed1))

## [0.2.0](https://github.com/ecoma-io/reeve/compare/v0.1.0...v0.2.0) (2026-08-11)


### Features

* **core:** the warrant is the whole answer — languages, capabilities, and the office ([#16](https://github.com/ecoma-io/reeve/issues/16)) ([7da04ec](https://github.com/ecoma-io/reeve/commit/7da04ecdda29fb7fecef6e13ef46307987894f96))
* **duplicate:** rank the open backlog and let a judge confirm before anyone comments ([9d342c9](https://github.com/ecoma-io/reeve/commit/9d342c9e453a891b41909fbea5a6f6281232f582))
* **memory:** the store learns from label changes, and recall crosses languages ([#19](https://github.com/ecoma-io/reeve/issues/19)) ([372d364](https://github.com/ecoma-io/reeve/commit/372d3647f52cb69ea0e286cbde2f07ff87c57629))
* **respond:** add the respond duty — one first reply, then done ([b1b9f4c](https://github.com/ecoma-io/reeve/commit/b1b9f4cd955d0a0a4bc0685b0e4bfa2046a49efd))

## 0.1.0 (2026-08-11)


### Features

* **provider:** weather is not failure — D12 in code, and the sweep ([#15](https://github.com/ecoma-io/reeve/issues/15)) ([8392cd6](https://github.com/ecoma-io/reeve/commit/8392cd6b75d079befc6143c84d253a5a89572a62))
* **translate:** let a workflow name its models instead of publishing their ids ([#7](https://github.com/ecoma-io/reeve/issues/7)) ([12946b6](https://github.com/ecoma-io/reeve/commit/12946b68e77bb8374323d2a19d7d1d30806effee))
* **translate:** let one judge seat fall back without becoming two votes ([#6](https://github.com/ecoma-io/reeve/issues/6)) ([89b4032](https://github.com/ecoma-io/reeve/commit/89b4032ef427feac98dab692c3ee6df89a8c0493))
* **translate:** report every run, and what it cost, on the job summary ([#8](https://github.com/ecoma-io/reeve/issues/8)) ([441a619](https://github.com/ecoma-io/reeve/commit/441a619af67e90842b93ef3a88bfb64ac4c8ccd7))
* **translate:** ship the first duty on the core pipeline ([#4](https://github.com/ecoma-io/reeve/issues/4)) ([f614015](https://github.com/ecoma-io/reeve/commit/f614015f8d50582a59bae22f98e7ad45413835ea))
* **triage:** sort a backlog against the taxonomy the maintainers wrote ([#11](https://github.com/ecoma-io/reeve/issues/11)) ([c67b8b6](https://github.com/ecoma-io/reeve/commit/c67b8b6868dc495322add5d0f59be0627a654820))
* **warrant:** the bottom rung — zero-config triage at the narrowest authority ([#14](https://github.com/ecoma-io/reeve/issues/14)) ([202997a](https://github.com/ecoma-io/reeve/commit/202997ad6cd4047eaf9d2aef02083a3fc89d57e1))
* **workspace:** initialise Reeve ([7a5a56b](https://github.com/ecoma-io/reeve/commit/7a5a56b95606bb3c3aa96b74a466c51ece634a49))
