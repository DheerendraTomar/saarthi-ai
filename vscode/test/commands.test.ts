import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessions,
  deleteSession,
  resetLearning,
  selectModel,
  showCompletionStats,
  type CommandDeps,
} from "../src/commands";
import { ModelCatalog } from "../src/models";
import { readSettings } from "../src/settings";
import { FakeChatClient } from "./helpers/webview";
import { configValues, registry, resetMock, window, workspaceConfigKeys } from "./mocks/vscode";

const MODELS = [
  { name: "qwen2.5-coder:1.5b-base", sizeBytes: 986_000_000, family: "qwen2", supportsInsert: true, supportsTools: false },
  { name: "llama3.2:3b", sizeBytes: 2_000_000_000, family: "llama", supportsInsert: false, supportsTools: true },
];

interface Pick {
  items: Array<{ label: string; description?: string; detail?: string; picked?: boolean }>;
  options: { placeHolder?: string; title?: string } | undefined;
}

let picks: Pick[];
/** Makes the next quick pick choose the item whose label contains `text` (undefined = dismiss). */
function answerPicks(...choices: Array<string | undefined>): void {
  window.showQuickPick = (async (items: Pick["items"], options: Pick["options"]) => {
    const list = await items;
    picks.push({ items: list, options });
    const want = choices.shift();
    return want === undefined ? undefined : list.find((i) => i.label.includes(want));
  }) as typeof window.showQuickPick;
}

function makeDeps(client: FakeChatClient) {
  const calls = { deleted: [] as string[], cleared: 0, startOllama: 0, pulls: 0, refreshed: 0 };
  const deps = {
    client,
    models: new ModelCatalog(client),
    settings: () => readSettings(),
    chatView: {
      newSession: async () => {},
      deleteSession: async (id: string) => void calls.deleted.push(id),
      clearSessions: async () => {
        calls.cleared += 1;
        return { deleted: ["s1", "s2"], skipped: [] };
      },
      postModels: async () => void (calls.refreshed += 1),
    },
    startOllama: () => void (calls.startOllama += 1),
    pullModel: () => void (calls.pulls += 1),
  } as unknown as CommandDeps;
  return { deps, calls };
}

beforeEach(() => {
  resetMock();
  picks = [];
});

describe("model pickers", () => {
  it("select_model_quick_pick_writes_setting", async () => {
    const client = new FakeChatClient((m) => (m === "ollama/models" ? { models: MODELS } : {}));
    const { deps, calls } = makeDeps(client);
    configValues["localpilot.completionModel"] = "qwen2.5-coder:1.5b-base";

    // Completion picker: every installed model, sizes + FIM hint, the current one marked.
    answerPicks("llama3.2:3b");
    await selectModel(deps, "completion");
    expect(client.of("ollama/models")).toEqual([{}]);
    expect(picks[0].options?.placeHolder).toMatch(/completion model/i);
    expect(picks[0].items.map((i) => [i.label, i.description, i.detail])).toEqual([
      ["$(check) qwen2.5-coder:1.5b-base", "986 MB · qwen2", "fill-in-the-middle"],
      ["llama3.2:3b", "2.0 GB · llama", "$(warning) no fill-in-the-middle: inline completions will be poor"],
    ]);
    // Written to the scope that defines it (none yet → user settings) + a warning for a non-FIM model.
    expect(registry.configUpdates).toEqual([{ key: "localpilot.completionModel", value: "llama3.2:3b", target: 1 }]);
    expect(calls.refreshed).toBe(1); // an open chat view gets a fresh models/list
    expect(registry.messages.filter((m) => m.level === "warn").map((m) => m.message)).toEqual([
      expect.stringMatching(/llama3\.2:3b does not support fill-in-the-middle/),
    ]);

    // Chat picker: tool hint; a workspace-defined value is written to the workspace.
    workspaceConfigKeys.add("localpilot.chatModel");
    configValues["localpilot.chatModel"] = "llama3.2:3b";
    answerPicks("qwen2.5-coder:1.5b-base");
    await selectModel(deps, "chat");
    expect(picks[1].items.map((i) => [i.label, i.detail])).toEqual([
      ["qwen2.5-coder:1.5b-base", "$(warning) no tool calling: the agent cannot edit files or run commands"],
      ["$(check) llama3.2:3b", "tool calling"],
    ]);
    expect(registry.configUpdates[1]).toEqual({ key: "localpilot.chatModel", value: "qwen2.5-coder:1.5b-base", target: 2 });

    // Picking the current model or dismissing writes nothing.
    answerPicks(undefined);
    await selectModel(deps, "chat");
    answerPicks("qwen2.5-coder:1.5b-base");
    await selectModel(deps, "chat");
    expect(registry.configUpdates).toHaveLength(2);
  });

  it("select_model_with_ollama_down_shows_state", async () => {
    let down = true;
    const client = new FakeChatClient((m) => {
      if (m !== "ollama/models") return {};
      if (down) throw Object.assign(new Error("cannot reach Ollama at http://localhost:11434"), { code: -32000 });
      return { models: MODELS };
    });
    const { deps, calls } = makeDeps(client);

    // Nothing known yet: an explicit down state with Start Ollama / Retry — never an empty picker.
    answerPicks("Start Ollama");
    await selectModel(deps, "chat");
    expect(picks[0].options?.placeHolder).toMatch(/Ollama is not reachable/);
    expect(picks[0].items.map((i) => i.label)).toEqual(["$(play) Start Ollama", "$(refresh) Retry"]);
    expect(calls.startOllama).toBe(1);
    expect(registry.configUpdates).toEqual([]);

    // Retry after Ollama came back: the real list.
    answerPicks("Retry", undefined);
    const pick = window.showQuickPick;
    window.showQuickPick = (async (items: unknown, options: unknown) => {
      const r = await pick(items, options);
      down = false; // Ollama is up by the time the user clicks Retry
      return r;
    }) as typeof window.showQuickPick;
    await selectModel(deps, "chat");
    expect(picks[1].items.map((i) => i.label)).toEqual(["$(play) Start Ollama", "$(refresh) Retry"]);
    expect(picks[2].items.map((i) => i.label)).toEqual(["qwen2.5-coder:1.5b-base", "llama3.2:3b"]);
    expect(client.of("ollama/models")).toHaveLength(3);

    // Down again: the last known list, labelled as such, still selectable.
    down = true;
    answerPicks("llama3.2:3b");
    await selectModel(deps, "chat");
    expect(picks[3].options?.placeHolder).toBe("Ollama down — last known list (cannot reach Ollama at http://localhost:11434)");
    expect(picks[3].items.map((i) => i.label)).toEqual(["$(play) Start Ollama", "$(refresh) Retry", "qwen2.5-coder:1.5b-base", "llama3.2:3b"]);
    expect(registry.configUpdates).toEqual([{ key: "localpilot.chatModel", value: "llama3.2:3b", target: 1 }]);
  });
});

