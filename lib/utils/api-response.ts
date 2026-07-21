export async function readApiJson<
  T = Awaited<ReturnType<Response["json"]>>,
>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    if (!response.ok) return {} as T;
    throw new Error("INTO received an empty response from the server.");
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    if (!response.ok) return {} as T;
    throw new Error("INTO received an invalid response from the server.");
  }
}
