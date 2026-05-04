"use client";

import "leaflet/dist/leaflet.css";
import { useMemo } from "react";
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
  id: number;
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
  selectedPortId,
  selectedPortStructure,
  onSelectPort,
  onSelectTerminal,
  onSelectBerth,
}: {
  entries: PortEntryForMap[];
  highlightedPorts: string[];
  selectedPortId: number | null;
  selectedPortStructure: { name: string; berths: string[] }[];
  onSelectPort: (portId: number) => void;
  onSelectTerminal: (terminalName: string) => void;
  onSelectBerth: (terminalName: string, berthName: string) => void;
}) {
  const highlighted = useMemo(
    () => new Set((highlightedPorts || []).map((p) => p.toLowerCase())),
    [highlightedPorts]
  );

  const groupMap = new Map<string, PortGroup>();

  for (const e of entries) {
    const key = `${e.id}:${e.port.toLowerCase()}:${(e.country ?? "").toLowerCase()}`;
    const portKey = e.port.toLowerCase();
    if (!groupMap.has(key)) {
      if (typeof e.lat === "number" && typeof e.lon === "number") {
        groupMap.set(key, {
          id: e.id,
          portKey,
          port: e.port,
          country: e.country,
          lat: e.lat,
          lon: e.lon,
          terminals: [],
        });
      } else {
        groupMap.set(key, {
          id: e.id,
          portKey,
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

    if (e.terminal || e.operation || e.maxDraftMeters || e.specialRestrictions) {
      groupMap.get(key)!.terminals.push({
        terminal: e.terminal,
        operation: e.operation,
        maxDraftMeters: e.maxDraftMeters,
        specialRestrictions: e.specialRestrictions,
      });
    }
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
          zoomAnimation={false}
          fadeAnimation={false}
          markerZoomAnimation={false}
          preferCanvas
        >
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {groups.map((g) => {
            const isHighlighted = highlighted.has(g.portKey);
            const isSelectedPort = selectedPortId === g.id;
            const isActive = isHighlighted || isSelectedPort;

            return (
              <CircleMarker
                key={g.id}
                center={[g.lat, g.lon]}
                eventHandlers={{
                  click: () => onSelectPort(g.id),
                }}
                radius={isActive ? 9 : 6}
                pathOptions={{
                  color: isActive ? "#10b981" : "#94a3b8",
                  fillColor: isActive ? "#10b981" : "#94a3b8",
                  fillOpacity: isActive ? 0.9 : 0.6,
                  weight: isActive ? 3 : 1,
                }}
              >
                <Popup>
                  <div style={{ fontSize: 12, maxWidth: 260 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        {g.port} {g.country ? `(${g.country})` : ""}
                      </div>
                      <button
                        type="button"
                        onClick={() => onSelectPort(g.id)}
                        style={{
                          border: "1px solid rgba(16,185,129,0.28)",
                          borderRadius: 999,
                          padding: "4px 8px",
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.12em",
                          color: "#0f172a",
                          background: "rgba(113,194,183,0.88)",
                          cursor: "pointer",
                        }}
                      >
                        Open
                      </button>
                    </div>
                    {isSelectedPort && selectedPortStructure.length > 0 ? (
                      <div style={{ marginBottom: 10 }}>
                        <div
                          style={{
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.16em",
                            color: "#64748b",
                            marginBottom: 6,
                          }}
                        >
                          Terminals
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 6,
                          }}
                        >
                          {selectedPortStructure.map((terminal) => (
                            <div key={terminal.name} style={{ width: "100%" }}>
                              <button
                                type="button"
                                onClick={() => onSelectTerminal(terminal.name)}
                                style={{
                                  border: "1px solid rgba(15,23,42,0.12)",
                                  borderRadius: 999,
                                  padding: "4px 8px",
                                  fontSize: 10,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.12em",
                                  color: "#0f172a",
                                  background: "rgba(226,232,240,0.92)",
                                  cursor: "pointer",
                                }}
                              >
                                {terminal.name}
                              </button>
                              {terminal.berths.length > 0 ? (
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 6,
                                    marginTop: 6,
                                    marginLeft: 8,
                                  }}
                                >
                                  {terminal.berths.map((berth) => (
                                    <button
                                      key={`${terminal.name}-${berth}`}
                                      type="button"
                                      onClick={() => onSelectBerth(terminal.name, berth)}
                                      style={{
                                        border: "1px solid rgba(148,163,184,0.28)",
                                        borderRadius: 999,
                                        padding: "3px 7px",
                                        fontSize: 10,
                                        letterSpacing: "0.08em",
                                        color: "#0f172a",
                                        background: "rgba(191,219,254,0.9)",
                                        cursor: "pointer",
                                      }}
                                    >
                                      {berth}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
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
                        {t.terminal ? <div style={{ fontWeight: 700 }}>{t.terminal}</div> : null}
                        {t.operation ? (
                          <div>
                            <b>Operation:</b> {t.operation}
                          </div>
                        ) : null}
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
        Green markers = selected port or ports highlighted by the AI Assistant response.
      </div>
    </section>
  );
}
