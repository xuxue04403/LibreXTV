import { useCallback, useEffect, useState } from 'react';
import { castToDlna, discoverDlnaDevices, type DlnaDeviceInfo } from '../lib/bridge';
import { Icon } from './Icons';

/** 投屏面板：搜索局域网内的 DLNA 渲染设备并把当前集推过去 */
export function CastDialog({
  url,
  title,
  onClose,
  onCast,
}: {
  url: string;
  title: string;
  onClose: () => void;
  onCast: (deviceName: string) => void;
}) {
  const [devices, setDevices] = useState<DlnaDeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDevices(null);
    setError(null);
    const result = await discoverDlnaDevices();
    setDevices(result.devices);
    if (result.error) setError(result.error);
    if (!result.error && result.devices.length === 0) {
      setError('没有发现可投屏的设备：请确认电视与电脑在同一局域网，且电视已开启投屏/镜像功能');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cast = async (device: DlnaDeviceInfo) => {
    setBusy(device.controlUrl);
    // 必须兜住异常：castToDlna 走的是 IPC，主进程侧抛错（设备拒绝连接、控制地址
    // 不在局域网内…）会让 invoke 直接 reject。没有 try/catch 的话 setBusy(null)
    // 永远执行不到，按钮就一直卡在「推送中…」，用户只能关掉对话框重来。
    try {
      const result = await castToDlna(device, url, title);
      if (result.ok) {
        onCast(device.name);
        onClose();
      } else {
        setError(result.error ?? '投屏失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '投屏失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overlay" onClick={onClose} style={{ zIndex: 80 }}>
      <div className="detail" style={{ width: 'min(600px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>投屏到电视</div>
            <div style={{ color: '#8d97a8', fontSize: 12 }}>
              {title} · 通过 DLNA 推送到局域网设备
            </div>
          </div>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => void refresh()} disabled={devices === null}>
            <Icon name="refresh" size={15} />
            重新搜索
          </button>
          <button className="ctrl" onClick={onClose} title="关闭">
            <Icon name="x" />
          </button>
        </div>

        {devices === null ? (
          <div className="empty" style={{ padding: 28, marginTop: 10 }}>
            <div className="spinner" style={{ margin: '0 auto 10px' }} />
            正在搜索局域网内的投屏设备…
          </div>
        ) : devices.length === 0 ? (
          <div className="empty" style={{ padding: 24, marginTop: 10 }}>
            <div style={{ color: '#ffc9ca', marginBottom: 6 }}>{error ?? '没有发现设备'}</div>
            <div style={{ fontSize: 12 }}>
              常见原因：电视未开启 DLNA/投屏接收、电脑与电视不在同一网段、防火墙拦截了 SSDP 组播。
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {devices.map((device) => (
              <button
                key={device.controlUrl}
                className="list-item"
                style={{ width: '100%', cursor: 'pointer', textAlign: 'left' }}
                onClick={() => void cast(device)}
                disabled={busy === device.controlUrl}
              >
                <span className="chip on" style={{ width: 40, height: 40, justifyContent: 'center' }}>
                  TV
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{device.name}</div>
                  <div className="url">{new URL(device.location).host}</div>
                </div>
                <span className="chip">{busy === device.controlUrl ? '推送中…' : '投屏'}</span>
              </button>
            ))}
            {error ? (
              <div style={{ color: '#f0b429', fontSize: 12, marginTop: 10 }}>{error}</div>
            ) : null}
          </div>
        )}

        <div style={{ color: '#8d97a8', fontSize: 11.5, marginTop: 14, lineHeight: 1.7 }}>
          投屏期间本机可以继续操作，电视会独立拉流播放；若电视端显示失败，多为片源限制了多设备访问，可在本机直接观看。
        </div>
      </div>
    </div>
  );
}
