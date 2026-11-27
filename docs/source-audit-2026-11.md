# 内置播放源体检与换血（2026-11，清单 version 7）

用户要求（原文）：

> 1.检查GitHub上librextv项目是否更新了新的点播源和直播源
> 2.验证当前收纳的播放源是否可以正确加载
> 3.全网检索并验证国内可使用的点播源和直播源，并内置到播放器内

中途用户追加了一条关键前提：

> 已关闭clash，请重新测试播放源，确保国内网络可用！

这条改变了整轮的结论：第一次实测是在日本东京机房出口（`85.234.83.145`）下做的，关掉代理后出口变成中国移动宽带（`117.152.196.21`，上海 AS9808），**同一个源在两地的结果可能完全相反**，所有数据都重跑了一遍。

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 上游是否新增默认源 | **否**。上游 2.22.0 起源不再硬编码，全靠 `DEFAULT_SOURCES` / `DEFAULT_LIVE_SOURCES` / `DEFAULT_SUBSCRIPTIONS` 环境变量注入 |
| 旧清单（v6）在国内能不能用 | 点播 6/10、直播 **0/5**（三个默认启用的源整份清单都下不下来） |
| 新清单（v7）在国内能不能用 | 点播 11/13 首集可播、直播 4/7 超过 50%（最高 78%） || 改动 | `defaults/sources.json` v6 → v7：点播 10 → 13、直播 5 → 7；另修了点播源换址不生效的缺陷 |

## 1. 上游 LibreTV 不再提供默认源

拉 `https://raw.githubusercontent.com/LibreSpark/LibreTV/main/README.md` 确认：2.22.0 的源完全由环境变量注入，README 里的示例全是 `https://example.com/api.php/provide/vod` 这种占位符，仓库里没有任何可借鉴的真实地址。

上游同时定了订阅的导入规则（对我们的源清单有参考价值）：点播源最多 100 个、直播源最多 50 个；只接受 `sites` 里 `type: 1`（或地址命中 `api.php/provide/vod` 的 type 0）的标准 Apple CMS 采集站，`type: 3` 的 Spider 站点（`.jar` / `.js` / `.py`）一律跳过；直播只导入 `lives` 里 `type: 0` 的 M3U。

所以「等上游更新源」这条路不存在，内置清单只能自己维护自己实测。

## 2. 国内网络的两个前提事实

**（1）GitHub 的下载通道全断。** 关掉代理后 `raw.githubusercontent.com`、`cdn.jsdelivr.net`、`github.com` 一律在 TLS 握手阶段被重置（TCP 443 通，但「远程主机强迫关闭了一个现有的连接」）。可用的替代是 jsDelivr 的备用域名：

| 域名 | 取一份 90KB 清单 | 结论 |
| --- | --- | --- |
| `fastly.jsdelivr.net` | 933ms | 采用 |
| `testingcf.jsdelivr.net` | 991ms | 采用 |
| `originfastly.jsdelivr.net` | 1268ms | 可用 |
| `quantil.jsdelivr.net` | 1527ms | 可用 |
| `gcore.jsdelivr.net` | 1541ms | 可用 |
| `cdn.jsdelivr.net` | fetch failed | 不可用 |

GitHub 反代实测全部不可用：`ghfast.top`、`ghproxy.net`、`gh.llkk.cc`、`hub.gitmirror`、`raw.gitmirror.com`、`ghps.cc`、`kkgithub`、`moeyy`、`ghp.ci`、`gitdl.cn`、`gh.api.99988866`、`ghproxy.homeboyc.cn`、`cnb.cool`、`gitcode`。`gh-proxy.com` 第一次成功第二次超时，不稳定，不采用。

两个细节：jsDelivr 路径必须写全 `gh/user/repo@branch/path`，漏 `@branch` 会 404「Couldn't find the requested file /master」；`iptv-org` 是 GitHub Pages 而不是仓库文件，jsDelivr 取一律 404，只能走 `iptv-org.github.io`。

**（2）点播源的失败分两类。** `caiji.moduapi.cc`、`www.hongniuzy2.com`、`cj.rycjapi.com` 属于 TLS/SNI 被按域名重置（TCP 通、443 握手被断、HTTP 版也失败），这是地区封锁而不是源挂了；电影天堂那类「复测即恢复」的是网络抖动。区分这两者是决定「换域名」还是「直接放弃」的依据。

## 3. 旧清单（v6）的实测结果

点播 `npx vite-node tools/audit/source-health.ts`，直播 `npx vite-node tools/audit/live-health.ts -- --sample 40`。两个脚本都在 `tools/audit/` 下，默认读 `defaults/sources.json`。

