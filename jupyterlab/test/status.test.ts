import { StatusItem } from '../src/status';

describe('StatusItem', () => {
  it('mirrors the VS Code status texts, most important first', () => {
    const item = new StatusItem();
    expect(item.text).toBe('LocalPilot'); // connecting
    item.setConnectionState('ready');
    expect(item.text).toBe('LocalPilot');
    expect(item.node.textContent).toBe('LocalPilot');

    item.setChatActive(true);
    expect(item.text).toBe('completions paused during chat');
    item.setCompletionsEnabled(false);
    expect(item.text).toBe('completions paused');
    item.setStatus({ ollama: 'modelMissing', detail: 'model qwen not pulled' });
    expect(item.text).toBe('Model missing');
    expect(item.tooltip).toContain('model qwen not pulled');
    item.setStatus({ ollama: 'down', detail: 'connection refused' });
    expect(item.text).toBe('Ollama down');
    expect(item.node.title).toContain('connection refused');
    item.setConnectionState('crashed', 'core binary not found');
    expect(item.text).toBe('LocalPilot stopped');
    expect(item.tooltip).toContain('core binary not found');

    item.setConnectionState('ready');
    item.setStatus({ ollama: 'ok', detail: '' });
    item.setCompletionsEnabled(true);
    item.setChatActive(false);
    expect(item.text).toBe('LocalPilot');
    item.dispose();
  });

  it('runs the click handler', () => {
    const item = new StatusItem();
    const onClick = jest.fn();
    item.setOnClick(onClick);
    item.node.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    item.dispose();
  });
});

describe('StatusItem connection errors and tooltips', () => {
  it('shows the unreachable state with its reason', () => {
    const item = new StatusItem();
    item.setConnectionState('error', 'LocalPilot server extension not reachable: 5 connection attempts failed');
    expect(item.text).toBe('LocalPilot unreachable');
    expect(item.tooltip).toContain('5 connection attempts failed');
    expect(item.tooltip).toContain('jupyter server extension list');
    expect(item.hasClass('jp-LocalPilotStatus-error')).toBe(true);
    item.setConnectionState('ready');
    expect(item.text).toBe('LocalPilot');
    expect(item.hasClass('jp-LocalPilotStatus-error')).toBe(false);
    item.dispose();
  });

  it('every tooltip says a click opens the command menu, never that it acts by itself', () => {
    const item = new StatusItem();
    const tooltips: string[] = [];
    const seen = () => tooltips.push(item.tooltip);
    seen();
    item.setConnectionState('ready');
    seen();
    item.setChatActive(true);
    seen();
    item.setCompletionsEnabled(false);
    seen();
    item.setStatus({ ollama: 'modelMissing', detail: 'model qwen not pulled' });
    seen();
    item.setStatus({ ollama: 'down', detail: 'connection refused' });
    seen();
    item.setConnectionState('crashed', 'boom');
    seen();
    item.setConnectionState('error', 'unreachable');
    seen();
    for (const t of tooltips) {
      expect(t).not.toMatch(/Click to /);
      if (t.includes('Click')) expect(t).toContain('Click for LocalPilot commands');
    }
    item.dispose();
  });
});
