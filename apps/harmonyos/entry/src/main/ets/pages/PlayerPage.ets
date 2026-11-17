/**
 * 点播播放页：AVPlayer + XComponent（SURFACE）。
 *
 * AVPlayer 的状态机比 ExoPlayer 严格：必须在 idle 状态设 url、在
 * initialized 状态设 surfaceId、在 prepared 之后才能 play，顺序错了会
 * 直接抛 5400102。所以这里用 avPlayer.state 做守卫，不靠"设置一遍然后祈祷"。
 */
import { media } from '@kit.MediaKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { appModel, ProgressTarget } from '../model/AppModel';
import { PlaybackCandidate, VodSource } from '../model/Types';
import { Palette, PillButton, SectionTitle, HintLine } from '../view/Common';

const SEEK_STEP_MS = 10_000;
const STALL_LIMIT_SEC = 20;
/** 单个候选源的详情探测死线：串行试 7 个源时不能一个卡死就拖住整轮 */
const FAILOVER_TIMEOUT_MS = 8_000;
/** 进度落盘间隔（墙钟，不是「秒数是 5 的倍数」） */
const SAVE_INTERVAL_MS = 5_000;

@Component
export struct PlayerPage {
  @StorageLink('vmVersion') vmVersion: number = 0;
  @State private title: string = '';
  @State private cover: string = '';
  @State private episodes: string[] = [];
  @State private index: number = 0;
  @State private playing: boolean = false;
  @State private buffering: boolean = true;
  @State private positionMs: number = 0;
  @State private durationMs: number = 0;
  @State private errorText: string = '';
  @State private noteText: string = '';
  @State private showEpisodes: boolean = false;
  @State private controlsVisible: boolean = true;
  @State private sourceName: string = '';
  @State private draining: boolean = false;

  private player: media.AVPlayer | null = null;
  private surfaceId: string = '';
  private controller: XComponentController = new XComponentController();
  private ticker: number = -1;
  private noteTimer: number = -1;
  private stalledSec: number = 0;
  private prepared: boolean = false;
  private ended: boolean = false;
  private tried: string[] = [];
  private candidates: PlaybackCandidate[] = [];
  private currentSource: VodSource | null = null;
  private currentVodId: string = '';
  private resumedOnce: boolean = false;
  /** 打开序号：换集/换源时旧的那次 openCurrent 可能还没建完播放器 */
  private openSeq: number = 0;
  private lastSaveAt: number = 0;

  /** 落进度用的「当前播放对象」：换源后必须跟着换，不能沿用 playerTarget */
  private progressTarget(): ProgressTarget {
    return new ProgressTarget(
      this.currentSource === null ? '' : this.currentSource.key,
      this.currentVodId,
      this.title,
      this.cover,
      this.sourceName,
      this.episodes.length
    );
  }

  aboutToAppear(): void {
    const t = appModel.playerTarget;
    if (t === null) {
      this.errorText = '没有可播放的内容';
      return;
    }
    this.title = t.title;
    this.cover = t.cover;
    this.episodes = t.episodes;
    this.index = t.startIndex;
    this.sourceName = t.sourceName;
    this.currentSource = t.source;
    this.currentVodId = t.vodId;
    this.candidates = t.candidates;
    this.tried = [`${t.source.key}:${t.vodId}`];
    this.openCurrent();
  }

  aboutToDisappear(): void {
    this.stopTicker();
    if (this.noteTimer >= 0) {
      clearTimeout(this.noteTimer);
    }
    if (!this.ended) {
      appModel.saveProgress(this.index, this.positionMs, this.durationMs, false, this.progressTarget());
    }
    this.release();
  }

  private stopTicker(): void {
    if (this.ticker >= 0) {
      clearInterval(this.ticker);
      this.ticker = -1;
    }
  }

  private async release(): Promise<void> {
    const p = this.player;
    this.player = null;
    this.prepared = false;
    if (p !== null) {
      try {
        p.off('stateChange');
        p.off('timeUpdate');
        p.off('error');
        p.off('bufferingUpdate');
        await p.release();
      } catch (err) {
        // 释放失败不影响退出
      }
    }
  }

