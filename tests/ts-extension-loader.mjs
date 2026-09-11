import { readFile } from "node:fs/promises";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/navigation") {
    return nextResolve(`${specifier}.js`, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const canRetry =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith(".") || specifier.startsWith("/")) &&
      !/\.[cm]?[jt]sx?$/.test(specifier);

    if (!canRetry) {
      throw error;
    }

    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch (retryError) {
      if (retryError?.code !== "ERR_MODULE_NOT_FOUND") throw retryError;
      return nextResolve(`${specifier}.tsx`, context);
    }
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    const ts = await import("typescript");
    const source = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
        },
        fileName: new URL(url).pathname,
      }).outputText,
    };
  }
  const loaded = await nextLoad(url, context);
  if (url.endsWith(".test.ts") && loaded.source != null) {
    return {
      ...loaded,
      source: `import ${JSON.stringify(testAuthSetup)};\n${String(loaded.source)}`,
    };
  }
  return loaded;
}
const testAuthSetup = new URL("./test-auth-setup.ts", import.meta.url).href;
