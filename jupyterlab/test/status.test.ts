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
    item.setPull(41.6);
    expect(item.text).toBe('Pulling 42%');

    item.setPull(undefined);
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