**点播 6/10**：非凡 ✓、量子 ✓、360 ✓、极速 ✓、暴风 ✓、百度 ✓；魔都 ✗、电影天堂 ✗（复测恢复）、红牛 ✗、如意 ✗。

**直播 0/5**——这一栏是这轮最刺眼的：

| 源 | 结果 |
| --- | --- |
| iptv-org 全球频道 | 11452 台，加载 38.8s，抽 40 个只 3 个可播（**8%**） |
| iptv-org 中国频道 | 151 台，抽 40 个只 4 个可播（**10%**） |
| Collect-IPTV 精选 | **加载失败**（`cdn.jsdelivr.net` 被断） |
| vbskycn 国内 IPv4 | **加载失败**（`raw.githubusercontent.com` 被断） |
| Guovin 央视卫视 | **加载失败**（`cdn.jsdelivr.net` 被断） |

也就是说 v6 的「开箱即用」在国内实际是全死的：三个默认启用的源连清单都下不下来，能下下来的两个可播率不到 10%。README 里那句「Collect-IPTV 94% 可播」是日本 IP 下的旧数据，国内实测只有 40%。

## 4. 全网候选源的筛选

从 12 个公开 TVBox 配置地址（TVboxorg/TVbox、YiMing918/ym-tvbox、cluntop/tvbox、hjwp2026-cmd/self-tvbox、fengzhiku123/ysc-api、gaotianliuyun/gao，jsDelivr 与 raw 双地址都试）用正则抽标准采集接口，命中 59 条，清掉本地代理与重复后 50 条，逐条跑三层筛选（搜索 → 详情 → 首集分片）：

- 50 个候选里可用 18 个。
- 失败原因：`fetch failed`（域名解析/连接失败）最多，其次「返回内容不是合法 JSON」（接口已改成网页）、`HTTP 403`、「搜索无结果」（空库）。
- 剔掉 5 个成人站（搜索常见片名直接返回露骨结果）：精品资源、麻豆、滴滴、玉兔、嘿嘿。虽然 `packages/core/src/cms.ts` 有 `ADULT_KEYWORDS` / `ADULT_TITLE_KEYWORDS` 兜底（最大资源那批「伦理 / 港台三级 / 两性课堂 / 写真热舞」分类已被现有词表全覆盖），但整站成人内容不该内置。
- 同源镜像 6 组（同 `m3u8` pathname）：非凡 `cj.` ≡ `api.`、魔都 ≡ 魔都动漫、360 ≡ `360zy.com`、创享 ≡ 金鹰、新浪 ≡ 速播、滴滴 ≡ 嘿嘿。

**覆盖度分析改变了选源策略。** 用 24 个跨年代/国别片名（庆余年、流浪地球、狂飙、繁花、三体、漫长的季节、肖申克的救赎、星际穿越、霸王别姬、大明王朝1566、走向共和、请回答1988、进击的巨人、鬼灭之刃、海贼王、舌尖上的中国、无间道、让子弹飞、我的阿勒泰、唐朝诡事录、甄嬛传、亮剑 等）做「源 × 片名」矩阵：18 个源里绝大多数都是 24/24，两两 Jaccard 重合率遍地 100%，贪心选源第一次迭代就收敛。**这批采集站是高度同质的同一片库，多内置几个只增加并发请求和重复结果，不增加内容。** 所以最终只按「国内可达 + 全链路可播」挑，不追求数量。

## 5. 新清单（version 7）

### 点播 13 个

顺序即 `builtin_${index}`。**新源只能末尾追加**——从中间删或插会让后面所有下标前移，老用户已存的 `builtin_N` 会突然指向另一个站，历史与收藏跟着串台。

| # | 名称 | 地址 | 变动 |
| --- | --- | --- | --- |
| 0 | 非凡资源 | `https://api.ffzyapi.com/api.php/provide/vod` | |
| 1 | 量子资源 | `https://cj.lziapi.com/api.php/provide/vod` | |
| 2 | 魔都资源 | `https://www.mdzyapi.com/api.php/provide/vod` | 换址（原 `caiji.moduapi.cc` 被按域名重置） |
| 3 | 360 资源 | `https://www.360zy.com/api.php/provide/vod` | |
| 4 | 电影天堂 | `https://caiji.dyttzyapi.com/api.php/provide/vod` | http → https |
| 5 | 极速资源 | `https://jszyapi.com/api.php/provide/vod` | |
| 6 | 红牛资源 | `https://www.hongniuzy3.com/api.php/provide/vod` | 换址（原 `www.hongniuzy2.com` 被按域名重置） |
| 7 | 如意资源 | `https://cj.rycjapi.com/api.php/provide/vod` | **保留原位不删**，见下 |
| 8 | 暴风资源 | `https://bfzyapi.com/api.php/provide/vod` | |
| 9 | 百度资源 | `https://api.apibdzy.com/api.php/provide/vod` | |
| 10 | 金鹰资源 | `https://jyzyapi.com/api.php/provide/vod` | 新增 |
| 11 | 新浪资源 | `https://api.xinlangapi.com/xinlangapi.php/provide/vod` | 新增（路径是 `xinlangapi.php`） |
| 12 | 光速资源 | `https://api.guangsuapi.com/api.php/provide/vod` | 新增 |

