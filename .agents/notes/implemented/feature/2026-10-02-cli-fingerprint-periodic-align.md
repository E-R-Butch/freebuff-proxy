# Agent Note: CLI Fingerprint Periodic Version Alignment

Status: implemented

**Affects:** `bin/serve.ts`, `src/upstream/official-fingerprint.ts`

## Problem

A long-running process needs an explicit way to inspect current CLI release metadata.
The previous setting was absent from stored settings and its scheduler only observed startup.
The version string was never wired to the actual chat UA.

## Decision

Use the optional, default-disabled runtime metadata check described in
[the current note](2026-10-13-cli-version-refresh.md). Enabling checks npm once and arms a
six-hour timer; disabling aborts the check and clears the timer. Stored settings and
live transitions use the same field validation.

The value is release information. It does not install a client binary or change SDK
request headers. Session caller version reporting is independent.

## Consequences

No registry call occurs by default. Enabled checks keep the last valid cache on failure.
Real upstream compatibility requires separate verification.

## Alternatives considered

### 1. 只在启动时刷新一次(现状)

**Pros:** 零额外代码,零定时器.
**Rejected:** Docker 常驻场景下版本会永久停在启动时刻,与官方差距随时间拉大.

### 2. 每个请求都拉 npm 版本号

**Rejected:** 每个请求多一次外网 RTT,且 npm registry 不可达时会影响请求路径.
版本号的时效性要求远低于请求延迟 —— 6h 粒度足够.

### 3. 硬编码最新版本号,定期手工更新

**Rejected:** 需要人工跟进,且版本写死在代码里必然滞后于官方发版.

### 4. 什么都不做

**Rejected:** 落后版本是已知的指纹风险,且已有 `refreshCliVersion()` 基础设施,
接一个周期调用的边际成本极低.

## Related

- `src/upstream/official-fingerprint.ts`:版本真源与 `refreshCliVersion()` / `getCliVersion()`
- 协议逆向总结:`docs/reverse/11-tls-fingerprint.md` § CLI 指纹(`REVERSE_ENGINEERING_SUMMARY.md` 已废弃删除:它写的 CLI 版本号 `0.2.12` 与真值 `KNOWN_CLI_VERSION` 不符)
