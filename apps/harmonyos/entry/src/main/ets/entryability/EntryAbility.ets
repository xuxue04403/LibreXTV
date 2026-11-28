import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { appModel } from '../model/AppModel';

const DOMAIN = 0x0000;
const TAG = 'LibreXTV';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 先把持久化数据与内置源清单准备好，再加载界面：
    // 否则首页会先闪一下空列表，然后才补上内容。
    const context = this.context;
    appModel.start(context).then(() => {
      hilog.info(DOMAIN, TAG, 'app model ready: %{public}d sources', appModel.data.sources.length);
      this.loadUi(windowStage);
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'app model init failed: %{public}s', err.message);
      this.loadUi(windowStage);
    });
  }

  private loadUi(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent ok');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
    // 退到后台/窗口销毁时把防抖窗口里的最后一次变更写掉：
    // saveSoon 有 400ms 防抖，用户在这 400ms 内划掉应用会丢最后一次改动
    // （播放进度、刚点的收藏/设置项都在里面）。
    appModel.flushStore();
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
    appModel.flushStore();
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
    appModel.flushStore();
  }
}
