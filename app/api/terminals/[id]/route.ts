import { NextRequest, NextResponse } from "next/server";
import { deleteTerminalGraph } from "@/lib/delete-entity-graph";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const terminalId = Number.parseInt(id, 10);

  if (Number.isNaN(terminalId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const deleted = await deleteTerminalGraph(terminalId);

    if (!deleted) {
      return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE TERMINAL ERROR:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to delete terminal",
      },
      { status: 500 }
    );
  }
}
