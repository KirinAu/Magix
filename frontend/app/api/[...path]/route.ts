import { type NextRequest } from "next/server";

const BACKEND = process.env.BACKEND_URL || "http://backend:8080";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

async function proxy(req: NextRequest, params: { path: string[] }) {
  const path = params.path.join("/");
  const search = req.nextUrl.search ?? "";
  const url = `${BACKEND}/api/${path}${search}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!["host", "connection"].includes(k)) headers.set(k, v);
  });

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
    // @ts-ignore
    duplex: "half",
  });

  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => resHeaders.set(k, v));
  // 确保 SSE 不被缓冲
  resHeaders.set("X-Accel-Buffering", "no");
  resHeaders.set("Cache-Control", "no-cache");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