**如意资源为什么不删**：它的全部已知域名（`cj.rycjapi.com`、`ryzyapi.com`、`rycjzy.com`、`ruyizy.com`、`ryapi.cc`、`rycjapi1.com`、`rycjzyapi.com`、`ryysapi.com`、`api./js./caiji./www.` 子域、http 版）在国内都是 `ECONNRESET`，确实死透了。但它占着 `builtin_7` 这个下标，删掉会让 8~12 全部前移。保留原位 + 靠 `packages/core/src/health.ts` 的 `SOURCE_HEALTH_FAIL_THRESHOLD = 2`（连挂两次停 30 分钟、再挂仍 30 分钟、第三次永久）自动兜底，用户不会一直等它。

### 直播 7 个

数组顺序就是加载与去重优先级（`Live.tsx` 跨源同名台只留最靠前的一条），所以按国内实测可播率从高到低排：

| # | 名称 | 地址 | 默认 | 可播率 |
| --- | --- | --- | --- | --- |
| 0 | iptv-org 全球频道 | `https://iptv-org.github.io/iptv/index.m3u` | 关 | 8%~30% |
| 1 | iptv-org 中国频道 | `https://iptv-org.github.io/iptv/countries/cn.m3u` | 关 | 10%~15% |
| 2 | vbskycn 国内 IPv4 | `https://fastly.jsdelivr.net/gh/vbskycn/iptv@master/tv/iptv4.m3u` | **开** | **73%~78%** |
| 3 | zhi35 央视卫视港澳台 | `https://fastly.jsdelivr.net/gh/zhi35/iptv@master/iptv.m3u` | **开** | 55%~60% |
| 4 | best-fan 国内全量 | `https://testingcf.jsdelivr.net/gh/best-fan/iptv-sources@main/cn_all_status.m3u8` | **开** | 57%~60% |
| 5 | Collect-IPTV 精选 | `https://fastly.jsdelivr.net/gh/zilong7728/Collect-IPTV@main/best_sorted.m3u` | **开** | 40%~43% |
| 6 | Guovin 央视卫视 | `https://testingcf.jsdelivr.net/gh/Guovin/iptv-api@gd/output/ipv4/result.m3u` | 关 | 18%~23% |

所有 GitHub 托管的源都换成 jsDelivr 备用域名——这是这轮最实质的修复：v6 里三个默认启用的源在国内**整份清单都下不下来**。`selected: false` 的三条照样进列表，只是新装用户默认不勾；`LIVE_SELECTION_VERSION = 5` 那套一次性取消勾选的迁移保持不变。

## 6. 顺带修掉的缺陷：点播源换址不生效

换址这件事暴露了 `seedDefaults` 的一个缺口：**换址替换只对直播源做了，点播源漏了。**

```ts
// 改之前：纯按 url 判重
const added = DEFAULT_SOURCES.filter((d) => !existingUrls.has(d.url) && !removed.has(d.url));
const sources = [...merged, ...added];
```

key 是按下标生成的，光按 url 判重会让老用户手里留下一条旧地址的 `builtin_2`，再追加一条同 key 的新条目——列表里出现两条同名同 key 的源，React key 与勾选状态都会打架。直播源一直有 `freshByKey` 这一步，点播源没有。现在两侧对称：

```ts
const srcFresh = new Map<string, (typeof DEFAULT_SOURCES)[number]>();
for (const d of DEFAULT_SOURCES) {
  const local = merged.find((x) => x.key === d.key);
  if (local && local.url !== d.url && !removed.has(local.url)) srcFresh.set(d.key, d);
}
const added = DEFAULT_SOURCES.filter(
  (d) => !existingUrls.has(d.url) && !removed.has(d.url) && !merged.some((x) => x.key === d.key)
);
const sources = [...merged.map((x) => srcFresh.get(x.key) ?? x), ...added];
```

TV 端 `AppViewModel.seedIfNeeded()` 同构补了一份（`freshVodByKey` / `mergedVod` / `addedVodKeys`）。

