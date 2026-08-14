import { useMemo } from 'react';
import Svg, { Rect } from 'react-native-svg';
import { encodeQr } from '@/lib/qr';

interface QrCodeProps {
  value: string;
  size?: number;
  /** Quiet zone in modules; the spec requires 4 for reliable scanning. */
  margin?: number;
}

/**
 * QR renderer.
 *
 * Drawn as SVG rects rather than pulled from a QR image service: the payload is a
 * signed check-in credential and must never leave the device to be rendered by a
 * third party.
 */
export function QrCode({ value, size = 240, margin = 4 }: QrCodeProps) {
  const matrix = useMemo(() => encodeQr(value), [value]);

  const moduleCount = matrix.length + margin * 2;
  const moduleSize = size / moduleCount;

  return (
    <Svg width={size} height={size} accessibilityLabel="QR code de réservation">
      <Rect x={0} y={0} width={size} height={size} fill="#FFFFFF" />
      {matrix.map((row, y) =>
        row.map((filled, x) =>
          filled ? (
            <Rect
              key={`${x}-${y}`}
              x={(x + margin) * moduleSize}
              y={(y + margin) * moduleSize}
              // Slight overdraw closes hairline seams between adjacent modules
              // that some scanners read as gaps.
              width={moduleSize + 0.5}
              height={moduleSize + 0.5}
              fill="#000000"
            />
          ) : null,
        ),
      )}
    </Svg>
  );
}
