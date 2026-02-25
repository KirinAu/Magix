const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

export async function startSession(
  config: { provider: string; modelId: string; apiKey: string; baseUrl?: string },
  onEvent: (event: any) => void
): Promise<{ sessionId: string; close: () => void }> {
  const res = await fetch(`${BACKEND}/api/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });

  const sessionId = res.headers.get("X-Session-Id") ?? "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const close = () => {
    closed = true;
    reader.cancel();
  };

  (async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })();

  return { sessionId, close };
}

export async function sendMessage(
  sessionId: string,
  message: string,
  onEvent: (event: any) => void
): Promise<() => void> {
  const res = await fetch(`${BACKEND}/api/chat/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const close = () => {
    closed = true;
    reader.cancel();
  };

  (async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  })();

  return close;
}

export async function submitRender(params: {
  code: string;
  library: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
}): Promise<string> {
  const res = await fetch(`${BACKEND}/api/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const { jobId } = await res.json();
  return jobId;
}

export function watchRenderJob(
  jobId: string,
  onUpdate: (job: any) => void
): () => void {
  const es = new EventSource(`${BACKEND}/api/render/${jobId}`);
  es.onmessage = (e) => {
    try {
      onUpdate(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => es.close();
  return () => es.close();
}

export function getDownloadUrl(jobId: string): string {
  return `${BACKEND}/api/render/${jobId}/download`;
}
