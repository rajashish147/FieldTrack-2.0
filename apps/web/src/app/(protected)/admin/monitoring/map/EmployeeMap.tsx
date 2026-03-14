"use client";

/**
 * EmployeeMap — Leaflet map component.
 *
 * Imported dynamically with `ssr: false` from the parent page because Leaflet
 * accesses `window` at module initialisation time and will crash Next.js SSR.
 *
 * Marker colour scheme:
 *   ACTIVE  → green  (checked in within the last 2 hours)
 *   RECENT  → orange (checked out, still this calendar day)
 *   INACTIVE → grey  (no session activity today)
 */

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker as LeafletMarker } from "leaflet";
import type { EmployeeMapMarker } from "@/types";

// ─── Marker icon colours matching status ──────────────────────────────────────

const STATUS_COLOURS: Record<EmployeeMapMarker["status"], string> = {
  ACTIVE: "#22c55e",   // green-500
  RECENT: "#f97316",  // orange-500
  INACTIVE: "#94a3b8", // slate-400
};

function makeIcon(status: EmployeeMapMarker["status"]) {
  const colour = STATUS_COLOURS[status];
  // Inline SVG circle marker — avoids the default Leaflet PNG which requires
  // webpack file-loader config. Works in all build setups without extra config.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="${colour}" opacity="0.9"/>
      <circle cx="12" cy="12" r="5"  fill="#fff"      opacity="0.7"/>
    </svg>
  `.trim();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const L = require("leaflet") as typeof import("leaflet");
  return L.divIcon({
    html: svg,
    className: "",      // prevent Leaflet's default white-box class
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14],
  });
}

// ─── Popup HTML (pure string — Leaflet renders these) ─────────────────────────

function buildPopupHtml(m: EmployeeMapMarker): string {
  const ts = new Date(m.recordedAt).toLocaleString();
  const code = m.employeeCode ? ` (${m.employeeCode})` : "";
  const statusColour = m.status === "ACTIVE" ? "green" : m.status === "RECENT" ? "orange" : "grey";
  return `
    <div style="min-width:160px;font-family:sans-serif;font-size:13px">
      <strong style="font-size:14px">${m.employeeName}${code}</strong><br/>
      <span style="color:${statusColour};font-weight:600">${m.status}</span><br/>
      <span style="color:#555;font-size:11px">Last fix: ${ts}</span>
    </div>
  `.trim();
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  markers: EmployeeMapMarker[];
  isLoading: boolean;
}

export default function EmployeeMap({ markers, isLoading }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LeafletMarker[]>([]);

  // Initialise Leaflet map once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Require inside effect — this code only runs in browser
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet") as typeof import("leaflet");

    // Leaflet's default icon path breaks with webpack/Next.js — fix it
    // by telling it to use an empty icon. We override icons per-marker anyway.
    // @ts-expect-error _getIconUrl is an internal Leaflet method
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({ iconUrl: "", shadowUrl: "" });

    const map = L.map(mapContainerRef.current, {
      center: [20, 0],   // world view until we fit to markers
      zoom: 2,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update markers whenever data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const L = require("leaflet") as typeof import("leaflet");

    // Remove old markers
    for (const m of markerLayerRef.current) {
      m.remove();
    }
    markerLayerRef.current = [];

    if (markers.length === 0) return;

    const newMarkers: LeafletMarker[] = [];
    const latLngs: [number, number][] = [];

    for (const m of markers) {
      const icon = makeIcon(m.status);
      const marker = L.marker([m.latitude, m.longitude], { icon })
        .addTo(map)
        .bindPopup(buildPopupHtml(m));
      newMarkers.push(marker);
      latLngs.push([m.latitude, m.longitude]);
    }

    markerLayerRef.current = newMarkers;

    // Fit the map to show all markers (with a small padding)
    if (latLngs.length > 0) {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40], maxZoom: 14 });
    }
  }, [markers]);

  return (
    <div className="relative h-full w-full">
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <span className="text-sm text-muted-foreground">Loading positions…</span>
        </div>
      )}
      {/* The map mounts into this div */}
      <div ref={mapContainerRef} className="h-full w-full" />
    </div>
  );
}
