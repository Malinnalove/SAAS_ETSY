import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ListingWorkbenchError } from "@/features/products/listing-workbench-db";

export async function jsonBody(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 2_000_000) throw new ListingWorkbenchError("Request body is too large.", 413);
  try {
    return await request.json() as unknown;
  } catch {
    throw new ListingWorkbenchError("Invalid JSON body.", 400);
  }
}

export function workbenchErrorResponse(error: unknown) {
  if (error instanceof ListingWorkbenchError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid Listing data.", fields: error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  console.error("Listing Workbench request failed:", error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Listing Workbench request failed." },
    { status: 500 },
  );
}
