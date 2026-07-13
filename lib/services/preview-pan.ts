export type PreviewPan = {
  x: number;
  y: number;
};

export type PreviewPanBounds = {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
};

export function resetPreviewPan(): PreviewPan {
  return { x: 0, y: 0 };
}

export function movePreviewPan(
  current: PreviewPan,
  delta: PreviewPan
): PreviewPan {
  return {
    x: current.x + delta.x,
    y: current.y + delta.y,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampPreviewPan(
  pan: PreviewPan,
  bounds: PreviewPanBounds
): PreviewPan {
  const maxX = Math.max(0, (bounds.contentWidth - bounds.viewportWidth) / 2);
  const maxY = Math.max(0, (bounds.contentHeight - bounds.viewportHeight) / 2);

  return {
    x: clamp(pan.x, -maxX, maxX),
    y: clamp(pan.y, -maxY, maxY),
  };
}
