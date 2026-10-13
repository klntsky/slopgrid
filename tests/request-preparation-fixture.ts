import { readFileSync } from "node:fs";
import { Provider } from "../server/provider.js";

// Test-only request policy changes pass through the same preparation boundary
// for comparison and real SDK dispatch in both child processes.
if (process.env.FIXTURE_PREPARATION) {
  const prepare = Provider.prototype.prepare;
  Provider.prototype.prepare = async function (...args) {
    const result = await prepare.apply(this, args);
    const change = JSON.parse(
      readFileSync(process.env.FIXTURE_PREPARATION!, "utf8"),
    );
    const request = result;
    if (change.adapterVersion) request.adapterVersion = change.adapterVersion;
    if (request.format !== "image") {
      if (change.system) request.text.system = change.system;
      if (change.schema)
        request.text.schema = {
          ...request.text.schema!,
          description: change.schema,
        };
      if (change.routing)
        request.text.options.provider.max_price = {
          ...request.text.options.provider.max_price,
          prompt: change.routing,
        };
      if (change.reorder)
        request.text.options.provider = Object.fromEntries(
          Object.entries(request.text.options.provider).reverse(),
        ) as typeof request.text.options.provider;
    }
    return result;
  };
}
