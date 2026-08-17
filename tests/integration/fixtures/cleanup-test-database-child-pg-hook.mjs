import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "pg") {
      return {
        shortCircuit: true,
        url: new URL("./cleanup-test-database-child-pg-mock.mjs", import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
});
