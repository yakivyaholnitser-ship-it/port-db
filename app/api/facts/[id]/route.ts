import { NextRequest, NextResponse } from "next/server";
import { deleteFactGraph } from "@/lib/delete-entity-graph";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const factId = Number.parseInt(id, 10);

  if (Number.isNaN(factId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const deleted = await deleteFactGraph(factId);

    if (!deleted) {
      return NextResponse.json({ error: "Fact not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE FACT ERROR:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to delete fact",
      },
      { status: 500 }
    );
  }
}
