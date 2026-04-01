"use client";

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";

export default function SinglePortMap({
  lat,
  lon,
  name,
}: {
  lat: number;
  lon: number;
  name: string;
}) {
  return (
    <MapContainer
      center={[lat, lon]}
      zoom={8}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom={false}
      zoomAnimation={false}
      fadeAnimation={false}
      markerZoomAnimation={false}
      preferCanvas
    >
      <TileLayer
        attribution='&copy; OpenStreetMap contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <CircleMarker
        center={[lat, lon]}
        radius={7}
        pathOptions={{
          color: "#10b981",
          fillColor: "#10b981",
          fillOpacity: 0.9,
          weight: 2,
        }}
      >
        <Popup>{name}</Popup>
      </CircleMarker>
    </MapContainer>
  );
}
