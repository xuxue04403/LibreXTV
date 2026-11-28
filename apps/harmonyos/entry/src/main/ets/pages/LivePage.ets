/**
 * 直播页：分组筛选 + 台名搜索 + 频道网格。
 *
 * 频道来源是多个 m3u 清单，按清单顺序加载并跨源按台名去重，
 * 所以同一个 CCTV1 只留排在最前面（可播率最高）的那个源。
 */
import { appModel } from '../model/AppModel';
import { LiveChannel, LiveStatus, PageId } from '../model/Types';
import { Palette, Poster, PillButton, HintLine, EmptyBox, SectionTitle } from '../view/Common';

/** 把一个源的结算结果写成一行可读文字 */
function liveStatusText(st: LiveStatus): string {
  if (st.ok) {
    return `${st.sourceName} · ${st.count} 台`;
  }
  const err = st.error !== undefined && st.error.length > 0 ? st.error : '失败';
  return `${st.sourceName} · ${err}`;
}

@Component
export struct LivePage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  @State private keyword: string = '';
  /** counts() 的缓存：见该方法注释 */
  private groupCounts: Map<string, number> | null = null;
  private countsFor: LiveChannel[] | null = null;

  aboutToAppear(): void {
    if (!appModel.live.loadedOnce && !appModel.live.loading) {
      appModel.loadLive(false);
    }
  }

  /**
   * 各分组的频道数。
   *
   * 结果缓存在 groupCounts 字段里，只在 channels 变成新数组时重算 ——
   * 原来每个分组芯片渲染时都调一次 counts() 从头遍历整张表：
   * 1500 个频道 × 40 个分组 ≈ 6 万次 Map 写入，一次重绘就卡住。
   */
  private counts(): Map<string, number> {
    if (this.groupCounts !== null && this.countsFor === appModel.live.channels) {
      return this.groupCounts;
    }
    const map = new Map<string, number>();
    map.set('全部', appModel.live.channels.length);
    for (let i = 0; i < appModel.live.channels.length; i++) {
      const g = appModel.live.channels[i].group ?? '未分组';
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    this.groupCounts = map;
    this.countsFor = appModel.live.channels;
    return map;
  }

  build() {
    Column() {
      // 标题行
      Row({ space: 8 }) {
        Text('直播频道')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(Palette.TextPrimary)
        Text(this.statusText())
          .fontSize(11)
          .fontColor(Palette.TextMuted)
          .layoutWeight(1)
        PillButton({
          text: appModel.live.loading ? '读取中…' : '重载',
          disabled: appModel.live.loading,
          onTap: () => {
            appModel.loadLive(true);
          },
        })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 6 })

      // 频道搜索
      TextInput({ text: this.keyword, placeholder: '筛选台名，如 CCTV / 湖南' })
        .height(38)
        .fontSize(13)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Panel)
        .borderRadius(10)
        .border({ width: 1, color: Palette.Line })
        .margin({ left: 16, right: 16 })
        .onChange((value: string) => {
          this.keyword = value;
          appModel.setLiveKeyword(value);
        })

      // 分组
      if (appModel.live.groups.length > 1) {
        Scroll() {
          Row({ space: 8 }) {
            ForEach(appModel.live.groups, (group: string) => {
              Text(group === '全部' ? `全部 ${appModel.live.channels.length}` : `${group} ${this.counts().get(group) ?? 0}`)
                .fontSize(11)
                .fontColor(appModel.live.selectedGroup === group ? '#FFC4B0' : Palette.TextMuted)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor(appModel.live.selectedGroup === group ? Palette.AccentSoft : Palette.Panel)
                .borderRadius(999)
                .border({ width: 1, color: appModel.live.selectedGroup === group ? Palette.Accent : Palette.Line })
                .onClick(() => {
                  appModel.setLiveGroup(group);
                })
            }, (group: string) => group)
          }
          .padding({ left: 16, right: 16, top: 8 })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .height(40)
      }

      // 各源结算情况
      // statuses 是 LiveStatus 对象，不是字符串：直接 Text(st) 渲染出来是
      // "[object Object]"，而且 key 也是对象（全都一样，ForEach 会报重复 key）。
      if (appModel.live.statuses.length > 0) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(appModel.live.statuses, (st: LiveStatus) => {
              Text(liveStatusText(st))
                .fontSize(10)
                .fontColor(Palette.TextMuted)
                .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                .backgroundColor(Palette.Panel)
                .borderRadius(999)
                .border({ width: 1, color: Palette.Line })
            }, (st: LiveStatus) => st.sourceKey)
          }
          .padding({ left: 16, right: 16, top: 4 })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .height(28)
      }

      // 频道列表
      if (appModel.live.channels.length === 0) {
        Column() {
          if (appModel.live.loading) {
            LoadingProgress()
              .width(40)
              .height(40)
              .color(Palette.Accent)
              .margin({ top: 40 })
            Text(`正在读取直播源 ${Math.floor(appModel.live.bytes / 1024)} KB…`)
              .fontSize(12)
              .fontColor(Palette.TextMuted)
              .margin({ top: 10 })
          } else {
            Column() {
              EmptyBox({
                title: '没有可用的直播频道',
                description: '所有启用的直播源都没能返回内容。可以到设置里换用别的源，或稍后重试。',
                actionText: '重新加载',
                onAction: () => {
                  appModel.loadLive(true);
                },
              })
            }
            .width('100%')
            .margin({ top: 24 })
          }
        }
        .width('100%')
        .layoutWeight(1)
      } else if (this.visible().length === 0) {
        Column() {
          Column() {
            EmptyBox({
              title: '这个筛选下没有频道',
              description: '换个分组或清空搜索词试试',
            })
          }
          .width('100%')
          .margin({ top: 24 })
        }
        .width('100%')
        .layoutWeight(1)
      } else {
        Grid() {
          // Grid 自带复用：只创建可视区的 GridItem，滚动时复用。
          // 之前担心的「1500 个频道全量急切渲染」在 Grid 里其实不会发生，
          // 真正拖慢重绘的是分组芯片里每次重算 counts()（已加缓存）。
          ForEach(this.visible(), (channel: LiveChannel) => {
            GridItem() {
              Row({ space: 8 }) {
                // 台标
                Stack() {
                  if (channel.logo !== undefined && channel.logo.length > 0) {
                    Image(channel.logo)
                      .width('100%')
                      .height('100%')
                      .objectFit(ImageFit.Contain)
                      .onError(() => {
                        // 台标挂了就不显示，保留底色
                      })
                  } else {
                    Text(channel.name.slice(0, 2))
                      .fontSize(11)
                      .fontColor('#455063')
                  }
                }
                .width(38)
                .height(38)
                .borderRadius(6)
                .clip(true)
                .backgroundColor('#10141B')

                Column({ space: 2 }) {
                  Text(channel.name)
                    .fontSize(12)
                    .fontColor(Palette.TextPrimary)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(channel.group ?? '未分组')
                    .fontSize(10)
                    .fontColor(Palette.TextMuted)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                Text(appModel.isLiveFavorite(channel.url) ? '★' : '☆')
                  .fontSize(16)
                  .fontColor(appModel.isLiveFavorite(channel.url) ? Palette.WarnAmber : Palette.TextMuted)
                  .padding(6)
                  .onClick(() => {
                    appModel.toggleLiveFavorite(channel);
                  })
              }
              .width('100%')
              .height(58)
              .padding({ left: 8, right: 6 })
              .backgroundColor(Palette.Panel)
              .borderRadius(10)
              .border({ width: 1, color: Palette.Line })
              .onClick(() => {
                appModel.openLivePlayer(channel, this.visible());
              })
            }
          }, (channel: LiveChannel) => `${channel.sourceKey}:${channel.url}`)
        }
        .columnsTemplate('1fr 1fr')
        .columnsGap(10)
        .rowsGap(8)
        .padding({ left: 16, right: 16, top: 8, bottom: 20 })
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Palette.Bg)
  }

  private visible(): LiveChannel[] {
    const out: LiveChannel[] = [];
    const group = appModel.live.selectedGroup;
    const kw = this.keyword.trim().toLowerCase();
    const list = appModel.live.channels;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const g = c.group ?? '未分组';
      if (group !== '全部' && g !== group) {
        continue;
      }
      if (kw.length > 0 && c.name.toLowerCase().indexOf(kw) < 0) {
        continue;
      }
      out.push(c);
    }
    return out;
  }

  private statusText(): string {
    const live = appModel.live;
    if (live.loading) {
      return `读取中 ${Math.floor(live.bytes / 1024)} KB`;
    }
    if (!live.loadedOnce) {
      return '尚未加载';
    }
    return `${live.channels.length} 个频道`;
  }
}
