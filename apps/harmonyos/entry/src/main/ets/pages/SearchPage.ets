/**
 * 搜索页：输入 + 边搜边出结果的聚合列表。
 *
 * 交互与 TV 版一致：多源并行搜，每个源结算后立刻刷新结果，
 * 结果按片名聚合成一组（同名不同源可以换源播放）。
 */
import { promptAction } from '@kit.ArkUI';
import { appModel } from '../model/AppModel';
import { PageId, SearchGroup, SearchItem } from '../model/Types';
import { Palette, Poster, TagChip, EmptyBox, HintLine } from '../view/Common';

@Component
export struct SearchPage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  @State private keyword: string = '';
  @State private inputError: string = '';

  private submit(): void {
    const wd = this.keyword.trim();
    if (wd.length === 0) {
      this.inputError = '请输入要搜索的片名';
      return;
    }
    this.inputError = '';
    appModel.startSearch(wd);
  }

  private openGroup(group: SearchGroup): void {
    if (group.items.length === 0) {
      return;
    }
    appModel.openDetail(group.items[0], group.items);
  }

  private suggestions(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const cur = appModel.search.keyword.trim();
    if (cur.length > 0) {
      // 当前关键词要先进 seen：否则历史里如果有同一部片，
      // 会再 push 一次，渲染列表就出现两个一样的 key。
      out.push(cur);
      seen.add(cur);
    }
    for (let i = 0; i < appModel.data.history.length && out.length < 9; i++) {
      const t = appModel.data.history[i].title;
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }

  build() {
    Column() {
      // 搜索框
      Row({ space: 8 }) {
        TextInput({ text: this.keyword, placeholder: '片名、剧名或演员名' })
          .layoutWeight(1)
          .height(42)
          .fontSize(14)
          .fontColor(Palette.TextPrimary)
          .placeholderColor(Palette.TextMuted)
          .backgroundColor(Palette.Panel)
          .borderRadius(10)
          .border({ width: 1, color: Palette.Line })
          .enterKeyType(EnterKeyType.Search)
          .onChange((value: string) => {
            this.keyword = value;
          })
          .onSubmit(() => {
            this.submit();
          })
        Text('搜索')
          .fontSize(14)
          .fontColor('#1A0D07')
          .backgroundColor(Palette.Accent)
          .borderRadius(10)
          .padding({ left: 18, right: 18, top: 11, bottom: 11 })
          .onClick(() => {
            this.submit();
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 6 })

      if (this.inputError.length > 0) {
        Text(this.inputError)
          .width('100%')
          .padding({ left: 16, right: 16 })
          .fontSize(11)
          .fontColor(Palette.ErrRed)
      }

      // 建议词
      if (!appModel.search.searched) {
        Scroll() {
          Column() {
            Text(appModel.data.history.length > 0 ? '最近搜过 / 看过的片子' : '热门推荐')
              .width('100%')
              .padding({ top: 12, bottom: 8 })
              .fontSize(13)
              .fontColor(Palette.TextMuted)
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.suggestions(), (word: string) => {
                Row() {
                  TagChip({ text: word, onTap: () => {
                    this.keyword = word;
                    appModel.startSearch(word);
                  } })
                }
                .margin({ right: 8, bottom: 8 })
              }, (word: string) => word)
            }
            .width('100%')
            if (this.suggestions().length === 0) {
              Column() {
                EmptyBox({
                  title: '搜点什么吧',
                  description: '支持片名、剧名、演员名',
                })
              }
              .width('100%')
              .margin({ top: 20 })
            }
          }
          .padding({ left: 16, right: 16 })
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .align(Alignment.Top)
        .scrollBar(BarState.Off)
      } else {
        // 状态行
        Row() {
          Text(statusText())
            .fontSize(12)
            .fontColor(Palette.TextMuted)
          Blank()
          if (appModel.search.loading) {
            LoadingProgress()
              .width(18)
              .height(18)
              .color(Palette.Accent)
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 6 })

        // 各源结算情况
        if (appModel.search.statuses.length > 0) {
          Scroll() {
            Row({ space: 6 }) {
              ForEach(statusViews(), (st: SearchStatusView) => {
                Text(st.text)
                  .fontSize(10)
                  .fontColor(st.ok ? Palette.TextMuted : Palette.ErrRed)
                  .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .backgroundColor(Palette.Panel)
                  .borderRadius(999)
                  .border({ width: 1, color: Palette.Line })
              }, (st: SearchStatusView) => st.key)
            }
            .padding({ left: 16, right: 16 })
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .height(30)
        }

        if (appModel.search.groups.length === 0) {
          Column() {
            if (appModel.search.loading) {
              LoadingProgress()
                .width(40)
                .height(40)
                .color(Palette.Accent)
                .margin({ top: 40 })
              Text('正在并发搜索各源…')
                .fontSize(12)
                .fontColor(Palette.TextMuted)
                .margin({ top: 10 })
            } else {
              Column() {
                EmptyBox({
                  title: '没有找到相关内容',
                  description: '换个关键词试试。有些源本身没有这部片子，可以到设置里多启用几个源。',
                })
              }
              .width('100%')
              .margin({ top: 24 })
            }
          }
          .width('100%')
          .layoutWeight(1)
        } else {
          Grid() {
            ForEach(appModel.search.groups, (group: SearchGroup) => {
              GridItem() {
                Column({ space: 5 }) {
                  Stack({ alignContent: Alignment.TopEnd }) {
                    Poster({ title: group.name, url: group.items.length > 0 ? (group.items[0].pic ?? '') : '' })
                    Text(`${group.items.length} 源`)
                      .fontSize(9)
                      .fontColor('#FFFFFF')
                      .backgroundColor('#CC000000')
                      .borderRadius(4)
                      .padding({ left: 5, right: 5, top: 2, bottom: 2 })
                      .margin(5)
                  }
                  .width('100%')

                  Text(group.name)
                    .width('100%')
                    .fontSize(12)
                    .fontColor(Palette.TextPrimary)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(subtitleOf(group))
                    .width('100%')
                    .fontSize(10)
                    .fontColor(Palette.TextMuted)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .onClick(() => {
                  this.openGroup(group);
                })
              }
            }, (group: SearchGroup) => group.name)
          }
          .columnsTemplate('1fr 1fr')
          .columnsGap(12)
          .rowsGap(14)
          .padding({ left: 16, right: 16, bottom: 20 })
          .layoutWeight(1)
          .scrollBar(BarState.Off)
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Palette.Bg)
  }
}

/** 状态条的视图模型（ArkTS 里 ForEach 的 key 用纯数据更稳） */
interface SearchStatusView {
  key: string;
  text: string;
  ok: boolean;
}

/**
 * 把各源结算结果转成状态条视图模型。
 *
 * 不能直接拿 `SearchStatus` 当 `SearchStatusView` 用：后者是本地定义的
 * 视图模型（`key`/`text`/`ok`），而 `SearchStatus` 只有 `sourceKey`/`sourceName`/
 * `count`/`error`/`ms` —— 直接传会让 `st.text`、`st.key` 全是 undefined，
 * 状态条渲染成空白且 ForEach 拿不到唯一 key。
 */
function statusViews(): SearchStatusView[] {
  const out: SearchStatusView[] = [];
  const list = appModel.search.statuses;
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    const text = st.ok ? `${st.sourceName} · ${st.count} 条 · ${st.ms}ms`
      : `${st.sourceName} · ${st.error !== undefined && st.error.length > 0 ? st.error : '失败'}`;
    out.push({ key: `${st.sourceKey}_${i}`, text: text, ok: st.ok });
  }
  return out;
}

function statusText(): string {
  const st = appModel.search;
  const total = appModel.activeSources().length;
  if (st.loading) {
    return `搜索中… ${st.statuses.length}/${total} 个源`;
  }
  if (st.groups.length > 0) {
    return `${st.groups.length} 部影片 · ${st.statuses.length} 个源已结算`;
  }
  return `已搜索 ${st.statuses.length}/${total} 个源`;
}

function subtitleOf(group: SearchGroup): string {
  if (group.items.length === 0) {
    return '';
  }
  const first = group.items[0];
  const parts: string[] = [];
  if (first.year !== undefined && first.year.length > 0) {
    parts.push(first.year);
  }
  if (first.remarks !== undefined && first.remarks.length > 0) {
    parts.push(first.remarks);
  }
  if (parts.length === 0 && first.typeName !== undefined) {
    parts.push(first.typeName);
  }
  return parts.join(' · ');
}
