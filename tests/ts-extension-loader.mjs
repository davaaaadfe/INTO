export async function resolve(specifier, context, nextResolve) {
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

    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
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
