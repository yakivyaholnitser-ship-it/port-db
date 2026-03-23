"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";

type PortEntryForMap = {
  id: number;
  port: string;
  country?: string | null;
  terminal: string;
  operation: string;
  lat?: number | null;
  lon?: number | null;
  maxDraftMeters?: string | null;
  specialRestrictions?: string | null;
};

type PortGroup = {
  portKey: string;
  port: string;
  country?: string | null;
  lat: number;
  lon: number;
  terminals: {
    terminal: string;
    operation: string;
    maxDraftMeters?: string | null;
    specialRestrictions?: string | null;
  }[];
};

export default function PortsMap({
  entries,
  highlightedPorts,
}: {
  entries: PortEntryForMap[];
  highlightedPorts: string[];
}) {
  const highlighted = new Set((highlightedPorts || []).map((p) => p.toLowerCase()));

  const groupMap = new Map<string, PortGroup>();

  for (const e of entries) {
    const key = e.port.toLowerCase();
    if (!groupMap.has(key)) {
      if (typeof e.lat === "number" && typeof e.lon === "number") {
        groupMap.set(key, {
          portKey: key,
          port: e.port,
          country: e.country,
          lat: e.lat,
          lon: e.lon,
          terminals: [],
        });
      } else {
        groupMap.set(key, {
          portKey: key,
          port: e.port,
          country: e.country,
          lat: NaN,
          lon: NaN,
          terminals: [],
        });
      }
    } else if (
      isNaN(groupMap.get(key)!.lat) &&
      typeof e.lat === "number" &&
      typeof e.lon === "number"
    ) {
      const g = groupMap.get(key)!;
      g.lat = e.lat;
      g.lon = e.lon;
    }

    groupMap.get(key)!.terminals.push({
      terminal: e.terminal,
      operation: e.operation,
      maxDraftMeters: e.maxDraftMeters,
      specialRestrictions: e.specialRestrictions,
    });
  }

  const groups = Array.from(groupMap.values()).filter(
    (g) => !isNaN(g.lat) && !isNaN(g.lon)
  );

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Global Restrictions Map</h2>
        <div className="text-xs text-slate-400">
          Showing {groups.length} ports with coordinates
        </div>
      </div>

      <div className="h-[520px] w-full overflow-hidden rounded-lg border border-slate-800">
        <MapContainer
          center={[20, 0]}
          zoom={2}
          style={{ height: "520px", width: "100%" }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {groups.map((g) => {
            const isHighlighted = highlighted.has(g.portKey);

            return (
              <CircleMarker
                key={g.portKey}
                center={[g.lat, g.lon]}
                radius={isHighlighted ? 9 : 6}
                pathOptions={{
                  color: isHighlighted ? "#10b981" : "#94a3b8",
                  fillColor: isHighlighted ? "#10b981" : "#94a3b8",
                  fillOpacity: isHighlighted ? 0.9 : 0.6,
                  weight: isHighlighted ? 3 : 1,
                }}
              >
                <Popup>
                  <div style={{ fontSize: 12, maxWidth: 260 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>
                      {g.port} {g.country ? `(${g.country})` : ""}
                    </div>
                    {g.terminals.map((t, i) => (
                      <div
                        key={i}
                        style={{
                          marginBottom: i < g.terminals.length - 1 ? 8 : 0,
                          paddingBottom: i < g.terminals.length - 1 ? 8 : 0,
                          borderBottom:
                            i < g.terminals.length - 1
                              ? "1px solid #e2e8f0"
                              : "none",
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{t.terminal}</div>
                        <div>
                          <b>Operation:</b> {t.operation}
                        </div>
                        {t.maxDraftMeters && (
                          <div>
                            <b>Max draft:</b> {t.maxDraftMeters}
                          </div>
                        )}
                        {t.specialRestrictions && (
                          <div style={{ marginTop: 4 }}>
                            <b>Restrictions:</b> {t.specialRestrictions}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      <div className="text-xs text-slate-400">
        Green markers = ports highlighted by the AI Assistant response.
      </div>
    </section>
  );
}
