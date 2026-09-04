import { WorkbenchError } from './errors.js';

export interface CheckboxChoice<T> {
  value: T;
  label: string;
  checked?: boolean;
}

function render<T>(message: string, choices: CheckboxChoice<T>[], cursor: number, selected: Set<T>): string[] {
  return [
    message,
    '  ↑/↓ 移动  空格切换  Enter确认  q取消',
    ...choices.map((choice, index) => {
      const marker = selected.has(choice.value) ? '◉' : '◯';
      const pointer = index === cursor ? '❯' : ' ';
      return `${pointer} ${marker} ${choice.label}`;
    })
  ];
}

export async function checkbox<T>(message: string, choices: CheckboxChoice<T>[]): Promise<T[]> {
  if (choices.length === 0) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return choices.filter((choice) => choice.checked).map((choice) => choice.value);
  }

  const input = process.stdin;
  const output = process.stdout;
  const selected = new Set(choices.filter((choice) => choice.checked).map((choice) => choice.value));
  let cursor = 0;
  const wasRaw = input.isRaw;

  const draw = (): void => {
    const lines = render(message, choices, cursor, selected);
    // Restore to the prompt origin and clear everything below it. This is
    // robust when a long choice wraps across terminal lines.
    output.write('\x1b8\x1b[J');
    output.write(`${lines.join('\n')}\n`);
  };

  return await new Promise<T[]>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.pause();
      input.setRawMode?.(wasRaw ?? false);
      output.write('\x1b8\x1b[J\x1b[?25h\n');
    };

    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve(choices.filter((choice) => selected.has(choice.value)).map((choice) => choice.value));
    };

    const onData = (chunk: Buffer | string): void => {
      const key = chunk.toString();
      if (key === '\u0003' || key === '\u001b' || key.toLowerCase() === 'q') {
        finish(new WorkbenchError('已取消选择。', 'SELECTION_CANCELLED', 1));
        return;
      }
      if (key === '\u001b[A' || key.toLowerCase() === 'k') {
        cursor = (cursor - 1 + choices.length) % choices.length;
      } else if (key === '\u001b[B' || key.toLowerCase() === 'j') {
        cursor = (cursor + 1) % choices.length;
      } else if (key === ' ') {
        const value = choices[cursor]!.value;
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
      } else if (key.toLowerCase() === 'a') {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((choice) => selected.add(choice.value));
      } else if (key === '\r' || key === '\n') {
        finish();
        return;
      } else {
        return;
      }
      draw();
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.write('\x1b[?25l\x1b7');
    draw();
  });
}
