import { type NextRequest } from "next/server";

const BACKEND = process.env.BACKEND_URL || "http://backend:8080";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

export async function HEAD(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await params);
}

async function proxy(req: NextRequest, params: { path: string[] }) {
  const path = params.path.join("/");
  const search = req.nextUrl.search ?? "";
  const url = `${BACKEND}/outputs/${path}${search}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!["host", "connection"].includes(k)) headers.set(k, v);
  });

  const upstream = await fetch(url, {
    method: req.method,
    headers,
  });

  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => resHeaders.set(k, v));
  resHeaders.set("Cache-Control", "no-cache");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
