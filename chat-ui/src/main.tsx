import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createHostBridge } from "./host";
import type { HostToUi } from "./host";

const bridge = createHostBridge();

function App() {
  const [last, setLast] = useState<HostToUi | null>(null);
  useEffect(() => {
    const off = bridge.onMessage(setLast);
    bridge.post({ type: "ui/ready" });
    return off;
  }, []);
  return (
    <main>
      <h1>LocalPilot</h1>
      <p>{last ? `Last host message: ${last.type}` : "Waiting for host…"}</p>
    </main>
  );
}

render(<App />, document.getElementById("app")!);
