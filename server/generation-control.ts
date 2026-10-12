import { generationClient } from "./generation-client.js";
import { runtimeConfig } from "./runtime-config.js";

const api = generationClient(runtimeConfig().socket);
const command = process.argv[2];
if (command === "status") console.log(JSON.stringify(await api.status()));
else if (command === "accept") console.log(JSON.stringify(await api.accept()));
else if (command === "drain") {
  await api.drain();
  for (;;) {
    const status = await api.status();
    console.log(JSON.stringify(status));
    if (!status.runningCalls && !status.activeGrids) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} else throw new Error("Use status, drain, or accept");
