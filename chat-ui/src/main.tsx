import { render } from "preact";
import { App } from "./components/App";
import { createHostBridge } from "./host";
import "./styles.css";

render(<App bridge={createHostBridge()} />, document.getElementById("app")!);
