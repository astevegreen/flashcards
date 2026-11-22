import { useEffect, useState } from 'react';
import { qrMatrixToPath } from './qrPath.ts';

/**
 * A QR code for `text`, drawn as React SVG elements. The encoder (`uqr`, MIT) is imported only
 * when a code is first shown, so it never reaches the initial study bundle (§8). The box keeps
 * its size while the encoder loads, and the code is always dark on white (with the standard
 * four-module quiet zone) so phone cameras read it in dark mode too.
 */
export function QrCodeSvg({
  text,
  label,
  size = 176,
}: Readonly<{ text: string; label: string; size?: number }>) {
  const [drawn, setDrawn] = useState<{ text: string; modules: number; path: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    let live = true;
    import('uqr')
      .then(({ encode }) => {
        const qr = encode(text, { ecc: 'M', border: 4 });
        if (live) setDrawn({ text, modules: qr.size, path: qrMatrixToPath(qr.data) });
      })
      .catch(() => {
        // The link below the code still works without it.
      });
    return () => {
      live = false;
    };
  }, [text]);

  const current = drawn?.text === text ? drawn : undefined;
  return (
    <div
      data-testid="add-device-qr"
      className="shrink-0 overflow-hidden rounded-lg bg-white"
      style={{ width: size, height: size }}
    >
      {current && (
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${current.modules} ${current.modules}`}
          width={size}
          height={size}
          shapeRendering="crispEdges"
        >
          <rect width={current.modules} height={current.modules} fill="#ffffff" />
          <path d={current.path} fill="#000000" />
        </svg>
      )}
    </div>
  );
}

export default QrCodeSvg;
