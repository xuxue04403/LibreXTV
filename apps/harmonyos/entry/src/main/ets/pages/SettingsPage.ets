/**
 * 设置页：源管理、订阅导入、播放开关、本地数据。
 *
 * 与 Android 端设置页功能对齐，但按手机竖屏重排：
 * 每一项做成一行，点开才展开输入区，避免一进门就是一屏输入框。
 */
import { promptAction } from '@kit.ArkUI';
import { appModel } from '../model/AppModel';
import { LiveSource, PageId, VodSource } from '../model/Types';
import { Palette, PillButton, SectionTitle, HintLine } from '../view/Common';

@Component
export struct SettingsPage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  @State private vodName: string = '';
  @State private vodUrl: string = '';
  @State private vodDetail: string = '';
  @State private vodError: string = '';
  @State private showAddVod: boolean = false;
  @State private liveName: string = '';
  @State private liveUrl: string = '';
  @State private liveNote: string = '';
  @State private liveError: string = '';
  @State private showAddLive: boolean = false;
  @State private subUrl: string = '';
  @State private confirmText: string = '';
  // ArkTS 不允许用 @State 装函数，这里把「要做什么」记成动作名 + 参数，确认时再分派。
  @State private confirmKind: string = '';
  @State private confirmArg: string = '';

  private runConfirm(): void {
    if (this.confirmKind === 'clearHistory') {
      appModel.clearHistory();
      appModel.show('已清空观看历史');
    } else if (this.confirmKind === 'removeVod') {
      appModel.removeSource(this.confirmArg);
      appModel.show('已删除');
    } else if (this.confirmKind === 'removeLive') {
      appModel.removeLiveSource(this.confirmArg);
      appModel.show('已删除');
    }
    this.confirmText = '';
    this.confirmKind = '';
    this.confirmArg = '';
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
    Column() {
      Row({ space: 8 }) {
        Text('设置')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(Palette.TextPrimary)
        Blank()
        Text(`清单 v${appModel.data.defaultsVersion}`)
          .fontSize(11)
          .fontColor(Palette.TextMuted)
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 14, bottom: 4 })

      Scroll() {
        Column() {
          // ---- 点播源 ----
          SectionTitle({ title: '点播源', hint: `${appModel.activeSources().length}/${appModel.data.sources.length} 启用` })
          Column({ space: 6 }) {
            ForEach(appModel.data.sources, (source: VodSource) => {
              this.sourceRow(source)
            }, (source: VodSource) => source.key)
          }
          .width('100%')

          if (this.showAddVod) {
            this.addVodPanel()
          } else {
            Row() {
              PillButton({ text: '+ 添加点播源', onTap: () => {
                this.showAddVod = true;
              } })
            }
            .width('100%')
            .padding({ top: 8 })
          }

          // ---- 直播源 ----
          SectionTitle({ title: '直播源', hint: `${appModel.activeLiveSources().length}/${appModel.data.liveSources.length} 启用` })
          Column({ space: 6 }) {
            ForEach(appModel.data.liveSources, (source: LiveSource) => {
              this.liveRow(source)
            }, (source: LiveSource) => source.key)
          }
          .width('100%')

          if (this.showAddLive) {
            this.addLivePanel()
          } else {
            Row({ space: 8 }) {
              PillButton({ text: '+ 添加直播源', onTap: () => {
                this.showAddLive = true;
              } })
            }
            .width('100%')
            .padding({ top: 8 })
          }

          // ---- 订阅导入 ----
          SectionTitle({ title: '订阅导入', hint: '拉取一份 m3u 清单并保存' })
          Column({ space: 8 }) {
            TextInput({ text: this.subUrl, placeholder: 'https://example.com/live.m3u' })
              .height(40)
              .fontSize(12)
              .fontColor(Palette.TextPrimary)
              .placeholderColor(Palette.TextMuted)
              .backgroundColor(Palette.Bg)
              .borderRadius(8)
              .border({ width: 1, color: Palette.Line })
              .onChange((value: string) => {
                this.subUrl = value;
              })
            Row({ space: 8 }) {
              PillButton({
                text: appModel.importing ? '导入中…' : '导入',
                primary: true,
                disabled: appModel.importing,
                onTap: () => {
                  appModel.importSubscription(this.subUrl);
                  this.subUrl = '';
                },
              })
            }
          }
          .width('100%')
          .padding(12)
          .backgroundColor(Palette.Panel)
          .borderRadius(10)

          // ---- 播放设置 ----
          SectionTitle({ title: '播放设置' })
          Column({ space: 2 }) {
            this.toggleRow('成人内容过滤', '从搜索结果里剔除明显是成人内容的条目', appModel.data.settings.adultFilter, () => {
              appModel.updateSettings((s) => {
                s.adultFilter = !s.adultFilter;
                return s;
              });
            })
            this.toggleRow('自动连播下一集', '一集播完自动接着下一集', appModel.data.settings.autoplayNext, () => {
              appModel.updateSettings((s) => {
                s.autoplayNext = !s.autoplayNext;
                return s;
              });
            })
            this.toggleRow('记住播放进度', '下次打开同一部片子从上次的位置继续', appModel.data.settings.resumePlayback, () => {
              appModel.updateSettings((s) => {
                s.resumePlayback = !s.resumePlayback;
                return s;
              });
            })
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 4, bottom: 4 })
          .backgroundColor(Palette.Panel)
          .borderRadius(10)

          // ---- 本地数据 ----
          SectionTitle({ title: '本地数据' })
          Column({ space: 8 }) {
            HintLine({ text: `观看记录 ${appModel.data.history.length} 条 · 收藏 ${appModel.data.favorites.length} 部 · 直播收藏 ${appModel.data.liveFavorites.length} 个` })
            Row({ space: 8 }) {
              PillButton({
                text: `清空观看历史（${appModel.data.history.length}）`,
                disabled: appModel.data.history.length === 0,
                onTap: () => {
                  this.confirmKind = 'clearHistory';
                  this.confirmArg = '';
                  this.confirmText = '确定清空全部观看历史？这个操作不可撤销。';
                },
              })
            }
          }
          .width('100%')
          .padding(12)
          .backgroundColor(Palette.Panel)
          .borderRadius(10)
          .alignItems(HorizontalAlign.Start)

          // ---- 关于 ----
          SectionTitle({ title: '关于' })
          Column({ space: 6 }) {
            HintLine({ text: 'LibreXTV 鸿蒙手机版 1.3.11' })
            HintLine({ text: '内置源均为第三方公开接口，与本项目无隶属关系，仅作开箱即用的示例。' })
            HintLine({ text: '本应用不存储、不转存任何视频内容，所有播放地址来自第三方采集接口。' })
            HintLine({ text: 'AGPL-3.0 许可 · 源码见 github.com/xuxue04403/LibreXTV' })
          }
          .width('100%')
          .padding(12)
          .backgroundColor(Palette.Panel)
          .borderRadius(10)
          .alignItems(HorizontalAlign.Start)

          Blank().height(30)
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

      if (this.confirmText.length > 0) {
        Column({ space: 14 }) {
          Text(this.confirmText)
            .fontSize(13)
            .fontColor(Palette.TextPrimary)
            .textAlign(TextAlign.Center)
          Row({ space: 10 }) {
            PillButton({ text: '取消', onTap: () => {
              this.confirmText = '';
              this.confirmKind = '';
              this.confirmArg = '';
            } })
            PillButton({ text: '确认', primary: true, onTap: () => {
              this.runConfirm();
            } })
          }
        }
        .width('84%')
        .padding(18)
        .backgroundColor(Palette.Panel)
        .borderRadius(14)
        .border({ width: 1, color: Palette.Line })
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  sourceRow(source: VodSource) {
    Row({ space: 8 }) {
      Column({ space: 2 }) {
        Row({ space: 6 }) {
          Text(source.name)
            .fontSize(13)
            .fontColor(Palette.TextPrimary)
          if (source.builtin) {
            Text('内置')
              .fontSize(9)
              .fontColor(Palette.TextMuted)
              .padding({ left: 5, right: 5, top: 1, bottom: 1 })
              .backgroundColor(Palette.Bg)
              .borderRadius(4)
          }
        }
        Text(source.url)
          .fontSize(10)
          .fontColor(Palette.TextMuted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text(appModel.data.selected.indexOf(source.key) >= 0 ? '已启用' : '已停用')
        .fontSize(10)
        .fontColor(appModel.data.selected.indexOf(source.key) >= 0 ? Palette.OkGreen : Palette.TextMuted)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .backgroundColor(Palette.Bg)
        .borderRadius(999)
        .onClick(() => {
          appModel.toggleSource(source.key);
        })

      Text('删除')
        .fontSize(10)
        .fontColor(Palette.ErrRed)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .onClick(() => {
          this.confirmKind = 'removeVod';
          this.confirmArg = source.key;
          this.confirmText = `删除点播源「${source.name}」？该源的观看历史与收藏也会一并清除。`;
        })
    }
    .width('100%')
    .padding({ left: 10, right: 6, top: 8, bottom: 8 })
    .backgroundColor(Palette.Panel)
    .borderRadius(8)
  }

  @Builder
  liveRow(source: LiveSource) {
    Row({ space: 8 }) {
      Column({ space: 2 }) {
        Row({ space: 6 }) {
          Text(source.name)
            .fontSize(13)
            .fontColor(Palette.TextPrimary)
          if (source.builtin) {
            Text('内置')
              .fontSize(9)
              .fontColor(Palette.TextMuted)
              .padding({ left: 5, right: 5, top: 1, bottom: 1 })
              .backgroundColor(Palette.Bg)
              .borderRadius(4)
          }
        }
        Text(source.url)
          .fontSize(10)
          .fontColor(Palette.TextMuted)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (source.note !== undefined && source.note.length > 0) {
          Text(source.note)
            .fontSize(9)
            .fontColor('#6E7889')
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text(appModel.data.liveSelected.indexOf(source.key) >= 0 ? '已启用' : '已停用')
        .fontSize(10)
        .fontColor(appModel.data.liveSelected.indexOf(source.key) >= 0 ? Palette.OkGreen : Palette.TextMuted)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .backgroundColor(Palette.Bg)
        .borderRadius(999)
        .onClick(() => {
          appModel.toggleLiveSource(source.key);
        })

      Text('删除')
        .fontSize(10)
        .fontColor(Palette.ErrRed)
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .onClick(() => {
          this.confirmKind = 'removeLive';
          this.confirmArg = source.key;
          this.confirmText = `删除直播源「${source.name}」？`;
        })
    }
    .width('100%')
    .padding({ left: 10, right: 6, top: 8, bottom: 8 })
    .backgroundColor(Palette.Panel)
    .borderRadius(8)
  }

  @Builder
  addVodPanel() {
    Column({ space: 8 }) {
      TextInput({ text: this.vodName, placeholder: '名称，如「某某资源」' })
        .height(38)
        .fontSize(12)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Bg)
        .borderRadius(8)
        .border({ width: 1, color: Palette.Line })
        .onChange((value: string) => {
          this.vodName = value;
        })
      TextInput({ text: this.vodUrl, placeholder: '接口地址，如 https://example.com/api.php/provide/vod' })
        .height(38)
        .fontSize(12)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Bg)
        .borderRadius(8)
        .border({ width: 1, color: Palette.Line })
        .onChange((value: string) => {
          this.vodUrl = value;
        })
      TextInput({ text: this.vodDetail, placeholder: '详情页根地址（可选）' })
        .height(38)
        .fontSize(12)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Bg)
        .borderRadius(8)
        .border({ width: 1, color: Palette.Line })
        .onChange((value: string) => {
          this.vodDetail = value;
        })
      if (this.vodError.length > 0) {
        Text(this.vodError)
          .width('100%')
          .fontSize(11)
          .fontColor(Palette.ErrRed)
      }
      Row({ space: 8 }) {
        PillButton({ text: '添加', primary: true, onTap: () => {
          const err = appModel.addSource(this.vodName, this.vodUrl, this.vodDetail);
          this.vodError = err;
          if (err.length === 0) {
            this.vodName = '';
            this.vodUrl = '';
            this.vodDetail = '';
            this.showAddVod = false;
            appModel.show('已添加点播源');
          }
        } })
        PillButton({ text: '取消', onTap: () => {
          this.showAddVod = false;
          this.vodError = '';
        } })
      }
    }
    .width('100%')
    .padding(12)
    .margin({ top: 8 })
    .backgroundColor(Palette.Panel)
    .borderRadius(10)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  addLivePanel() {
    Column({ space: 8 }) {
      TextInput({ text: this.liveName, placeholder: '名称' })
        .height(38)
        .fontSize(12)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Bg)
        .borderRadius(8)
        .border({ width: 1, color: Palette.Line })
        .onChange((value: string) => {
          this.liveName = value;
        })
      TextInput({ text: this.liveUrl, placeholder: 'm3u 地址' })
        .height(38)
        .fontSize(12)
        .fontColor(Palette.TextPrimary)
        .placeholderColor(Palette.TextMuted)
        .backgroundColor(Palette.Bg)
        .borderRadius(8)
        .border({ width: 1, color: Palette.Line })
        .onChange((value: string) => {
          this.liveUrl = value;
        })
      if (this.liveError.length > 0) {
        Text(this.liveError)
          .width('100%')
          .fontSize(11)
          .fontColor(Palette.ErrRed)
      }
      Row({ space: 8 }) {
        PillButton({ text: '添加', primary: true, onTap: () => {
          const err = appModel.addLiveSource(this.liveName, this.liveUrl, this.liveNote);
          this.liveError = err;
          if (err.length === 0) {
            this.liveName = '';
            this.liveUrl = '';
            this.liveNote = '';
            this.showAddLive = false;
            appModel.show('已添加直播源');
          }
        } })
        PillButton({ text: '取消', onTap: () => {
          this.showAddLive = false;
          this.liveError = '';
        } })
      }
    }
    .width('100%')
    .padding(12)
    .margin({ top: 8 })
    .backgroundColor(Palette.Panel)
    .borderRadius(10)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  toggleRow(title: string, subtitle: string, checked: boolean, onToggle: () => void) {
    Row({ space: 10 }) {
      Column({ space: 2 }) {
        Text(title)
          .fontSize(13)
          .fontColor(Palette.TextPrimary)
        Text(subtitle)
          .fontSize(10)
          .fontColor(Palette.TextMuted)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Toggle({ type: ToggleType.Switch, isOn: checked })
        .selectedColor(Palette.Accent)
        .onChange(() => {
          onToggle();
        })
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
  }
}
