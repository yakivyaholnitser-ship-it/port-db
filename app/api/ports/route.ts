import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const entries = await prisma.portEntry.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      port: true,
      terminal: true,
      operation: true,
      cargo: true,
      waterDensity: true,
      maxDraftMeters: true,
      maxDraftNotes: true,
      loadRatePerDayMt: true,
      dischargeRatePerDayMt: true,
      specialRestrictions: true,
    },
  });

  return NextResponse.json({ entries });
}
