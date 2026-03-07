import { type NextRequest } from "next/server";

const BACKEND = process.env.BACKEND_URL || "http://backend:8080";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ modelAction: string }> }
) {
  const { modelAction } = await params;
  const search = req.nextUrl.search ?? "";
  const url = `${BACKEND}/v1beta/models/${modelAction}${search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!["host", "connection"].includes(key)) headers.set(key, value);
  });

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: req.body,
    // @ts-ignore
    duplex: "half",
  });

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => resHeaders.set(key, value));
  resHeaders.set("X-Accel-Buffering", "no");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
