# Changelog

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
