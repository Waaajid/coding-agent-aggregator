import { describe, expect, it } from 'vitest';
import { StreamFormatter, stageIndex } from './format';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('StreamFormatter', () => {
  it('turns Claude stream-json into readable lines, even when chunks split mid-line', () => {
    const f = new StreamFormatter();
    const lines = [
      JSON.stringify({ type: 'system', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } }),
      JSON.stringify({ type: 'result', is_error: false }),
    ].join('\n') + '\n';
    const mid = Math.floor(lines.length / 2);
    const out = plain(f.push(lines.slice(0, mid)) + f.push(lines.slice(mid)));
    expect(out).toContain('session s1 started');
    expect(out).toContain('Working on it');
    expect(out).toContain('▸ Bash npm test');
    expect(out).toContain('✓ finished');
    expect(out).not.toContain('noise');
    expect(out).not.toContain('{');
  });

  it('passes PTY / plain output through untouched and keeps non-JSON lines in JSON mode', () => {
    const raw = new StreamFormatter();
    expect(raw.push('\x1b[33mAllow? (y/n)\x1b[0m ')).toBe('\x1b[33mAllow? (y/n)\x1b[0m ');
    expect(raw.push('{"looks":"like json but mode is raw"}')).toBe('{"looks":"like json but mode is raw"}');

    const json = new StreamFormatter();
    expect(plain(json.push('{"type":"result","is_error":true,"result":"boom"}\nplain stderr line\n'))).toBe('✗ boom\r\nplain stderr line\r\n');
  });
});

describe('stageIndex', () => {
  it('maps task states to pipeline position and attention level', () => {
    expect(stageIndex({ status: 'running', verifyCommand: null })).toEqual({ index: 1, state: 'active' });
    expect(stageIndex({ status: 'waiting_approval', verifyCommand: null })).toEqual({ index: 1, state: 'attention' });
    expect(stageIndex({ status: 'completed', verifyCommand: null })).toEqual({ index: 3, state: 'attention' });
    expect(stageIndex({ status: 'failed', verifyCommand: null }).state).toBe('bad');
  });
});
