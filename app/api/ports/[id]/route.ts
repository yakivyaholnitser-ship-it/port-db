import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deletePortGraph } from "@/lib/delete-entity-graph";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const portId = Number.parseInt(id, 10);

  if (Number.isNaN(portId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const existingPort = await prisma.port.findUnique({ where: { id: portId }, select: { id: true } });

    if (!existingPort) {
      return NextResponse.json({ error: "Port not found" }, { status: 404 });
    }

    await deletePortGraph(portId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE PORT ERROR:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to delete port",
      },
      { status: 500 }
    );
  }
}
