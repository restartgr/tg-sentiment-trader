export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`接口没有返回 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return data as T;
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
