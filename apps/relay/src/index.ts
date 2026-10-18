import { readConfig } from "./config";
import { createRelay } from "./server";

const config = readConfig(process.env);
const relay = createRelay(config);
relay.server.listen(config.port, config.host, () => console.log(`NESLink relay ${config.nodeId} listening on ${config.host}:${config.port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void relay.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
});
