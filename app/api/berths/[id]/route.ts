import { NextRequest, NextResponse } from "next/server";
import { deleteBerthGraph } from "@/lib/delete-entity-graph";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const berthId = Number.parseInt(id, 10);

  if (Number.isNaN(berthId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const deleted = await deleteBerthGraph(berthId);

    if (!deleted) {
      return NextResponse.json({ error: "Berth not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE BERTH ERROR:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to delete berth",
      },
      { status: 500 }
    );
  }
}
