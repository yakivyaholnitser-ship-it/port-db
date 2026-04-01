/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function geocodePortCoordinates(portName, country) {
  const queries = [
    [`Port of ${portName}`, country].filter(Boolean).join(", "),
    [`${portName} port`, country].filter(Boolean).join(", "),
    [portName, country].filter(Boolean).join(", "),
  ].filter(Boolean);

  for (const query of queries) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "port-db/1.0 (port intelligence geocoder)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) continue;
    const data = await response.json();
    const first = data[0];
    if (!first) continue;

    const lat = Number.parseFloat(first.lat);
    const lon = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    return { lat, lon };
  }

  return null;
}

async function main() {
  const refreshAll = process.argv.includes("--refresh-all");
  const ports = await prisma.port.findMany({
    where: refreshAll ? undefined : { OR: [{ lat: null }, { lon: null }] },
    orderBy: { name: "asc" },
  });

  let updated = 0;

  for (const port of ports) {
    const coords = await geocodePortCoordinates(port.name, port.country);
    if (!coords) {
      console.log(`skip ${port.name}`);
      continue;
    }

    await prisma.port.update({
      where: { id: port.id },
      data: {
        lat: coords.lat,
        lon: coords.lon,
      },
    });

    updated += 1;
    console.log(`updated ${port.name} -> ${coords.lat}, ${coords.lon}`);
  }

  console.log(JSON.stringify({ refreshAll, portsScanned: ports.length, updated }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