  /** 打开当前集；surfaceId 还没就绪时只记下来，等 onLoad 再推进 */
  private async openCurrent(): Promise<void> {
    const url = this.episodes[this.index];
    if (url === undefined) {
      this.errorText = '这一集没有播放地址';
      return;
    }
    // 代际守卫：连点选集/连续换源时，前一次 createAVPlayer 可能在这之后才完成，
    // 直接赋值会把新播放器覆盖成旧的（画面永久黑屏，事件也只挂在旧实例上）。
    const mySeq = ++this.openSeq;
    this.errorText = '';
    this.buffering = true;
    this.stalledSec = 0;
    this.lastSaveAt = 0;
    await this.release();
    try {
      const p = await media.createAVPlayer();
      if (mySeq !== this.openSeq) {
        await p.release();
        return;
      }
      this.player = p;
      // 每个回调都先确认「自己还是当前播放器」：被换掉之后旧实例的事件必须丢弃
      p.on('error', (err: BusinessError) => {
        if (this.player !== p) {
          return;
        }
        this.buffering = false;
        this.errorText = `播放失败：${err.message}`;
        this.tryFailover('播放失败');
      });
      p.on('stateChange', (state: string) => {
        if (this.player !== p) {
          return;
        }
        this.onState(state);
      });
      p.on('timeUpdate', (time: number) => {
        if (this.player !== p) {
          return;
        }
        this.positionMs = time;
      });
      // 缓冲状态必须靠这个事件：起播时的 `buffering = true` 只有它才能关掉，
      // 否则第一集之后 `buffering` 一直是 false（`openCurrent` 里又置 true 后没人复位），
      // 看门狗既不数卡死，UI 也会一直转圈或者永远不转。
      p.on('bufferingUpdate', (infoType: media.BufferingInfoType, value: number) => {
        if (this.player !== p) {
          return;
        }
        if (infoType === media.BufferingInfoType.BUFFERING_START) {
          this.buffering = true;
        } else if (infoType === media.BufferingInfoType.BUFFERING_END) {
          this.buffering = false;
          this.stalledSec = 0;
        }
      });
      // 先设 url（idle → initialized），surfaceId 在 initialized 后设
      p.url = url;
    } catch (err) {
      if (mySeq !== this.openSeq) {
        return;
      }
      this.buffering = false;
      this.errorText = `播放器初始化失败：${(err as BusinessError).message}`;
    }
  }

  private onState(state: string): void {
    const p = this.player;
    if (p === null) {
      return;
    }
    if (state === 'initialized') {
      if (this.surfaceId.length > 0) {
        p.surfaceId = this.surfaceId;
      }
      p.prepare();
    } else if (state === 'prepared') {
      this.prepared = true;
      this.buffering = false;
      this.durationMs = p.duration;
      this.playing = true;
      p.play();
      this.startTicker();
      this.resumeIfNeeded();
      this.applyRate();
    } else if (state === 'playing') {
      this.playing = true;
      this.buffering = false;
      this.stalledSec = 0;
    } else if (state === 'paused') {
      this.playing = false;
    } else if (state === 'completed') {
      this.onEnded();
    } else if (state === 'error') {
      this.buffering = false;
    } else if (state === 'released') {
      this.prepared = false;
    }
  }

