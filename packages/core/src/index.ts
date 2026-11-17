/**
 * @librextv/core —— PC（Electron）与 Android TV 客户端共用的纯逻辑层。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）https://github.com/LibreSpark/LibreTV 的
 * src/lib 解析与聚合逻辑，去掉 Next.js 服务端依赖，HTTP 由宿主注入：
 * - 桌面端：渲染层 fetch 或 Electron 主进程回环代理
 * - Android TV：OkHttp 实现同接口（Kotlin 侧按同一语义重写）
 */

export * from './types';
export * from './cms';
export * from './categories';
export * from './catalog';
export * from './m3u';
export * from './ad-filter';
export * from './format';
export * from './group';
export * from './http';
export * from './recommend';
export * from './health';
export * from './quality';
export * from './skip-marks';
export * from './search';
export * from './detail';
export * from './failover';
export * from './stall-watchdog';
export * from './live';
export * from './live-switch';
export * from './pinyin';
export * from './title-index';
export * from './subscriptions';
export * from './storage';
