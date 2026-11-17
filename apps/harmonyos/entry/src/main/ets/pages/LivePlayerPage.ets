/**
 * 直播播放页：整页复用一个 AVPlayer，切台只换 url。
 *
 * 直播流不需要进度条，也不需要续播记录；要防的是"15 秒还没出画面"
 * 这种死台，所以有看门狗超时提示。
 */
import { media } from '@kit.MediaKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { appModel } from '../model/AppModel';
import { LiveChannel } from '../model/Types';
import { Palette, PillButton } from '../view/Common';

const LIVE_START_TIMEOUT_MS = 15_000;

@Component
export struct LivePlayerPage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  @State private channelName: string = '';
  @State private channelUrl: string = '';
  @State private groupName: string = '';
  @State private index: number = 0;
  @State private total: number = 0;
  @State private errorText: string = '';
  @State private buffering: boolean = true;
  @State private showList: boolean = false;
  @State private favorite: boolean = false;

  private player: media.AVPlayer | null = null;
  private surfaceId: string = '';
  private controller: XComponentController = new XComponentController();
  private watchdog: number = -1;
  private playlist: LiveChannel[] = [];

  aboutToAppear(): void {
    const target = appModel.liveTarget;
    this.playlist = appModel.livePlaylist;
    if (target === null) {
      this.errorText = '没有要播放的频道';
      return;
    }
    this.channelName = target.name;
    this.channelUrl = target.url;
    this.groupName = target.group ?? '未分组';
    this.favorite = appModel.isLiveFavorite(target.url);
    this.index = indexOf(this.playlist, target.url);
    this.total = this.playlist.length;
    this.open();
  }

  aboutToDisappear(): void {
    this.stopWatchdog();
    this.release();
  }

  private stopWatchdog(): void {
    if (this.watchdog >= 0) {
      clearTimeout(this.watchdog);
      this.watchdog = -1;
    }
  }

  private async release(): Promise<void> {
    const p = this.player;
    this.player = null;
    if (p !== null) {
      try {
        p.off('stateChange');
        p.off('error');
        await p.release();
      } catch (err) {
        // 忽略
      }
    }
  }

  private async open(): Promise<void> {
    this.errorText = '';
    this.buffering = true;
    await this.release();
    try {
      const p = await media.createAVPlayer();
      this.player = p;
      p.on('error', (err: BusinessError) => {
        this.buffering = false;
        this.errorText = `这个频道打不开：${err.message}`;
        this.stopWatchdog();
      });
      p.on('stateChange', (state: string) => {
        const player = this.player;
        if (player === null) {
          return;
        }
        if (state === 'initialized') {
          if (this.surfaceId.length > 0) {
            player.surfaceId = this.surfaceId;
          }
          player.prepare();
        } else if (state === 'prepared') {
          this.buffering = false;
          this.stopWatchdog();
          player.play();
        } else if (state === 'playing') {
          this.buffering = false;
          this.errorText = '';
        }
      });
      p.url = this.channelUrl;
      // 看门狗：15 秒还没出画面就提示
      this.stopWatchdog();
      this.watchdog = setTimeout(() => {
        const player = this.player;
        if (player !== null && player.state !== 'playing') {
          this.errorText = '这个频道 15 秒内没有出画面，可能已下线或被地区限制';
          this.buffering = false;
        }
      }, LIVE_START_TIMEOUT_MS) as number;
    } catch (err) {
      this.buffering = false;
      this.errorText = `播放器初始化失败：${(err as BusinessError).message}`;
    }
  }

  private switchTo(direction: number): void {
    if (this.playlist.length === 0) {
      return;
    }
    const next = (this.index + direction + this.playlist.length) % this.playlist.length;
    const ch = this.playlist[next];
    this.index = next;
    this.channelName = ch.name;
    this.channelUrl = ch.url;
    this.groupName = ch.group ?? '未分组';
    this.favorite = appModel.isLiveFavorite(ch.url);
    // 切台后必须同步 `liveTarget`：收藏按钮读的是它，不同步就会「收藏上一台」。
    appModel.liveTarget = ch;
    this.errorText = '';
    this.open();
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      XComponent({
        id: 'librextv_live',
        type: XComponentType.SURFACE,
        controller: this.controller,
      })
        .onLoad(() => {
          this.surfaceId = this.controller.getXComponentSurfaceId();
          const p = this.player;
          if (p !== null && p.state === 'initialized') {
            p.surfaceId = this.surfaceId;
            p.prepare();
          }
        })
        .width('100%')
        .height('100%')

      if (this.buffering && this.errorText.length === 0) {
        Column() {
          LoadingProgress()
            .width(44)
            .height(44)
            .color(Palette.Accent)
          Text('正在连接频道…')
            .fontSize(12)
            .fontColor(Palette.TextMuted)
            .margin({ top: 8 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }

      // 顶部条
      Row({ space: 8 }) {
        Text('‹')
          .fontSize(22)
          .fontColor('#FFFFFF')
          .onClick(() => {
            appModel.back();
          })
        Column({ space: 1 }) {
          Row({ space: 6 }) {
            Text('LIVE')
              .fontSize(9)
              .fontColor('#FFFFFF')
              .backgroundColor(Palette.ErrRed)
              .borderRadius(3)
              .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            Text(this.channelName)
              .fontSize(13)
              .fontColor('#FFFFFF')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          Text(`${this.groupName}${this.total > 0 ? `  ·  ${this.index + 1} / ${this.total}` : ''}`)
            .fontSize(10)
            .fontColor('#CCDDDDDD')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .linearGradient({
        angle: 180,
        colors: [['#CC000000', 0.0], ['#00000000', 1.0]],
      })

      // 错误面板
      if (this.errorText.length > 0) {
        Column({ space: 10 }) {
          Text(this.errorText)
            .fontSize(13)
            .fontColor(Palette.TextPrimary)
            .textAlign(TextAlign.Center)
          Row({ space: 8 }) {
            PillButton({ text: '重试', primary: true, onTap: () => {
              this.open();
            } })
            PillButton({ text: '下一个频道', onTap: () => {
              this.switchTo(1);
            } })
            PillButton({ text: '返回', onTap: () => {
              appModel.back();
            } })
          }
        }
        .width('100%')
        .height('100%')
        .padding(24)
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#E60A0C10')
      }

      // 底部操作
      if (this.errorText.length === 0) {
        Row({ space: 10 }) {
          PillButton({ text: '‹ 上一台', onTap: () => {
            this.switchTo(-1);
          } })
          PillButton({ text: '下一台 ›', onTap: () => {
            this.switchTo(1);
          } })
          Blank()
          PillButton({ text: '频道', onTap: () => {
            this.showList = !this.showList;
          } })
          PillButton({ text: this.favorite ? '★ 已收藏' : '☆ 收藏', onTap: () => {
            // 以当前正在播的这台为准，不要读可能过期的 liveTarget
            const target = this.playlist[this.index] ?? appModel.liveTarget;
            if (target !== null && target !== undefined) {
              appModel.toggleLiveFavorite(target);
              this.favorite = appModel.isLiveFavorite(target.url);
            }
          } })
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 10, bottom: 16 })
        .linearGradient({
          angle: 0,
          colors: [['#CC000000', 0.0], ['#00000000', 1.0]],
        })
        .position({ x: 0, y: '100%' })
        .translate({ y: '-100%' })
      }

      // 频道列表
      if (this.showList) {
        Column({ space: 8 }) {
          Row() {
            Text(`频道（${this.playlist.length}）`)
              .fontSize(13)
              .fontColor(Palette.TextPrimary)
            Blank()
            Text('收起')
              .fontSize(12)
              .fontColor(Palette.Accent)
              .onClick(() => {
                this.showList = false;
              })
          }
          .width('100%')

          List({ space: 6 }) {
            ForEach(this.playlist, (ch: LiveChannel, i: number) => {
              ListItem() {
                Row({ space: 8 }) {
                  Text(ch.name)
                    .fontSize(12)
                    .fontColor(i === this.index ? '#FFC4B0' : Palette.TextPrimary)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  Text(ch.group ?? '未分组')
                    .fontSize(10)
                    .fontColor(Palette.TextMuted)
                }
                .width('100%')
                .padding({ left: 10, right: 10, top: 8, bottom: 8 })
                .backgroundColor(i === this.index ? Palette.AccentSoft : Palette.Panel)
                .borderRadius(6)
                .onClick(() => {
                  this.index = i;
                  this.channelName = ch.name;
                  this.channelUrl = ch.url;
                  this.groupName = ch.group ?? '未分组';
                  this.showList = false;
                  this.open();
                })
              }
            }, (ch: LiveChannel, i: number) => `${ch.sourceKey}:${ch.url}:${i}`)
          }
          .layoutWeight(1)
          .scrollBar(BarState.Off)
        }
        .width('100%')
        .height('55%')
        .padding(14)
        .backgroundColor('#F213171F')
        .borderRadius({ topLeft: 14, topRight: 14 })
        .position({ x: 0, y: '100%' })
        .translate({ y: '-100%' })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.Black)
  }
}

function indexOf(list: LiveChannel[], url: string): number {
  for (let i = 0; i < list.length; i++) {
    if (list[i].url === url) {
      return i;
    }
  }
  return 0;
}