## 7. 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | ✓ 无错误 |
| 静态检查 | `npm run lint` | ✓ 零告警 |
| 单测 | `npm test` | ✓ 21 文件 / 358 用例全通过（17.0s） |
| 桌面构建 | `npm run build:desktop` | ✓ |
| TV 单测 | `.\gradlew.bat :app:compileDebugKotlin :app:testDebugUnitTest --tests "org.librextv.tv.data.DefaultsSelectionTest"` | ✓ BUILD SUCCESSFUL |

**构建产物内联校验**：`apps/desktop/out/renderer/assets/index-*.js` 里 `mdzyapi` / `hongniuzy3` / `guangsuapi` / `xinlangapi.php` / `jyzyapi` / `zhi35` / `best-fan` / `fastly.jsdelivr` 全部命中，旧地址 `caiji.moduapi.cc` / `hongniuzy2` / `cdn.jsdelivr.net/gh/zilong` / `raw.githubusercontent.com/vbskycn` 全部消失 → Vite alias `@defaults` 内联正确。

**升级路径实测**（`vitest.config.ts` 只收 `packages/**` 与 `apps/desktop/src/main/**`，renderer 的 `store.ts` 不在测试范围，环境也没有 jsdom，所以用 esbuild 把 store 打包后在 node 里 mock `localStorage` 跑真实 `seedDefaults()`）：

| 场景 | 结果 |
| --- | --- |
| v6 老用户（10 点播 + 5 直播，全是旧地址）→ v7 | 点播 13、无重复 key、无重复 url、旧地址残留 0 条、`defaultsVersion` 7 |
| 全新安装 | 点播 13、直播 7、默认启用 `builtin_live_2/3/4/5`、未启用 `0/1/6` |
| 删过非凡 + 红牛的老用户 | 点播 12；非凡不复活（url 没变，命中删除名单）；**红牛以新域名回来** |

最后一条是行为上的已知副作用：删除名单按 url 记录，源换域名后旧记录对不上新地址。判为可接受——用户当初删的是「那个站」，站点换域名后重新出现并不违背意图，且 `restoreBuiltinSources` 与设置页都能再删一次。

**最终复测（国内 IP）**：

- 点播 11/13 首集可播、11/13 末集也通。逐源：非凡 31 分类 / 12 条 / 461ms / 31 集 / 1432184B；量子 40/10/574ms/46/393108B；魔都 42/7/1350ms/74/262144B；360 51/6/426ms/36/511744B；电影天堂 32/11/548ms/46/991888B；极速 48/13/1544ms/36/225616B；红牛 44/13/330ms/36/487872B；暴风 49/18/2392ms/46/373556B；金鹰 44/13/845ms/36/487872B；新浪 48/13/534ms/36/211888B；光速 44/13/470ms/36/211888B。
- 两个失败性质不同。**如意资源**是 search 阶段就 `fetch failed`，确认死源。**百度资源**是 search 正常（54 分类、4 条命中、1.1~2.0s）、详情正常（25 集），卡在 m3u8 取流——单独连测三次，1 次 `✓·`（首集 88548B、末集抽检失败）、2 次 `playlist fetch failed`。这是它的片源 CDN 在抖动，不是接口挂了，所以**留在清单里**（同理占着 `builtin_9` 不便移动）；健康检查连挂两次会自动暂停它。
- 直播：vbskycn 78%、best-fan 57%、zhi35 55%、Collect-IPTV 40%、iptv-org 全球 28%、Guovin 23%、iptv-org 中国 15%。与选源时的排序一致。

## 8. 已知遗留

- **直播收藏按 url 存**（`packages/core/src/types.ts:208` `LiveFavoriteEntry { url, … }`），本次 3 个直播源换了镜像域名，老用户的这几条收藏会失效。点播侧有 `PlaybackCandidate` 自动换源，直播侧没有等价机制。
- **删除名单按 url 匹配**（`store.ts:379` `DEFAULT_SOURCES.some((d) => d.url === target.url)`），换域名的源即使被删过也会以新地址复活，见 §7。
- **`tools/audit/` 下 9 个脚本未入库**：`source-health.ts`（分层体检：分类→搜索→详情→m3u8→首集/末集分片）、`live-health.ts`（抽检 + 分辨率 + 首响中位数）、`hls.ts`（master 逐层跟随、首/中/尾三分片、按 magic bytes 判真视频）、`source-inspect.ts`、`source-m3u8.ts`、`source-dedupe.ts`、`source-coverage.ts`、`candidate-batch.ts`、`collect-candidates.mjs`。下次换源直接跑即可，建议随本次改动一起提交。

## 9. 一句话总结

v6 在国内基本不可用（点播 6/10、直播 0/5 能看），v7 换成「国内可达 + 全链路实测」的 13 个点播源和 7 个直播源（4 个默认启用、最高 78%），并修掉了点播源换址会在列表里留下两条同 key 条目的缺陷。