describe("model picker with nothing installed", () => {
  it("offers_pull_model_when_ollama_has_no_models", async () => {
    const client = new FakeChatClient((m) => (m === "ollama/models" ? { models: [] } : {}));
    const { deps, calls } = makeDeps(client);
    answerPicks("Pull model");
    await selectModel(deps, "completion");
    expect(picks[0].options?.placeHolder).toBe("No models are installed in Ollama. Pull one first.");
    expect(picks[0].items.map((i) => i.label)).toEqual(["$(cloud-download) Pull model"]);
    expect(calls.pulls).toBe(1);
  });
});

describe("session and learning commands", () => {
  it("delete_and_clear_sessions_go_through_the_chat_view", async () => {
    const client = new FakeChatClient((m) =>
      m === "chat/listSessions"
        ? { sessions: [{ sessionId: "s2", title: "Latest", updatedAtMs: 2 }, { sessionId: "s1", title: "Older", updatedAtMs: 1 }] }
        : {},
    );
    const { deps, calls } = makeDeps(client);
    answerPicks("Older");
    await deleteSession(deps);
    expect(picks[0].items.map((i) => i.label)).toEqual(["Latest", "Older"]);
    expect(calls.deleted).toEqual(["s1"]);

    // Clear all asks first; dismissing does nothing.
    await clearSessions(deps);
    expect(calls.cleared).toBe(0);
    registry.warningAnswers.push("Delete All");
    await clearSessions(deps);
    expect(calls.cleared).toBe(1);
    expect(registry.messages.at(-1)).toEqual({ level: "info", message: "LocalPilot: deleted 2 chat sessions." });
  });

  it("reset_learning_confirms_and_stats_are_shown", async () => {
    const stats = {
      languages: {
        python: { served: 10, accepted: 4, partial: 1, rejected: 4, typedThrough: 1, acceptRate: 0.5, learnedMaxLines: 4, learnedNumPredict: 48, learned: true, examples: 2 },
      },
      logPath: "/w/.localpilot/completions.jsonl",
      adaptive: true,
    };
    const client = new FakeChatClient((m) => (m === "completion/stats" ? stats : {}));
    const { deps } = makeDeps(client);
    await resetLearning(deps);
    expect(client.of("completion/resetLearning")).toEqual([]);
    registry.warningAnswers.push("Reset");
    await resetLearning(deps);
    expect(client.of("completion/resetLearning")).toEqual([{}]);

    answerPicks("Open the completion log");
    await showCompletionStats(deps);
    expect(picks[0].options?.title).toBe("LocalPilot completion stats — adaptive on");
    expect(picks[0].items.map((i) => [i.label, i.description])).toEqual([
      ["python", "50% accepted of 10"],
      ["$(go-to-file) Open the completion log", "/w/.localpilot/completions.jsonl"],
    ]);
    expect(picks[0].items[0].detail).toBe("accepted 4 · partial 1 · typed through 1 · rejected 4 — learned: 4 lines, 48 tokens, 2 examples");
    expect(registry.executed.map((e) => e.command)).toEqual(["vscode.open"]);

    // Too few outcomes, or adaptive off: the limits are the defaults.
    for (const [learned, adaptive] of [
      [false, true],
      [true, false],
    ]) {
      stats.languages.python.learned = learned;
      stats.adaptive = adaptive;
      picks.length = 0;
      answerPicks(undefined);
      await showCompletionStats(deps);
      expect(picks[0].items[0].detail).toBe("accepted 4 · partial 1 · typed through 1 · rejected 4 — default: 4 lines, 48 tokens, 2 examples");
    }
  });
});
