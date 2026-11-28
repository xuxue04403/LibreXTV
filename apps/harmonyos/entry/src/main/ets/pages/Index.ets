/**
 * 应用外壳：底部四个标签 + 详情/播放器全屏覆盖。
 *
 * 鸿蒙没有 Compose 的 remember 快照，页面状态放在各 Page 组件的 @State 里，
 * 全局状态靠 AppStorage 的 vmVersion 触发重绘（AppModel.bump 里自增）。
 */
import { appModel } from '../model/AppModel';
import { PageId } from '../model/Types';
import { Palette } from '../view/Common';
import { HomePage } from './HomePage';
import { SearchPage } from './SearchPage';
import { LivePage } from './LivePage';
import { SettingsPage } from './SettingsPage';
import { DetailPage } from './DetailPage';
import { PlayerPage } from './PlayerPage';
import { LivePlayerPage } from './LivePlayerPage';

@Entry
@Component
struct Index {
  /**
   * 每次 `bump()` 都会变，用 @Watch 接住它来驱动 Toast。
   *
   * 原实现把 `watchToast()` 挂在根 Stack 的 `onAreaChange` 上：根节点恒定
   * 100%×100%，尺寸永不变化，这个回调基本不会触发 —— 所有 toast 都不会出现。
   */
  @StorageLink('vmVersion') @Watch('onVersionChange') vmVersion: number = 0;
  @State private toast: string = '';
  private toastTimer: number = -1;

  onVersionChange(): void {
    this.watchToast();
  }

  aboutToAppear(): void {
    // 首次进入触发一次默认源合并（EntryAbility 里已经 start 过，这里只是兜底）
    if (appModel.data.sources.length === 0) {
      appModel.bump();
    }
    this.watchToast();
  }

  aboutToDisappear(): void {
    if (this.toastTimer >= 0) {
      clearTimeout(this.toastTimer);
    }
  }

  private watchToast(): void {
    const next = appModel.toast;
    if (next.length === 0 || next === this.toast) {
      return;
    }
    this.toast = next;
    if (this.toastTimer >= 0) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toast = '';
      appModel.clearToast();
    }, 2600) as number;
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        // 内容区
        Stack() {
          if (appModel.page === PageId.Player) {
            PlayerPage()
          } else if (appModel.page === PageId.LivePlayer) {
            LivePlayerPage()
          } else if (appModel.page === PageId.Detail) {
            DetailPage()
          } else {
            Column() {
              Stack() {
                if (appModel.page === PageId.Home) {
                  HomePage()
                } else if (appModel.page === PageId.Search) {
                  SearchPage()
                } else if (appModel.page === PageId.Live) {
                  LivePage()
                } else {
                  SettingsPage()
                }
              }
              .layoutWeight(1)

              this.bottomNav()
            }
            .width('100%')
            .height('100%')
          }
        }
        .width('100%')
        .height('100%')
      }
      .width('100%')
      .height('100%')

      // Toast
      if (this.toast.length > 0) {
        Text(this.toast)
          .fontSize(12)
          .fontColor(Palette.TextPrimary)
          .backgroundColor('#F213171F')
          .borderRadius(10)
          .border({ width: 1, color: Palette.Line })
          .padding({ left: 16, right: 16, top: 10, bottom: 10 })
          .margin({ bottom: 96 })
          .transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: 12 })))
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Palette.Bg)
  }

  @Builder
  bottomNav() {
    Row() {
      this.navItem('首页', PageId.Home)
      this.navItem('搜索', PageId.Search)
      this.navItem('直播', PageId.Live)
      this.navItem('设置', PageId.Settings)
    }
    .width('100%')
    .height(58)
    .padding({ left: 8, right: 8, bottom: 6 })
    .backgroundColor(Palette.Panel)
    .border({ width: { top: 1 }, color: Palette.Line })
    .justifyContent(FlexAlign.SpaceEvenly)
  }

  @Builder
  navItem(label: string, page: PageId) {
    Column({ space: 2 }) {
      Text(label === '首页' ? '⌂' : label === '搜索' ? '⌕' : label === '直播' ? '▶' : '⚙')
        .fontSize(18)
        .fontColor(appModel.page === page ? Palette.Accent : Palette.TextMuted)
      Text(label)
        .fontSize(10)
        .fontColor(appModel.page === page ? Palette.Accent : Palette.TextMuted)
    }
    .layoutWeight(1)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .borderRadius(10)
    .backgroundColor(appModel.page === page ? Palette.AccentSoft : Color.Transparent)
    .onClick(() => {
      appModel.go(page);
    })
  }
}
