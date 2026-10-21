// Mocha entry point that VS Code's extension test host calls (`run()`).
import { join } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 30000 });
  mocha.addFile(join(__dirname, "smoke.test.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} e2e test(s) failed`)) : resolve()));
  });
}
