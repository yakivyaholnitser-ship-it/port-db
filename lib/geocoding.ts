type GeocodedCoordinates = {
  lat: number;
  lon: number;
  country?: string | null;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  address?: {
    country?: string;
  };
};

function toNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function geocodePortCoordinates(args: {
  portName: string;
  country?: string | null;
  contextText?: string | null;
}) {
  const stateLikeHints = Array.from(
    new Set(
      [
        ...(args.contextText?.match(
          new RegExp(`${args.portName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,\\s*([A-Z]{2})`, "gi")
        ) ?? []),
        ...(args.contextText?.match(/\b(?:California|Oregon|Washington|British Columbia|BC|WA|OR|CA)\b/gi) ?? []),
      ]
        .map((value) => {
          const match = value.match(/([A-Z]{2}|California|Oregon|Washington|British Columbia)/i);
          return match?.[1] ?? null;
        })
        .filter((value): value is string => Boolean(value))
    )
  );

  const queries = [
    ...stateLikeHints.flatMap((hint) => [
      [`Port of ${args.portName}`, hint, args.country].filter(Boolean).join(", "),
      [`${args.portName} port`, hint, args.country].filter(Boolean).join(", "),
      [args.portName, hint, args.country].filter(Boolean).join(", "),
    ]),
    [`Port of ${args.portName}`, args.country].filter(Boolean).join(", "),
    [`${args.portName} port`, args.country].filter(Boolean).join(", "),
    [args.portName, args.country].filter(Boolean).join(", "),
  ].filter(Boolean);

  for (const query of queries) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "port-db/1.0 (port intelligence geocoder)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    if (!response.ok) continue;

    const data = (await response.json()) as NominatimResult[];
    const first = data[0];
    if (!first) continue;

    const lat = toNumber(first.lat);
    const lon = toNumber(first.lon);
    if (lat == null || lon == null) continue;

    return { lat, lon, country: first.address?.country ?? null } satisfies GeocodedCoordinates;
  }

  return null;
}
