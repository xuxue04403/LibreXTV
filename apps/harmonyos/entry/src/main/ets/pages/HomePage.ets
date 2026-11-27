/**
 * 首页：搜索入口、继续观看、收藏、直播收藏、数据统计。
 *
 * 与 TV 版的差别：没有「分类推荐大墙」（那需要额外探测每个源的全部分类，
 * 手机上第一屏更该是「接着看什么」），分类浏览收进分类页由搜索页进入。
 */
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { appModel } from '../model/AppModel';
import { HistoryEntry, FavoriteEntry, LiveFavoriteEntry, PageId, SearchItem } from '../model/Types';
import { Palette, Poster, SectionTitle, PillButton, EmptyBox, HintLine } from '../view/Common';

@Component
export struct HomePage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  private context = getContext(this) as common.UIAbilityContext;

  private resume(entry: HistoryEntry): void {
    appModel.resumeFromHistory(entry);
  }

  private openFavorite(fav: FavoriteEntry): void {
    const item: SearchItem = {
      sourceKey: fav.sourceKey,
      sourceName: '',
      vodId: fav.vodId,
      name: fav.title,
      pic: fav.cover,
    };
    appModel.openDetail(item, [item]);
  }

  private openLiveFavorite(fav: LiveFavoriteEntry): void {
    appModel.openLivePlayer({
      id: fav.url,
      name: fav.name,
      url: fav.url,
      logo: fav.logo,
      sourceKey: '',
      sourceName: '直播收藏',
    }, []);
  }

  build() {
    Column() {
      // 顶部品牌条
      Row() {
        Text('LibreXTV')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(Palette.Accent)
        Text(' 手机版')
          .fontSize(13)
          .fontColor(Palette.TextMuted)
        Blank()
        Text(`${appModel.activeSources().length}/${appModel.data.sources.length} 点播`)
          .fontSize(11)
          .fontColor(Palette.TextMuted)
        Text(`  ·  ${appModel.activeLiveSources().length}/${appModel.data.liveSources.length} 直播`)
          .fontSize(11)
          .fontColor(Palette.TextMuted)
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      // 搜索入口（点了直接跳搜索页）
      Row({ space: 8 }) {
        Text('🔍')
          .fontSize(14)
        Text('搜索片名、剧名或演员名')
          .fontSize(13)
          .fontColor(Palette.TextMuted)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .backgroundColor(Palette.Panel)
      .borderRadius(10)
      .border({ width: 1, color: Palette.Line })
      .margin({ left: 16, right: 16 })
      .onClick(() => {
        appModel.go(PageId.Search);
      })

      Scroll() {
        Column() {
          // 继续观看
          if (appModel.data.history.length > 0) {
            SectionTitle({ title: '继续观看', hint: `${appModel.data.history.length} 条记录` })
            List({ space: 10 }) {
              ForEach(appModel.data.history.slice(0, 14), (entry: HistoryEntry) => {
                ListItem() {
                  Row({ space: 10 }) {
                    Stack() {
                      Poster({
                        title: entry.title,
                        url: entry.cover ?? '',
                        tall: false,
                        showLabel: false,
                      })
                    }
                    .width(74)
                    .height(52)

                    Column({ space: 3 }) {
                      Text(entry.title)
                        .fontSize(14)
                        .fontColor(Palette.TextPrimary)
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                      Text(`第 ${entry.episodeIndex + 1} 集 · ${entry.sourceName}`)
                        .fontSize(11)
                        .fontColor(Palette.TextMuted)
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                      Text(progressText(entry))
                        .fontSize(10)
                        .fontColor(Palette.Accent)
                    }
                    .layoutWeight(1)
                    .alignItems(HorizontalAlign.Start)
                  }
                  .width('100%')
                  .padding(8)
                  .borderRadius(10)
                  .backgroundColor(Palette.Panel)
                  .onClick(() => {
                    this.resume(entry);
                  })
                }
              }, (entry: HistoryEntry) => entry.id)
            }
            .listDirection(Axis.Horizontal)
            .height(74)
            .scrollBar(BarState.Off)
          }

          // 收藏
          if (appModel.data.favorites.length > 0) {
            SectionTitle({ title: '我的收藏', hint: `${appModel.data.favorites.length} 部` })
            List({ space: 10 }) {
              ForEach(appModel.data.favorites, (fav: FavoriteEntry) => {
                ListItem() {
                  Column({ space: 4 }) {
                    Column() {
                      Poster({ title: fav.title, url: fav.cover ?? '', tall: true, showLabel: false })
                    }.width(96)
                    Text(fav.title)
                      .width(96)
                      .fontSize(11)
                      .fontColor(Palette.TextPrimary)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                  }
                  .onClick(() => {
                    this.openFavorite(fav);
                  })
                }
              }, (fav: FavoriteEntry) => fav.id)
            }
            .listDirection(Axis.Horizontal)
            .height(176)
            .scrollBar(BarState.Off)
          }

          // 直播收藏
          if (appModel.data.liveFavorites.length > 0) {
            SectionTitle({ title: '直播收藏', hint: `${appModel.data.liveFavorites.length} 个` })
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(appModel.data.liveFavorites, (fav: LiveFavoriteEntry) => {
                Row({ space: 6 }) {
                  Text('★')
                    .fontSize(12)
                    .fontColor(Palette.WarnAmber)
                  Text(fav.name)
                    .fontSize(12)
                    .fontColor(Palette.TextPrimary)
                    .maxLines(1)
                }
                .padding({ left: 12, right: 12, top: 7, bottom: 7 })
                .margin({ right: 8, bottom: 8 })
                .backgroundColor(Palette.Panel)
                .borderRadius(999)
                .border({ width: 1, color: Palette.Line })
                .onClick(() => {
                  this.openLiveFavorite(fav);
                })
              }, (fav: LiveFavoriteEntry) => fav.url)
            }
            .width('100%')
          }

          // 空态
          if (appModel.data.history.length === 0 && appModel.data.favorites.length === 0) {
            Column() {
              EmptyBox({
                title: '还没有观看记录',
                description: '点上面的搜索框找一部片子，看过之后这里会自动出现进度',
                actionText: '去搜索',
                onAction: () => {
                  appModel.go(PageId.Search);
                },
              })
            }
            .width('100%')
            .margin({ top: 16 })
          }

          // 数据概览
          SectionTitle({ title: '本机数据' })
          Column({ space: 6 }) {
            HintLine({ text: `点播源 ${appModel.activeSources().length} / ${appModel.data.sources.length} 启用` })
            HintLine({ text: `直播源 ${appModel.activeLiveSources().length} / ${appModel.data.liveSources.length} 启用` })
            HintLine({ text: `观看记录 ${appModel.data.history.length} 条 · 收藏 ${appModel.data.favorites.length} 部 · 直播收藏 ${appModel.data.liveFavorites.length} 个` })
            HintLine({ text: `内置清单版本 v${appModel.data.defaultsVersion}` })
          }
          .width('100%')
          .padding(12)
          .borderRadius(10)
          .backgroundColor(Palette.Panel)
          .alignItems(HorizontalAlign.Start)

          Row({ space: 10 }) {
            PillButton({ text: '源管理', onTap: () => {
              appModel.go(PageId.Settings);
            } })
            PillButton({ text: '直播', onTap: () => {
              appModel.go(PageId.Live);
            } })
          }
          .width('100%')
          .margin({ top: 12 })

          Text('内置源均为第三方公开接口，与本项目无隶属关系；可在设置中随时停用或删除。')
            .width('100%')
            .fontSize(10)
            .fontColor(Palette.TextMuted)
            .padding({ top: 14, bottom: 24 })
        }
        .padding({ left: 16, right: 16 })
        .alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Palette.Bg)
  }
}

function progressText(entry: HistoryEntry): string {
  const pos = entry.positionMs;
  if (pos <= 0) {
    return '未开始';
  }
  const total = entry.durationMs > 0 ? entry.durationMs : 0;
  if (total <= 0) {
    return `已看 ${formatClock(pos)}`;
  }
  const pct = Math.min(100, Math.round((pos / total) * 100));
  return `已看 ${formatClock(pos)} / ${formatClock(total)} · ${pct}%`;
}

export function formatClock(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = m < 10 ? `0${m}` : `${m}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}
