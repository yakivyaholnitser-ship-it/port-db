import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const entries = await prisma.portEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    return NextResponse.json({ entries }, { status: 200 });
  } catch (e) {
    console.error("PORTS API ERROR:", e);
    return NextResponse.json({ error: "Failed to load ports." }, { status: 500 });
  }
}