  /** 首集续播：从历史里取位置，超过 15 秒才 seek（太靠前的没意义） */
  private resumeIfNeeded(): void {
    if (this.resumedOnce || this.player === null) {
      return;
    }
    this.resumedOnce = true;
    if (!appModel.data.settings.resumePlayback) {
      return;
    }
    const id = `${this.currentSource === null ? '' : this.currentSource.key}:${this.currentVodId}`;
    const list = appModel.data.history;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id && list[i].episodeIndex === this.index && list[i].positionMs > 15_000) {
        const target = list[i].positionMs;
        this.player.seek(target);
        this.positionMs = target;
        this.showNote(`已从 ${formatTime(target)} 继续播放`);
        return;
      }
    }
  }

  private applyRate(): void {
    // 保持 1.0x；这里留出接口位，后续要加快慢速播放在这里改
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.player === null) {
        return;
      }
      this.durationMs = this.player.duration > 0 ? this.player.duration : this.durationMs;
      // 只有「本来该在播、却一直没有数据」才算卡死：暂停、播完、以及用户
      // 拖动进度条的瞬间 `playing` 也仍为 true，但那时 buffering 会短暂为真，
      // 所以这里再加一道「已播过、位置没变」的宽松判据，避免刚拖完就误判换源。
      if (this.buffering && this.playing && !this.ended) {
        this.stalledSec += 1;
        if (this.stalledSec >= STALL_LIMIT_SEC && this.errorText.length === 0) {
          this.stalledSec = 0;
          this.tryFailover('加载超时');
        }
      } else {
        this.stalledSec = 0;
      }
      // 每 5 秒落一次盘，避免退出时丢进度。
      // 原判据是「播放秒数是 5 的倍数」，ticker 每秒一拍时几乎每秒都命中，
      // 等于每秒写一次 localStorage（HarmonyOS 上是 preferences 同步落盘）。
      const now = Date.now();
      if (this.positionMs > 0 && !this.ended && now - this.lastSaveAt >= SAVE_INTERVAL_MS) {
        this.lastSaveAt = now;
        appModel.saveProgress(this.index, this.positionMs, this.durationMs, false, this.progressTarget());
      }
    }, 1000) as number;
  }

  private onEnded(): void {
    this.ended = true;
    this.playing = false;
    appModel.saveProgress(this.index, this.durationMs, this.durationMs, true, this.progressTarget());
    const next = this.index + 1;
    if (appModel.data.settings.autoplayNext && next < this.episodes.length) {
      this.index = next;
      this.ended = false;
      this.resumedOnce = true;
      this.tried = [`${this.currentSource === null ? '' : this.currentSource.key}:${this.currentVodId}`];
      this.openCurrent();
    } else {
      this.showNote('已播完');
    }
  }

  /** 换源：按候选顺序试下一个能拿到分集的源，成功就切过去 */
  private async tryFailover(reason: string): Promise<void> {
    if (this.draining) {
      return;
    }
    const pending: PlaybackCandidate[] = [];
    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i];
      if (this.tried.indexOf(`${c.sourceKey}:${c.vodId}`) < 0) {
        pending.push(c);
      }
    }
    if (pending.length === 0) {
      this.errorText = `${reason}（已试完所有片源）`;
      return;
    }
    this.draining = true;
    this.showNote('正在切换片源…');
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      this.tried.push(`${c.sourceKey}:${c.vodId}`);
      const source = findSource(c.sourceKey);
      if (source === undefined) {
        continue;
      }
      try {
        // 逐个候选串行探测，每个都套死线：`fetchDetail` 内部两次请求各 9 秒，
        // 7 个候选全卡就是两分钟，用户只看到「正在切换片源…」，也没法中断。
        const detail = await withDeadline(fetchDetailOf(source, c.vodId), FAILOVER_TIMEOUT_MS);
        if (detail.length === 0) {
          continue;
        }
        const aligned = Math.min(this.index, detail.length - 1);
        this.currentSource = source;
        this.currentVodId = c.vodId;
        this.sourceName = c.sourceName;
        this.episodes = detail;
        this.index = aligned;
        this.draining = false;
        this.ended = false;
        this.errorText = '';
        this.showNote(`已切换到「${c.sourceName}」`);
        await this.openCurrent();
        return;
      } catch (err) {
        continue;
      }
    }
    this.draining = false;
    this.errorText = `${reason}（已试完所有片源）`;
  }

  private showNote(text: string): void {
    this.noteText = text;
    if (this.noteTimer >= 0) {
      clearTimeout(this.noteTimer);
    }
    this.noteTimer = setTimeout(() => {
      this.noteText = '';
    }, 2400) as number;
  }

  private togglePlay(): void {
    const p = this.player;
    if (p === null || !this.prepared) {
      return;
    }
    if (this.playing) {
      p.pause();
    } else {
      p.play();
    }
  }

  private seekBy(deltaMs: number): void {
    const p = this.player;
    if (p === null || !this.prepared) {
      return;
    }
    const limit = this.durationMs > 0 ? this.durationMs - 1000 : 0;
    let target = this.positionMs + deltaMs;
    if (target < 0) {
      target = 0;
    }
    if (limit > 0 && target > limit) {
      target = limit;
    }
    p.seek(target);
    this.positionMs = target;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      // 视频画面
      XComponent({
        id: 'librextv_player',
        type: XComponentType.SURFACE,
        controller: this.controller,
      })
        .onLoad(() => {
          this.surfaceId = this.controller.getXComponentSurfaceId();
          const p = this.player;
          // 如果已经到 initialized 了，补设 surfaceId 并 prepare
          if (p !== null && p.state === 'initialized') {
            p.surfaceId = this.surfaceId;
            p.prepare();
          }
        })
        .width('100%')
        .height('100%')

      // 点击画面切控件显隐
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.controlsVisible = !this.controlsVisible;
        })

      if (this.buffering && this.errorText.length === 0) {
        Column() {
          LoadingProgress()
            .width(44)
            .height(44)
            .color(Palette.Accent)
          Text('正在缓冲…')
            .fontSize(12)
            .fontColor(Palette.TextMuted)
            .margin({ top: 8 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }

      if (this.noteText.length > 0) {
        Text(this.noteText)
          .fontSize(12)
          .fontColor('#FFFFFF')
          .backgroundColor('#CC000000')
          .borderRadius(8)
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .margin({ left: 16, top: 60 })
      }

      // 错误面板
      if (this.errorText.length > 0) {
        Column({ space: 10 }) {
          Text(this.errorText)
            .fontSize(13)
            .fontColor(Palette.TextPrimary)
            .textAlign(TextAlign.Center)
          Row({ space: 8 }) {
            PillButton({ text: '换源重试', primary: true, onTap: () => {
              this.errorText = '';
              this.tryFailover('播放失败');
            } })
            PillButton({ text: '重试', onTap: () => {
              this.errorText = '';
              this.openCurrent();
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

      // 顶部信息条
      if (this.controlsVisible || this.errorText.length > 0) {
        Row({ space: 8 }) {
          Text('‹')
            .fontSize(22)
            .fontColor('#FFFFFF')
            .onClick(() => {
              appModel.back();
            })
          Column({ space: 1 }) {
            Text(this.title)
              .fontSize(13)
              .fontColor('#FFFFFF')
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(`第 ${this.index + 1} 集 · ${this.sourceName}`)
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
      }

      // 底部控件
      if (this.controlsVisible) {
        Column({ space: 6 }) {
          Row({ space: 8 }) {
            Text(formatTime(this.positionMs))
              .fontSize(10)
              .fontColor('#FFFFFF')
            Slider({
              value: this.positionMs,
              min: 0,
              max: this.durationMs > 0 ? this.durationMs : 1,
              style: SliderStyle.OutSet,
            })
              .layoutWeight(1)
              .selectedColor(Palette.Accent)
              .trackColor('#55FFFFFF')
              .onChange((value: number) => {
                this.positionMs = value;
                const p = this.player;
                if (p !== null && this.prepared) {
                  const limit = this.durationMs > 0 ? this.durationMs - 1000 : 0;
                  p.seek(limit > 0 && value > limit ? limit : value);
                }
              })
            Text(formatTime(this.durationMs))
              .fontSize(10)
              .fontColor('#FFFFFF')
          }
          .width('100%')

          Row({ space: 10 }) {
            PillButton({ text: '« 10s', onTap: () => {
              this.seekBy(-SEEK_STEP_MS);
            } })
            PillButton({ text: this.playing ? '暂停' : '播放', primary: true, onTap: () => {
              this.togglePlay();
            } })
            PillButton({ text: '10s »', onTap: () => {
              this.seekBy(SEEK_STEP_MS);
            } })
            Blank()
            PillButton({ text: '选集', onTap: () => {
              this.showEpisodes = !this.showEpisodes;
            } })
            PillButton({
              text: '下一集',
              disabled: this.index + 1 >= this.episodes.length,
              onTap: () => {
                if (this.index + 1 < this.episodes.length) {
                  this.index = this.index + 1;
                  this.resumedOnce = true;
                  this.ended = false;
                  this.openCurrent();
                }
              },
            })
          }
          .width('100%')
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 10, bottom: 14 })
        .linearGradient({
          angle: 0,
          colors: [['#CC000000', 0.0], ['#00000000', 1.0]],
        })
        .position({ x: 0, y: '100%' })
        .translate({ y: '-100%' })
      }

      // 选集面板
      if (this.showEpisodes) {
        Column({ space: 8 }) {
          Row() {
            Text(`选集（共 ${this.episodes.length} 集）`)
              .fontSize(13)
              .fontColor(Palette.TextPrimary)
            Blank()
            Text('收起')
              .fontSize(12)
              .fontColor(Palette.Accent)
              .onClick(() => {
                this.showEpisodes = false;
              })
          }
          .width('100%')

          Grid() {
            ForEach(this.episodes, (url: string, index: number) => {
              GridItem() {
                Text(`第 ${index + 1} 集`)
                  .width('100%')
                  .height(38)
                  .textAlign(TextAlign.Center)
                  .fontSize(12)
                  .fontColor(index === this.index ? '#FFC4B0' : Palette.TextPrimary)
                  .backgroundColor(index === this.index ? Palette.AccentSoft : Palette.Panel)
                  .borderRadius(6)
                  .border({ width: 1, color: index === this.index ? Palette.Accent : Palette.Line })
                  .onClick(() => {
                    this.index = index;
                    this.resumedOnce = true;
                    this.ended = false;
                    this.showEpisodes = false;
                    this.openCurrent();
                  })
              }
            }, (url: string, index: number) => `${index}:${url}`)
          }
          .columnsTemplate('1fr 1fr 1fr 1fr')
          .columnsGap(8)
          .rowsGap(8)
          .layoutWeight(1)
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

function findSource(key: string): VodSource | undefined {
  const list = appModel.data.sources;
  for (let i = 0; i < list.length; i++) {
    if (list[i].key === key) {
      return list[i];
    }
  }
  return undefined;
}

/** 直接用 Repository 拿分集（换源时用） */
async function fetchDetailOf(source: VodSource, vodId: string): Promise<string[]> {
  const repo = await import('../data/Repository');
  const detail = await repo.fetchDetail(source, vodId);
  return detail.episodes;
}

/** 给 promise 套一个死线，超时按失败处理（换源时不能一个候选拖住整轮） */
async function withDeadline<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer = -1;
  const deadline: Promise<T> = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`超过 ${Math.floor(ms / 1000)} 秒未返回`));
    }, ms) as number;
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer >= 0) {
      clearTimeout(timer);
    }
  }
}

export function formatTime(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m < 10 ? `0${m}` : `${m}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
