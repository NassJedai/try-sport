# ADR-002 — Map provider

**Status:** accepted · **Date:** 2026-08-14

## Context

The map is a primary discovery surface, not a detail-page decoration. It needs
smooth pan/zoom with price pins, clustering, "search this area", and a look that
matches a premium consumer app.

## Options

**Google Maps.** Ubiquitous, excellent data quality in Belgium, familiar to
users. Styling is constrained, and RN clustering performance with many custom
price markers is mediocre.

**Mapbox.** Vector tiles, native clustering, full control of typography and
colour so the map reads as part of TRY rather than a third-party embed.
Generous free tier at our volume.

## Decision

**Mapbox** for the consumer map, behind a `MapProvider` abstraction.

## Consequences

- Custom styling means the map carries TRY's design language.
- The abstraction keeps Google Maps reachable if a market needs its data quality
  or if pricing changes.
- Geocoding is a separate concern and is not bound to this decision.
