/**
 * TVBox 式字母键盘。
 *
 * 布局（与用户给的参照一致）：
 * ```
 * ┌──────────────┐
 * │  输入框       │
 * │  ⌫  ⌧  🔍   │
 * │  A B C D E F │
 * │  G H I J K L │
 * │  ...          │
 * │  0-9          │
 * └──────────────┘
 * ```
 *
 * 为什么不用系统输入法：TV 遥控器上用软键盘找片名极其难受（一个汉字要按十几次方向键），
 * 而「首字母 + 建议列表」把「输入」压缩到 1~4 次按键。桌面端也保留它，因为
 * 拼音检索本来就比中文输入快。
 */
import { Icon } from './Icons';

/** 键盘行：每行 6 个字母，字母表顺序（与 TVBox 一致，遥控器上下左右移动定位最自然） */
const LETTER_ROWS: string[][] = [
  ['a', 'b', 'c', 'd', 'e', 'f'],
  ['g', 'h', 'i', 'j', 'k', 'l'],
  ['m', 'n', 'o', 'p', 'q', 'r'],
  ['s', 't', 'u', 'v', 'w', 'x'],
  ['y', 'z'],
];
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function LetterKeyboard({
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClose?: () => void;
}) {
  const append = (ch: string) => onChange(value + ch);
  const backspace = () => onChange(value.slice(0, -1));
  const clear = () => onChange('');

  return (
    <div className="kbd">
      <div className="kbd-display">
        <input
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="拼音首字母，如 dldl"
          spellCheck={false}
          autoFocus
        />
      </div>

      <div className="kbd-actions">
        <button type="button" className="kbd-btn wide" onClick={backspace} title="退格">
          <Icon name="left" size={16} />
          退格
        </button>
        <button type="button" className="kbd-btn wide" onClick={clear} title="清除">
          <Icon name="x" size={16} />
          清除
        </button>
        <button
          type="button"
          className="kbd-btn wide primary"
          onClick={onSubmit}
          disabled={value.trim().length === 0}
        >
          <Icon name="search" size={16} />
          搜索
        </button>
      </div>

      {LETTER_ROWS.map((row, i) => (
        <div className="kbd-row" key={i}>
          {row.map((ch) => (
            <button type="button" key={ch} className="kbd-btn" onClick={() => append(ch)}>
              {ch.toUpperCase()}
            </button>
          ))}
        </div>
      ))}

      <div className="kbd-row">
        {DIGITS.map((ch) => (
          <button type="button" key={ch} className="kbd-btn narrow" onClick={() => append(ch)}>
            {ch}
          </button>
        ))}
      </div>

      {onClose ? (
        <button type="button" className="kbd-btn wide" onClick={onClose}>
          收起键盘
        </button>
      ) : null}
    </div>
  );
}
